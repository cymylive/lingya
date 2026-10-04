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

module.exports = {
  PORTABLE_DATA_DIRNAME,
  PORTABLE_MARKERS,
  resolvePortableDataDir,
  copyDirRecursive,
  isEmptyDir,
  resolveDataDir,
};
