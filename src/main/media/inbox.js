/**
 * 媒体收件箱：接收文件的落盘、命名、清理
 *
 * 目录约定：<userData>/media-inbox/<channel>/<YYYYMMDD>/<安全文件名>
 *
 * 安全设计（重要）：
 *   - 文件名必须清洗，防路径穿越（../../etc/passwd）
 *   - 保留原扩展名（AI 据此判断类型），但主干名归一化
 *   - 同名文件自动加序号，不覆盖
 *   - 落盘目录固定，不接受调用方指定任意路径
 *
 * 清理策略：保留 7 天，启动时与每日定时各扫一次。
 */
const fs = require('fs');
const path = require('path');

/** 保留天数 */
const RETENTION_DAYS = 7;
/**
 * 单文件上限（字节）。
 *
 * 100MB 与 CowAgent（chatgpt-on-wechat）的 MAX_FILE_BYTES 对齐。
 * 这是「接收侧」的保护性上限——飞书最大只能发 30MB、微信文档未明确，
 * 放宽到 100MB 是为将来留余量，不是鼓励发超大文件。
 *
 * 超过此值直接拒绝，避免磁盘被塞满。
 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

let USER_DATA_DIR = null;
let ROOT_DIR = null;

/**
 * 初始化。ROOT_DIR 只是「当前生效目录」的缓存，
 * 真正的值由 mediaConfig.getEffectiveDir() 决定（用户可配）。
 */
function init(userDataDir) {
  USER_DATA_DIR = userDataDir;
  refreshRootDir();
  // 启动时清理一次
  try { cleanupExpired(); } catch (_) {}
}

/**
 * 重新解析根目录（用户改了配置后调用）。
 * @returns {string} 生效的根目录
 */
function refreshRootDir() {
  let dir = null;
  try {
    const mediaConfig = require('./config');
    dir = mediaConfig.getEffectiveDir();
  } catch (_) {
    // config 模块不可用时回退默认
    dir = USER_DATA_DIR ? path.join(USER_DATA_DIR, 'media-inbox') : null;
  }
  ROOT_DIR = dir;
  if (ROOT_DIR) {
    try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch (_) {}
    console.log('[Media] 收件箱目录:', ROOT_DIR);
  }
  return ROOT_DIR;
}

function getRootDir() {
  return ROOT_DIR;
}

/**
 * Windows 保留设备名。这些名字（无论带不带扩展名）在 Windows 上是设备引用，
 * 直接 writeFileSync 会挂起或写入设备而非文件。
 * 参考 plugin-host.js 的同类防护。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 去掉路径分隔符与控制字符，防穿越、防设备名 */
function sanitizeFileName(name) {
  let base = String(name || 'file');
  // 只取最后一段（Windows / POSIX 分隔符都处理）
  base = base.split(/[\\/]/).pop() || 'file';
  // 去控制字符与非法字符（Windows 保留字符集）
  base = base.replace(/[\x00-\x1f<>:"|?*]/g, '_');
  // 去掉前后点与空格（Windows 不允许结尾为点或空格）
  base = base.replace(/^[. ]+|[. ]+$/g, '');
  if (!base) base = 'file';
  // 长度保护（保留扩展名）
  const ext = path.extname(base);
  let stem = path.basename(base, ext);
  const maxStem = Math.max(1, 80 - ext.length);
  stem = stem.slice(0, maxStem) || 'file';
  // Windows 设备名：加下划线前缀，CON → _CON
  if (WINDOWS_RESERVED.test(stem)) stem = '_' + stem;
  return stem + ext.slice(0, 16);
}

/** 今天日期串 YYYYMMDD */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/** 确保目录存在并返回某通道当天的收件目录 */
function ensureChannelDir(channel) {
  if (!ROOT_DIR) refreshRootDir();
  if (!ROOT_DIR) throw new Error('媒体收件箱未初始化（需先调用 init）');
  const safeChannel = String(channel || 'unknown').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const dir = path.join(ROOT_DIR, safeChannel, todayStr());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 同名文件不覆盖，追加 (1)(2)… */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, stem + '(' + i + ')' + ext);
    i++;
    if (i > 999) throw new Error('同名文件过多');
  }
  return candidate;
}

/**
 * 保存一个接收到的文件。
 *
 * @param {string} channel 通道名：feishu / weixin / qq
 * @param {Buffer|Uint8Array} buffer 文件内容
 * @param {string} fileName 原始文件名（可能含路径，会被清洗）
 * @param {{maxBytes?: number}} [options]
 * @returns {{success: boolean, path?: string, size?: number, error?: string}}
 */
function save(channel, buffer, fileName, options) {
  try {
    if (!buffer || !buffer.length) return { success: false, error: '文件内容为空' };
    const limit = (options && options.maxBytes) || MAX_FILE_BYTES;
    if (buffer.length > limit) {
      return {
        success: false,
        error: '文件过大（' + (buffer.length / 1048576).toFixed(1) + 'MB，上限 ' + (limit / 1048576).toFixed(0) + 'MB）',
      };
    }
    const dir = ensureChannelDir(channel);
    const safeName = sanitizeFileName(fileName);
    const finalPath = uniquePath(dir, safeName);
    fs.writeFileSync(finalPath, buffer);
    console.log('[Media] 已保存接收文件:', finalPath, '(' + buffer.length + ' 字节)');
    return { success: true, path: finalPath, size: buffer.length };
  } catch (err) {
    console.error('[Media] 保存接收文件失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 清理超过保留期的文件（按天目录整体删除）。
 * @returns {{removedDirs: number}}
 */
function cleanupExpired() {
  if (!ROOT_DIR || !fs.existsSync(ROOT_DIR)) return { removedDirs: 0 };
  let removedDirs = 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let channels = [];
  try { channels = fs.readdirSync(ROOT_DIR, { withFileTypes: true }); } catch (_) { return { removedDirs: 0 }; }
  for (const ch of channels) {
    if (!ch.isDirectory()) continue;
    const chDir = path.join(ROOT_DIR, ch.name);
    let days = [];
    try { days = fs.readdirSync(chDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of days) {
      if (!d.isDirectory()) continue;
      // 目录名是 YYYYMMDD
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d.name);
      if (!m) continue;
      const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (ts >= cutoff) continue;
      const full = path.join(chDir, d.name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removedDirs++;
        console.log('[Media] 已清理过期目录:', full);
      } catch (_) {}
    }
  }
  return { removedDirs };
}

module.exports = {
  init,
  refreshRootDir,
  save,
  cleanupExpired,
  getRootDir,
  sanitizeFileName,
  MAX_FILE_BYTES,
  RETENTION_DAYS,
};
