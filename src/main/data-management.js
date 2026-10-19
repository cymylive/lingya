/**
 * 数据目录管理（主进程）
 *
 * 三个能力：
 *   - getInfo()       读取当前数据目录 / 自定义配置 / 体积统计
 *   - setCustomDir()  指定自定义数据目录（需重启生效）
 *   - exportData()    打包当前数据目录为 zip（排除缓存与临时实例）
 *   - importData()    从 zip 导入到当前数据目录（合并，同名覆盖）
 */
const path = require('path');
const fs = require('fs');
const { dialog } = require('electron');

// 导出时排除的目录/文件（缓存、临时实例、锁文件）
const EXCLUDE_PATTERNS = [
  /(^|[\\/])Cache([\\/]|$)/,
  /(^|[\\/])GPUCache([\\/]|$)/,
  /(^|[\\/])Code Cache([\\/]|$)/,
  /(^|[\\/])DawnCache([\\/]|$)/,
  /(^|[\\/])DawnGraphiteCache([\\/]|$)/,
  /(^|[\\/])DawnWebGPUCache([\\/]|$)/,
  /(^|[\\/])Shared Dictionary([\\/]|$)/,
  /(^|[\\/])ShaderCache([\\/]|$)/,
  /(^|[\\/])blob_storage([\\/]|$)/,
  /(^|[\\/])Crashpad([\\/]|$)/,
  /(^|[\\/])logs([\\/]|$)/,
  /(^|[\\/])instances[\\/]auto-\d+([\\/]|$)/,
  /(^|[\\/])Singleton/,
  /(^|[\\/])\.lingya-ready$/,
];

function shouldExclude(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return EXCLUDE_PATTERNS.some((re) => re.test(p));
}

/** 统计目录体积与文件数 */
function measureDir(dir, fsArg, limit) {
  let bytes = 0;
  let files = 0;
  const maxFiles = limit || 200000;
  function walk(d) {
    let entries;
    try { entries = fsArg.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (files > maxFiles) return;
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (shouldExclude(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { bytes += fsArg.statSync(full).size; files++; } catch (_) {}
      }
    }
  }
  walk(dir);
  return { bytes, files };
}

/** 格式化为人类可读大小 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function register({ ipcMain, dataDir, appDataPath, sessionDir, fs: fsArg }) {
  const f = fsArg || fs;
  const dataDirMod = require('./data-dir');

  // ---------- 查询状态 ----------
  ipcMain.handle('data-mgmt-info', async () => {
    try {
      const custom = dataDirMod.readCustomDataDir(appDataPath, sessionDir, f);
      const stat = measureDir(dataDir, f);
      return {
        success: true,
        currentDir: dataDir,
        customDir: custom || '',
        isCustom: !!custom,
        size: stat.bytes,
        sizeText: formatSize(stat.bytes),
        files: stat.files,
        appDataPath,
        sessionDir,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---------- 指定自定义目录 ----------
  ipcMain.handle('data-mgmt-choose-dir', async (event) => {
    try {
      const win = require('electron').BrowserWindow.fromWebContents(event.sender);
      const r = await dialog.showOpenDialog(win, {
        title: '选择数据存放位置',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return { success: false, canceled: true };
      return { success: true, dir: r.filePaths[0] };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('data-mgmt-set-dir', async (_event, { dir } = {}) => {
    try {
      const target = String(dir || '').trim();
      if (!target) {
        // 清空 = 恢复默认
        dataDirMod.writeCustomDataDir(appDataPath, sessionDir, null, f);
        return { success: true, cleared: true, needRestart: true };
      }
      const abs = path.resolve(target);
      if (abs === path.resolve(dataDir)) {
        return { success: false, error: '新目录与当前目录相同，无需切换' };
      }
      f.mkdirSync(abs, { recursive: true });
      // 可写性检查
      const probe = path.join(abs, '.lingya-write-test');
      f.writeFileSync(probe, 'ok', 'utf8');
      f.unlinkSync(probe);
      dataDirMod.writeCustomDataDir(appDataPath, sessionDir, abs, f);
      return { success: true, dir: abs, needRestart: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---------- 导出 ----------
  ipcMain.handle('data-mgmt-export', async (event) => {
    try {
      const win = require('electron').BrowserWindow.fromWebContents(event.sender);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const r = await dialog.showSaveDialog(win, {
        title: '导出数据',
        defaultPath: 'lingya-data-' + stamp + '.zip',
        filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };

      // archiver v8 改为导出类（new ZipArchive(opts)），v7 及更早是工厂函数 archiver('zip', opts)。
      // 这里做双版本兼容，避免依赖升级后导出功能失效。
      const archiverMod = require('archiver');
      let archive;
      if (typeof archiverMod === 'function') {
        archive = archiverMod('zip', { zlib: { level: 6 } });
      } else if (archiverMod && typeof archiverMod.ZipArchive === 'function') {
        archive = new archiverMod.ZipArchive({ zlib: { level: 6 } });
      } else {
        throw new Error('不支持的 archiver 版本：既不是工厂函数也没有 ZipArchive 导出');
      }
      const out = f.createWriteStream(r.filePath);

      const done = new Promise((resolve, reject) => {
        out.on('close', () => resolve({ bytes: archive.pointer() }));
        out.on('error', reject);
        // warning 通常是单文件读取失败（文件被占用等），记录但不中止整个导出
        archive.on('warning', (err) => {
          if (err && err.code && err.code !== 'ENOENT') {
            console.warn('[LingYa][导出] warning:', err.message);
          }
        });
        archive.on('error', reject);
      });

      archive.pipe(out);
      let fileCount = 0;
      const failed = [];
      // 逐个文件加入，跳过排除项
      // 注意：zip 内路径必须用 / 分隔，否则跨平台解压会出错
      function walk(dir, base) {
        let entries;
        try { entries = f.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const relPosix = base ? base + '/' + e.name : e.name;
          if (shouldExclude(relPosix)) continue;
          if (e.isDirectory()) { walk(full, relPosix); continue; }
          if (!e.isFile()) continue;
          try {
            // 关键：必须当场读出内容再 append。
            // archive.file() 只是记录路径，真正读文件发生在 finalize() 之后的异步阶段，
            // 那时 LevelDB / Chromium 的文件正被占用，会抛 EBUSY 导致整个导出失败。
            // 改成 readFileSync 当场读取，被锁的文件立即失败并跳过，不影响其他文件。
            const buf = f.readFileSync(full);
            archive.append(buf, { name: relPosix });
            fileCount++;
          } catch (err) {
            failed.push(relPosix + ' -> ' + err.message);
          }
        }
      }
      walk(dataDir, '');
      await archive.finalize();
      const res = await done;
      console.log('[LingYa][导出] 写入 ' + fileCount + ' 个文件' +
        (failed.length ? '，跳过 ' + failed.length + ' 个被占用文件' : '') +
        '，大小 ' + formatSize(res.bytes));
      if (failed.length) {
        console.log('[LingYa][导出] 跳过明细（前 5 条）:');
        failed.slice(0, 5).forEach((x) => console.log('  - ' + x));
      }
      return {
        success: true,
        path: r.filePath,
        bytes: res.bytes,
        sizeText: formatSize(res.bytes),
        files: fileCount,
        skipped: failed.length,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---------- 导入 ----------
  ipcMain.handle('data-mgmt-import', async (event) => {
    try {
      const win = require('electron').BrowserWindow.fromWebContents(event.sender);
      const r = await dialog.showOpenDialog(win, {
        title: '导入数据（合并，同名覆盖）',
        properties: ['openFile'],
        filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePaths.length) return { success: false, canceled: true };

      const AdmZip = require('adm-zip');
      const zip = new AdmZip(r.filePaths[0]);
      const entries = zip.getEntries();
      let written = 0;
      const skipped = [];
      const failed = [];
      // LevelDB / Chromium 运行时会锁住的临时文件，重启后自动重建，跳过
      const LOCK_PATTERNS = [
        /(^|\/)LOCK$/,
        /(^|\/)LOG$/,
        /(^|\/)LOG\.old$/,
        /(^|\/)CURRENT$/,
        /(^|\/)Singleton[A-Za-z]*$/,
        /(^|\/)lockfile$/,
      ];
      f.mkdirSync(dataDir, { recursive: true });
      const root = path.resolve(dataDir);
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const rel = entry.entryName.replace(/\\/g, '/');
        if (!rel || rel.includes('..')) { skipped.push(rel + ' (path traversal)'); continue; }
        if (LOCK_PATTERNS.some((re) => re.test(rel))) { skipped.push(rel + ' (lock)'); continue; }
        const dest = path.join(dataDir, rel);
        if (!dest.startsWith(root)) { skipped.push(rel + ' (out of root)'); continue; }
        try {
          f.mkdirSync(path.dirname(dest), { recursive: true });
          f.writeFileSync(dest, entry.getData());
          written++;
        } catch (err) {
          failed.push(rel + ' -> ' + err.message);
        }
      }
      const msg = [];
      if (written) msg.push('已导入 ' + written + ' 个文件');
      if (skipped.length) msg.push('跳过 ' + skipped.length + ' 个（锁文件/非法路径）');
      if (failed.length) msg.push('失败 ' + failed.length + ' 个');
      console.log('[LingYa][导入] ' + msg.join('，') + '；目录=' + dataDir);
      if (failed.length) {
        console.log('[LingYa][导入] 失败明细（前 5 条）:');
        failed.slice(0, 5).forEach((x) => console.log('  - ' + x));
      }
      return {
        success: true,
        files: written,
        skipped: skipped.length,
        failed: failed.length,
        failedSample: failed.slice(0, 5),
        needRestart: true,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { register, shouldExclude, measureDir, formatSize };
