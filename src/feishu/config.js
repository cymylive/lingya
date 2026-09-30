/**
 * 飞书同步：配置读写（<userData>/feishu.json）
 *
 * 存储：{ appId, appSecret, enabled, targetOpenId,
 *         pushUserMessage, pushAiReply, pushToolStatus, pushToolName }
 * 可用环境变量 LINGYA_HOME 覆盖存储目录（测试隔离）。
 *
 * 移植自 cuckoo-code src/feishu/config.ts（TS/ESM → CJS）。
 * 路径由 Electron userData 决定，通过 init(storeDir) 注入。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let STORE_DIR = null;

/**
 * 初始化存储目录（主进程启动时调用，传 app.getPath('userData')）
 * @param {string} storeDir
 */
function init(storeDir) {
  STORE_DIR = storeDir || null;
  console.log('[Feishu] 配置目录:', getConfigFile());
}

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  if (STORE_DIR) return STORE_DIR;
  return path.join(os.homedir(), '.lingya');
}

function getConfigFile() {
  return path.join(getUserDir(), 'feishu.json');
}

/** 默认配置（未启用） */
function defaultConfig() {
  return {
    appId: '',
    appSecret: '',
    enabled: false,
    targetOpenId: '',
    pushUserMessage: true,
    pushAiReply: true,
    pushToolStatus: true,
    pushToolName: false,
  };
}

let cache = null;

/** 读取配置（不存在则返回默认；字段类型清洗） */
function readConfig() {
  if (cache) return cache;
  const dft = defaultConfig();
  try {
    const file = getConfigFile();
    if (!fs.existsSync(file)) { cache = dft; return cache; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') { cache = dft; return cache; }
    cache = {
      appId: typeof raw.appId === 'string' ? raw.appId : '',
      appSecret: typeof raw.appSecret === 'string' ? raw.appSecret : '',
      enabled: raw.enabled === true,
      targetOpenId: typeof raw.targetOpenId === 'string' ? raw.targetOpenId : '',
      pushUserMessage: raw.pushUserMessage !== false,
      pushAiReply: raw.pushAiReply !== false,
      pushToolStatus: raw.pushToolStatus !== false,
      pushToolName: raw.pushToolName === true,
    };
    return cache;
  } catch (err) {
    console.error('[Feishu] 读取配置失败:', err.message);
    cache = dft;
    return cache;
  }
}

/** 写入配置（局部合并；appSecret 掩码不回写） */
function writeConfig(data) {
  try {
    const base = readConfig();
    const d = data || {};
    const next = {
      appId: typeof d.appId === 'string' ? d.appId.trim() : base.appId,
      appSecret: typeof d.appSecret === 'string' ? d.appSecret.trim() : base.appSecret,
      enabled: typeof d.enabled === 'boolean' ? d.enabled : base.enabled,
      targetOpenId: typeof d.targetOpenId === 'string' ? d.targetOpenId : base.targetOpenId,
      pushUserMessage: typeof d.pushUserMessage === 'boolean' ? d.pushUserMessage : base.pushUserMessage,
      pushAiReply: typeof d.pushAiReply === 'boolean' ? d.pushAiReply : base.pushAiReply,
      pushToolStatus: typeof d.pushToolStatus === 'boolean' ? d.pushToolStatus : base.pushToolStatus,
      pushToolName: typeof d.pushToolName === 'boolean' ? d.pushToolName : base.pushToolName,
    };
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    cache = next;
    console.log('[Feishu] 配置已写入:', file);
    return true;
  } catch (err) {
    console.error('[Feishu] 写入配置失败:', err.message);
    return false;
  }
}

module.exports = { init, readConfig, writeConfig, getConfigFile, defaultConfig };
