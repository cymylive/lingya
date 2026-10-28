/**
 * 微信 iLink 通道：配置读写（<userData>/weixin.json）
 *
 * 存储：{ enabled, botToken, botId, userId, baseUrl,
 *         pushUserMessage, pushAiReply, pushToolStatus, pushToolName,
 *         pushTaskDone, stallTimeoutSec }
 *
 * botToken 是扫码登录后拿到的 Bearer token，持久化后下次启动可跳过扫码。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let STORE_DIR = null;

function init(storeDir) {
  STORE_DIR = storeDir || null;
  console.log('[Weixin] 配置目录:', getConfigFile());
}

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  if (STORE_DIR) return STORE_DIR;
  return path.join(os.homedir(), '.lingya');
}

function getConfigFile() {
  return path.join(getUserDir(), 'weixin.json');
}

function defaultConfig() {
  return {
    enabled: false,
    botToken: '',
    botId: '',
    userId: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    pushUserMessage: true,
    pushAiReply: true,
    pushToolStatus: true,
    pushToolName: false,
    pushTaskDone: true,
    stallTimeoutSec: 660,
  };
}

let cache = null;

function readConfig() {
  if (cache) return cache;
  const dft = defaultConfig();
  try {
    const file = getConfigFile();
    if (!fs.existsSync(file)) { cache = dft; return cache; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') { cache = dft; return cache; }
    cache = {
      enabled: raw.enabled === true,
      botToken: typeof raw.botToken === 'string' ? raw.botToken : '',
      botId: typeof raw.botId === 'string' ? raw.botId : '',
      userId: typeof raw.userId === 'string' ? raw.userId : '',
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : 'https://ilinkai.weixin.qq.com',
      pushUserMessage: raw.pushUserMessage !== false,
      pushAiReply: raw.pushAiReply !== false,
      pushToolStatus: raw.pushToolStatus !== false,
      pushToolName: raw.pushToolName === true,
      pushTaskDone: raw.pushTaskDone !== false,
      stallTimeoutSec: (typeof raw.stallTimeoutSec === 'number' &&
        (raw.stallTimeoutSec === 0 || raw.stallTimeoutSec >= 30))
        ? Math.floor(raw.stallTimeoutSec) : 660,
    };
    return cache;
  } catch (err) {
    console.error('[Weixin] 读取配置失败:', err.message);
    cache = dft;
    return cache;
  }
}

function writeConfig(data) {
  try {
    const base = readConfig();
    const d = data || {};
    const next = {
      enabled: typeof d.enabled === 'boolean' ? d.enabled : base.enabled,
      botToken: typeof d.botToken === 'string' ? d.botToken.trim() : base.botToken,
      botId: typeof d.botId === 'string' ? d.botId.trim() : base.botId,
      userId: typeof d.userId === 'string' ? d.userId.trim() : base.userId,
      baseUrl: typeof d.baseUrl === 'string' && d.baseUrl ? d.baseUrl.trim() : base.baseUrl,
      pushUserMessage: typeof d.pushUserMessage === 'boolean' ? d.pushUserMessage : base.pushUserMessage,
      pushAiReply: typeof d.pushAiReply === 'boolean' ? d.pushAiReply : base.pushAiReply,
      pushToolStatus: typeof d.pushToolStatus === 'boolean' ? d.pushToolStatus : base.pushToolStatus,
      pushToolName: typeof d.pushToolName === 'boolean' ? d.pushToolName : base.pushToolName,
      pushTaskDone: typeof d.pushTaskDone === 'boolean' ? d.pushTaskDone : base.pushTaskDone,
      stallTimeoutSec: (typeof d.stallTimeoutSec === 'number' &&
        (d.stallTimeoutSec === 0 || d.stallTimeoutSec >= 30))
        ? Math.floor(d.stallTimeoutSec) : base.stallTimeoutSec,
    };
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    cache = next;
    console.log('[Weixin] 配置已写入:', file);
    return true;
  } catch (err) {
    console.error('[Weixin] 写入配置失败:', err.message);
    return false;
  }
}

module.exports = { init, readConfig, writeConfig, getConfigFile, defaultConfig };
