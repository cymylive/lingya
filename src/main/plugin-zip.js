/**
 * 最小 ZIP 读写（零依赖）—— 仅用于插件导入/导出
 *
 * 为什么自己写：
 *   - 项目运行时依赖里没有 zip 库（archiver/jszip 都没有）
 *   - 不想为一个次要功能新增依赖、增加打包体积和安装失败风险
 *   - 只需支持最常见的 store(0) 与 deflate(8)，Node 自带 zlib 足够
 *
 * 限制：
 *   - 写入统一用 store（不压缩），兼容性最好、实现最简单
 *   - 读取支持 store(0) + deflate(8)；其他压缩方式抛错
 *   - 不支持加密、多分卷、ZIP64（插件包远小于 4GB）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============ CRC32 ============
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

/** 递归收集文件（rel 用 / 分隔） */
function collectFiles(dir, base, out) {
  base = base || dir;
  out = out || [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(full, base, out);
    else if (ent.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

/**
 * 把一个目录打包成 ZIP Buffer
 * @param {string} srcDir 源目录
 * @param {string} [prefix] 包内顶层目录名（不含 /）；为空则直接打包内容
 * @returns {Buffer}
 */
function zipDir(srcDir, prefix) {
  const files = collectFiles(srcDir);
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  const pre = prefix ? String(prefix).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' : '';

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const nameBuf = Buffer.from(pre + f.rel, 'utf-8');
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 文件名
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);        // extra len

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra
    cd.writeUInt16LE(0, 32);           // comment
    cd.writeUInt16LE(0, 34);           // disk number
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(chunks.concat([cdBuf, eocd]));
}

/**
 * 解压 ZIP Buffer 到目标目录
 * @param {Buffer} buf
 * @param {string} destDir
 * @returns {string[]} 写出的相对路径列表
 */
function unzipToDir(buf, destDir) {
  // 从尾部向前找 EOCD（0x06054b50），最多回退 65535 + 22 字节（注释长度上限）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  const written = [];
  const destRoot = path.resolve(destDir);

  for (let i = 0; i < count; i++) {
    if (cdOff + 46 > buf.length || buf.readUInt32LE(cdOff) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.slice(cdOff + 46, cdOff + 46 + nameLen).toString('utf-8');

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP 本地头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = comp;
    else if (method === 8) content = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方式: ' + method);

    // 规范化 + 防路径穿越（丢弃 .. / . / 空段）
    const parts = name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..');
    cdOff += 46 + nameLen + extraLen + commentLen;
    if (parts.length === 0) continue; // 目录条目，跳过

    const rel = parts.join('/');
    const outPath = path.join(destRoot, rel);
    const resolved = path.resolve(outPath);
    if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
      throw new Error('ZIP 包含非法路径: ' + name);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    written.push(rel);
  }
  return written;
}

module.exports = { zipDir, unzipToDir, crc32 };
