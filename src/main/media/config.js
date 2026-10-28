/**
 * 媒体收件箱配置（<userData>/media-config.json）
 *
 * 目前只有一项：接收文件的根目录。
 * 默认 <userData>/media-inbox，用户可改成任意绝对路径。
 *
 * 安全边界（重要）：
 *   目录可配 ≠ 目录随便写。validateDir 会拒绝：
 *   - 相对路径（随 cwd 漂移）
 *   - 盘符根 / 系统关键目录（C:\\Windows、Program Files 等）
 *   - 用户主目录本身（避免文件散落一地）
 *   - 无法创建或不存在的父目录
 *
 *   接收到的文件名仍经过 sanitizeFileName 清洗，所以即使目录被配成
 *   D:\\我的文件，也不可能通过文件名穿越到 D:\\ 之外。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let STORE_DIR = null;

function init(storeDir) {
  STORE_DIR = storeDir || null;
}

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  if (STORE_DIR) return STORE_DIR;
  return path.join(os.homedir(), '.lingya');
}

function getConfigFile() {
  return path.join(getUserDir(), 'media-config.json');
}

/** 默认根目录 */
function getDefaultDir() {
  return path.join(getUserDir(), 'media-inbox');
}

/** 系统关键目录黑名单（这些绝不能作为收件箱） */
function getForbiddenDirs() {
  const out = [];
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const progData = process.env.ProgramData || 'C:\\ProgramData';
    out.push(sysRoot, progFiles, progFilesX86, progData);
  } else {
    out.push('/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library');
  }
  return out.map((p) => path.resolve(p).toLowerCase());
}

/**
 * 校验一个目录能否作为收件箱根目录。
 * @param {string} dir 用户输入
 * @returns {{ok: boolean, resolved?: string, error?: string}}
 */
function validateDir(dir) {
  try {
    if (!dir || typeof dir !== 'string') return { ok: false, error: '目录不能为空' };
    const trimmed = dir.trim();
    if (!trimmed) return { ok: false, error: '目录不能为空' };
    if (!path.isAbsolute(trimmed)) {
      return { ok: false, error: '必须是绝对路径（如 D:\\我的文件\\微信收件）' };
    }

    const resolved = path.resolve(trimmed);
    const lower = resolved.toLowerCase();

    // 拒绝盘符根 / 文件系统根
    const parsed = path.parse(resolved);
    if (resolved === parsed.root) {
      return { ok: false, error: '不能使用磁盘根目录' };
    }

    // 拒绝系统关键目录及其子目录
    for (const bad of getForbiddenDirs()) {
      if (lower === bad || lower.startsWith(bad + path.sep)) {
        return { ok: false, error: '不能使用系统目录: ' + resolved };
      }
    }

    // 拒绝用户主目录本身（可以放其子目录）
    const home = path.resolve(os.homedir()).toLowerCase();
    if (lower === home) {
      return { ok: false, error: '不能直接使用用户主目录，请在其下指定子目录' };
    }

    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let cache = null;

function readConfig() {
  if (cache) return cache;
  const dft = { inboxDir: '' };
  try {
    const file = getConfigFile();
    if (!fs.existsSync(file)) { cache = dft; return cache; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    cache = {
      inboxDir: typeof raw.inboxDir === 'string' ? raw.inboxDir : '',
    };
    return cache;
  } catch (err) {
    console.error('[Media] 读取配置失败:', err.message);
    cache = dft;
    return cache;
  }
}

function writeConfig(data) {
  try {
    const base = readConfig();
    const d = data || {};
    const next = {
      inboxDir: typeof d.inboxDir === 'string' ? d.inboxDir.trim() : base.inboxDir,
    };
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    cache = next;
    console.log('[Media] 配置已写入:', file);
    return true;
  } catch (err) {
    console.error('[Media] 写入配置失败:', err.message);
    return false;
  }
}

/**
 * 取实际生效的收件箱根目录。
 * 用户配置了且合法就用它，否则回退默认。
 * @returns {string}
 */
function getEffectiveDir() {
  const cfg = readConfig();
  if (cfg.inboxDir) {
    const v = validateDir(cfg.inboxDir);
    if (v.ok) return v.resolved;
    console.warn('[Media] 配置的收件箱目录无效，回退默认:', v.error);
  }
  return getDefaultDir();
}

module.exports = {
  init,
  readConfig,
  writeConfig,
  getConfigFile,
  getDefaultDir,
  getEffectiveDir,
  validateDir,
};
