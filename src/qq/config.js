/**
 * QQ 通道：配置读写（<userData>/qq.json）
 *
 * 凭证来自 QQ 开放平台（https://q.qq.com）：
 *   - AppID / AppSecret：机器人应用的凭证
 *   - 需在平台开启「私聊」「群聊」权限
 *
 * 存 botToken 是运行时从 AppID/AppSecret 换来的 access_token，
 * 缓存在内存里（不落盘），过期自动刷新。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let STORE_DIR = null;

function init(storeDir) {
  STORE_DIR = storeDir || null;
  console.log('[QQ] 配置目录:', getConfigFile());
}

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  if (STORE_DIR) return STORE_DIR;
  return path.join(os.homedir(), '.lingya');
}

function getConfigFile() {
  return path.join(getUserDir(), 'qq.json');
}

function defaultConfig() {
  return {
    appId: '',
    appSecret: '',
    enabled: false,
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
      appId: typeof raw.appId === 'string' ? raw.appId : '',
      appSecret: typeof raw.appSecret === 'string' ? raw.appSecret : '',
      enabled: raw.enabled === true,
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
    console.error('[QQ] 读取配置失败:', err.message);
    cache = dft;
    return cache;
  }
}

function writeConfig(data) {
  try {
    const base = readConfig();
    const d = data || {};
    const next = {
      appId: typeof d.appId === 'string' ? d.appId.trim() : base.appId,
      appSecret: typeof d.appSecret === 'string' ? d.appSecret.trim() : base.appSecret,
      enabled: typeof d.enabled === 'boolean' ? d.enabled : base.enabled,
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
    console.log('[QQ] 配置已写入:', file);
    return true;
  } catch (err) {
    console.error('[QQ] 写入配置失败:', err.message);
    return false;
  }
}

module.exports = { init, readConfig, writeConfig, getConfigFile, defaultConfig };
