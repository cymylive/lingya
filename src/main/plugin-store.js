/**
 * 插件启用状态存储（全局共享，JSON 持久化）
 * 存储文件：<userData>/lingya-plugins.json
 *
 * 结构：{ "<pluginId>": { enabled: boolean } }
 *
 * 说明：插件本体在 <userData>/plugins/<id>/ 目录（manifest.json + index.js）。
 * 本 store 只负责"用户是否启用"这一状态；扫描/加载由 plugin-host.js 完成。
 */
const fs = require('fs');
const path = require('path');

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-plugins.json');
  cache = null;
  console.log('[PluginStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
      return cache;
    }
  } catch (err) {
    console.error('[PluginStore] 读取失败:', err.message);
  }
  cache = {};
  return cache;
}

function writeRaw(data) {
  cache = data;
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[PluginStore] 写入失败:', err.message);
  }
}

/**
 * 获取指定插件的启用状态。未记录时回退到 manifest 的默认值。
 * @param {string} pluginId
 * @param {boolean} [defaultEnabled]
 */
function isEnabled(pluginId, defaultEnabled) {
  const data = readRaw();
  const rec = data[pluginId];
  if (rec && typeof rec.enabled === 'boolean') return rec.enabled;
  return defaultEnabled !== false; // 默认启用
}

/**
 * 设置指定插件的启用状态
 * @param {string} pluginId
 * @param {boolean} enabled
 */
function setEnabled(pluginId, enabled) {
  if (!pluginId) throw new Error('pluginId 不能为空');
  const data = { ...readRaw() };
  data[pluginId] = { enabled: !!enabled };
  writeRaw(data);
  return !!enabled;
}

/** 删除插件记录（插件目录被移除时调用） */
function removeRecord(pluginId) {
  const data = { ...readRaw() };
  if (pluginId in data) {
    delete data[pluginId];
    writeRaw(data);
  }
}

/**
 * 保存插件自己的配置（ctx.settings 落盘，重启保留）。
 * 存到该插件记录的 config 字段。
 */
function savePluginConfig(pluginId, config) {
  if (!pluginId) return false;
  const data = { ...readRaw() };
  const rec = (data[pluginId] && typeof data[pluginId] === 'object') ? data[pluginId] : {};
  rec.config = config || {};
  data[pluginId] = rec;
  writeRaw(data);
  return true;
}

/** 读插件配置 */
function getPluginConfig(pluginId) {
  const rec = readRaw()[pluginId];
  return (rec && typeof rec === 'object' && rec.config) ? rec.config : {};
}

module.exports = { init, getStoreFile, isEnabled, setEnabled, removeRecord, savePluginConfig, getPluginConfig };
