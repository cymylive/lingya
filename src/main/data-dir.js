/**
 * 数据目录解析（便携优先）
 *
 * 目标：便携版的数据（记忆/技能/安全/Agent/MCP/profile/会话等）与程序同目录，
 * 换电脑或整体搬目录时配置不丢。
 *
 * 优先级：
 *   1. LINGYA_USER_DATA_DIR 环境变量（显式覆盖）
 *   2. exe 同目录的 <exe目录>/LingYa-Data（便携版和安装版统一）
 *      - 便携版：PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR / portable.txt 标记
 *      - 安装版：默认也用 exe 同目录，方便整个目录打包迁移
 *   3. 回退（仅当 exe 目录不可写，如装到 C:\Program Files 且无管理员权限）：
 *      <appData>/<sessionDir>
 *
 * 首次运行且目标目录为空、旧目录（appData/<sessionDir>）有数据时，自动迁移一次
 * （可用 LINGYA_NO_MIGRATE 禁用）。
 *
 * 纯函数 + 依赖注入（fs/env/execPath 全部传入），便于单测。
 */
const path = require('path');

const PORTABLE_DATA_DIRNAME = 'LingYa-Data';
const PORTABLE_MARKERS = ['portable.txt', 'LingYa-Portable.txt'];

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

  // 统一策略：数据默认放 exe 同目录的 LingYa-Data（便携版和安装版一致）。
  // 好处：整个程序目录打包 zip 就能换电脑直接用，升级重装也不丢数据。
  // 例外：装到 C:\Program Files 等只读位置时，检测不可写则回退旧目录并提示。
  const portableDir = resolvePortableDataDir(execPath, env, fs) ||
    path.join(path.dirname(execPath), PORTABLE_DATA_DIRNAME);

  if (!isDirWritable(portableDir, fs)) {
    // 只读位置（如 Program Files）：回退 %APPDATA%，标记原因供启动日志提示
    return {
      dir: legacyDir,
      portable: false,
      legacyDir,
      migrated: false,
      readonlyFallback: true,
      intendedDir: portableDir,
    };
  }

  // 首次运行且目标目录为空、旧目录有数据 → 从旧目录迁移一次
  let migrated = false;
  if (!env.LINGYA_NO_MIGRATE && isEmptyDir(portableDir, fs) && !isEmptyDir(legacyDir, fs)) {
    try {
      copyDirRecursive(legacyDir, portableDir, fs);
      migrated = true;
    } catch (_) {
      // 迁移失败不影响启动，继续用空的目标目录
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
  isDirWritable,
  resolvePortableDataDir,
  copyDirRecursive,
  isEmptyDir,
  resolveDataDir,
  sanitizeInstanceName,
  resolveInstanceDir,
  cleanStaleInstances,
};
