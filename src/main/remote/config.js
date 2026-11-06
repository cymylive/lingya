/**
 * 手机远程控制：配置读写
 *
 * 存储：<dataDir>/remote.json
 * 环境变量 LINGYA_HOME 可覆盖数据目录（测试隔离）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  return path.join(os.homedir(), '.lingya');
}

function getConfigPath() {
  return path.join(getUserDir(), 'remote.json');
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function defaultConfig() {
  return {
    enabled: false,
    port: 7799,
    token: '',
    publicUrl: '',
    tunnelEnabled: false,
    tunnelToken: '',
    edgeDns: '223.5.5.5',
  };
}

/** 原子写入：先写临时文件再 rename，崩溃不留半截 JSON */
function saveConfigFile(cfg) {
  try {
    const file = getConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[Remote] 写入配置失败:', err && err.message);
    return false;
  }
}

function cleanPublicUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url.replace(/\/+$/, '');
}

function cleanPort(raw) {
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 7799;
}

function readConfig() {
  const dft = defaultConfig();
  const file = getConfigPath();

  if (!fs.existsSync(file)) {
    const initCfg = Object.assign({}, dft, { token: genToken() });
    saveConfigFile(initCfg);
    return initCfg;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error('[Remote] 配置损坏，正在修复:', err && err.message);
    const initCfg = Object.assign({}, dft, { token: genToken() });
    saveConfigFile(initCfg);
    return initCfg;
  }

  if (!raw || typeof raw !== 'object') {
    const initCfg = Object.assign({}, dft, { token: genToken() });
    saveConfigFile(initCfg);
    return initCfg;
  }

  const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : genToken();
  const cfg = {
    enabled: raw.enabled === true,
    port: cleanPort(raw.port),
    token,
    publicUrl: cleanPublicUrl(raw.publicUrl),
    tunnelEnabled: raw.tunnelEnabled === true,
    tunnelToken: typeof raw.tunnelToken === 'string' ? raw.tunnelToken.trim() : dft.tunnelToken,
    edgeDns: typeof raw.edgeDns === 'string' ? raw.edgeDns.trim() : dft.edgeDns,
  };

  if (!raw.token) saveConfigFile(cfg);

  return cfg;
}

function writeConfig(data) {
  try {
    const base = readConfig();
    const next = Object.assign({}, base);

    if (data && typeof data === 'object') {
      if (typeof data.enabled === 'boolean') next.enabled = data.enabled;
      if (Number.isInteger(data.port)) next.port = cleanPort(data.port);
      if (typeof data.token === 'string' && data.token.length > 0) next.token = data.token;
      if (typeof data.publicUrl === 'string') next.publicUrl = cleanPublicUrl(data.publicUrl);
      if (typeof data.tunnelEnabled === 'boolean') next.tunnelEnabled = data.tunnelEnabled;
      if (typeof data.tunnelToken === 'string') next.tunnelToken = data.tunnelToken.trim();
      if (typeof data.edgeDns === 'string') next.edgeDns = data.edgeDns.trim();
    }

    return saveConfigFile(next);
  } catch (err) {
    console.error('[Remote] 写入配置失败:', err && err.message);
    return false;
  }
}

module.exports = {
  readConfig,
  writeConfig,
  getConfigPath,
  genToken,
};
