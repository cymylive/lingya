/**
 * 数据目录解析（便携优先）
 *
 * 目标：便携版的数据（记忆/技能/安全/Agent/MCP/profile/会话等）与程序同目录，
 * 换电脑或整体搬目录时配置不丢。
 *
 * 优先级：
 *   1. LINGYA_USER_DATA_DIR 环境变量（显式覆盖）
 *   2. 便携模式：
 *      - electron-builder 便携版注入的 PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR
 *      - 手动便携：exe 同目录存在 portable.txt / LingYa-Portable.txt 标记
 *      → 数据写入 <exe目录>/LingYa-Data
 *   3. 默认（安装版）：<appData>/<sessionDir>（保持原行为）
 *
 * 首次便携运行且便携目录为空、旧目录有数据时，自动迁移一次（可用 LINGYA_NO_MIGRATE 禁用）。
 *
 * 纯函数 + 依赖注入（fs/env/execPath 全部传入），便于单测。
 */
const path = require('path');

const PORTABLE_DATA_DIRNAME = 'LingYa-Data';
const PORTABLE_MARKERS = ['portable.txt', 'LingYa-Portable.txt'];
// 自定义数据目录配置文件（固定放在 appData/<sessionDir>/ 下，永不随数据目录变化）
const LOCATION_CONFIG_FILENAME = 'data-location.json';

/**
 * 读取自定义数据目录配置。
 * 配置文件固定放在 appData/<sessionDir>/data-location.json，
 * 即使数据目录已经切走，下次启动仍能从这个固定位置找到配置。
 * @param {string} appDataPath
 * @param {string} sessionDir
 * @param {object} fs
 * @returns {string|null} 绝对路径，无配置或读取失败返回 null
 */
function readCustomDataDir(appDataPath, sessionDir, fs) {
  try {
    const p = path.join(appDataPath, sessionDir, LOCATION_CONFIG_FILENAME);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const dir = (obj && typeof obj.customDataDir === 'string') ? obj.customDataDir.trim() : '';
    if (!dir) return null;
    return path.resolve(dir);
  } catch (_) {
    return null;
  }
}

/**
 * 读取安装向导写入的数据目录。
 * 安装时 NSIS 会把用户选择的数据目录写入 <安装目录>\data-location.txt，
 * 优先级低于运行时的 data-location.json（侧边栏设置），高于便携判定与默认路径。
 * @param {string} execPath process.execPath
 * @param {object} fs
 * @returns {string|null}
 */
function readInstallerDataDir(execPath, fs) {
  try {
    const exeDir = path.dirname(execPath);
    const p = path.join(exeDir, 'data-location.txt');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return null;
    return path.resolve(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 检查目录是否可写（创建临时文件再删除）。
 * @param {string} dir
 * @param {object} fs
 * @returns {boolean}
 */
function isDirWritable(dir, fs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.lingya-write-probe-' + Date.now());
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 写入自定义数据目录配置。
 * @param {string} appDataPath
 * @param {string} sessionDir
 * @param {string|null} customDir null 表示清除（恢复默认）
 * @param {object} fs
 */
function writeCustomDataDir(appDataPath, sessionDir, customDir, fs) {
  const dir = path.join(appDataPath, sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, LOCATION_CONFIG_FILENAME);
  if (!customDir) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  fs.writeFileSync(p, JSON.stringify({ customDataDir: String(customDir).trim() }, null, 2) + '\n', 'utf8');
}

/** 解析便携数据目录；非便携返回 null */
function resolvePortableDataDir(execPath, env, fs) {
  // electron-builder 便携版：优先用 exe 文件路径取所在目录（与 tray.js 一致）
  const portableFile = env.PORTABLE_EXECUTABLE_FILE;
  if (portableFile && String(portableFile).trim()) {
    return path.join(path.dirname(String(portableFile).trim()), PORTABLE_DATA_DIRNAME);
  }
  const portableDir = env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && String(portableDir).trim()) {
    return path.join(String(portableDir).trim(), PORTABLE_DATA_DIRNAME);
  }
  // 手动便携：标记文件与 exe 同目录
  const exeDir = path.dirname(execPath);
  for (const marker of PORTABLE_MARKERS) {
    if (fs.existsSync(path.join(exeDir, marker))) {
      return path.join(exeDir, PORTABLE_DATA_DIRNAME);
    }
  }
  return null;
}

/** 递归复制目录 */
function copyDirRecursive(src, dest, fs) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d, fs);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** 目录是否不存在或为空 */
function isEmptyDir(dir, fs) {
  try {
    return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
  } catch (_) {
    return true;
  }
}

/**
 * 解析最终数据目录。
 * @param {object} options
 * @param {string} options.appDataPath app.getPath('appData')
 * @param {string} options.execPath    process.execPath
 * @param {object} options.env         process.env
 * @param {object} options.fs          fs 模块
 * @param {string} options.sessionDir  安装版默认子目录名
 * @returns {{dir: string, portable: boolean, legacyDir: string, migrated: boolean}}
 */
function resolveDataDir(options) {
  const { appDataPath, execPath, env = {}, fs, sessionDir } = options;
  const legacyDir = path.join(appDataPath, sessionDir);

  const explicit = (env.LINGYA_USER_DATA_DIR || '').trim();
  if (explicit) {
    return { dir: path.resolve(explicit), portable: false, legacyDir, migrated: false };
  }

  // 配置文件自定义目录（侧边栏设置写入，优先级高于便携判定）
  const customDir = readCustomDataDir(appDataPath, sessionDir, fs);
  if (customDir) {
    try { fs.mkdirSync(customDir, { recursive: true }); } catch (_) { /* 创建失败则忽略 */ }
    return { dir: customDir, portable: false, legacyDir, migrated: false, custom: true };
  }

  // 安装向导选择的数据目录（<安装目录>\data-location.txt）
  // 若目录不可写（如装到 C:\Program Files 且无管理员权限），回退默认并标记原因。
  const installerDir = readInstallerDataDir(execPath, fs);
  if (installerDir) {
    if (isDirWritable(installerDir, fs)) {
      return { dir: installerDir, portable: false, legacyDir, migrated: false, fromInstaller: true };
    }
    return {
      dir: legacyDir,
      portable: false,
      legacyDir,
      migrated: false,
      installerFallback: true,
      installerDir,
    };
  }

  const portableDir = resolvePortableDataDir(execPath, env, fs);
  if (!portableDir) {
    return { dir: legacyDir, portable: false, legacyDir, migrated: false };
  }

  let migrated = false;
  if (!env.LINGYA_NO_MIGRATE && isEmptyDir(portableDir, fs) && !isEmptyDir(legacyDir, fs)) {
    try {
      copyDirRecursive(legacyDir, portableDir, fs);
      migrated = true;
    } catch (_) {
      // 迁移失败不影响启动，退回使用便携目录（空）
    }
  }
  return { dir: portableDir, portable: true, legacyDir, migrated };
}

/** 清洗实例名（防路径穿越） */
function sanitizeInstanceName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

/**
 * 解析具名实例目录。
 * LINGYA_INSTANCE=<name> 时返回 <baseDir>/instances/<name>，否则 null。
 * 具名实例目录固定，配置可持久（区别于自动隔离的临时实例）。
 * @param {string} baseDir 基础数据目录
 * @param {object} env 环境变量
 * @returns {string|null}
 */
function resolveInstanceDir(baseDir, env) {
  const name = ((env && env.LINGYA_INSTANCE) || '').trim();
  if (!name) return null;
  const safe = sanitizeInstanceName(name);
  if (!safe) return null;
  return path.join(baseDir, 'instances', safe);
}

/**
 * 清理过期的自动隔离实例目录（<baseDir>/instances/auto-*）。
 * 多开时每个自动实例用 auto-<pid> 命名，退出后不自动删除；启动时清理
 * 超过 maxAgeMs（默认 7 天）未修改的 auto-* 目录，避免无限累积。
 * 具名实例（instances/<name>）不受影响。
 * @param {string} baseDir 基础数据目录
 * @param {number} maxAgeMs 最大保留时长（毫秒）
 * @param {object} fsArg fs 模块
 * @returns {number} 清理的目录数
 */
function cleanStaleInstances(baseDir, maxAgeMs, fsArg) {
  const f = fsArg || fs;
  const instDir = path.join(baseDir, "instances");
  let removed = 0;
  let entries;
  try { entries = f.readdirSync(instDir, { withFileTypes: true }); } catch (_) { return 0; }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory() || !/^auto-[0-9]+$/.test(e.name)) continue;
    const full = path.join(instDir, e.name);
    try {
      const st = f.statSync(full);
      if (now - st.mtimeMs > maxAgeMs) {
        f.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch (_) {}
  }
  return removed;
}

module.exports = {
  PORTABLE_DATA_DIRNAME,
  PORTABLE_MARKERS,
  LOCATION_CONFIG_FILENAME,
  readCustomDataDir,
  writeCustomDataDir,
  readInstallerDataDir,
  isDirWritable,
  resolvePortableDataDir,
  copyDirRecursive,
  isEmptyDir,
  resolveDataDir,
  sanitizeInstanceName,
  resolveInstanceDir,
  cleanStaleInstances,
};
