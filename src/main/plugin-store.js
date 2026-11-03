/**
 * 插件启用状态存储（全局共享，JSON 持久化）
 * 存储文件：<userData>/lingya-plugins.json
 *
 * 结构：{ "<pluginId>": { enabled: boolean, pinned?: boolean, config?: object, deleted?: boolean, deletedAt?: string } }
 *
 * 说明：插件本体在 <userData>/plugins/<id>/ 目录（manifest.json + index.js）。
 * 本 store 只负责"用户是否启用"这一状态；扫描/加载由 plugin-host.js 完成。
 *
 * 墓碑（tombstone）：内置插件被用户删除后写入 deleted: true。
 * plugin-host 播种时跳过带墓碑的目录，重启后不再复活。
 * 墓碑与 enabled/pinned/config 共存 —— 恢复插件后配置原样还在。
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
  const rec = (data[pluginId] && typeof data[pluginId] === 'object') ? { ...data[pluginId] } : {};
  rec.enabled = !!enabled;
  data[pluginId] = rec;
  writeRaw(data);
  return !!enabled;
}

/**
 * 获取插件置顶状态
 * @param {string} pluginId
 */
function isPinned(pluginId) {
  const data = readRaw();
  const rec = data[pluginId];
  return !!(rec && rec.pinned === true);
}

/**
 * 设置插件置顶状态
 * @param {string} pluginId
 * @param {boolean} pinned
 */
function setPinned(pluginId, pinned) {
  if (!pluginId) throw new Error('pluginId 不能为空');
  const data = { ...readRaw() };
  const rec = (data[pluginId] && typeof data[pluginId] === 'object') ? { ...data[pluginId] } : {};
  rec.pinned = !!pinned;
  data[pluginId] = rec;
  writeRaw(data);
  return !!pinned;
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

// ========== 墓碑 API（内置插件删除持久化） ==========

/**
 * 标记插件为「已删除」。只写 deleted/deletedAt 字段，
 * 保留 enabled / pinned / config —— 恢复插件后用户配置不丢。
 * @param {string} pluginId
 * @returns {boolean} 是否写入成功
 */
function markDeleted(pluginId) {
  if (!pluginId) throw new Error('pluginId 不能为空');
  const data = { ...readRaw() };
  const rec = (data[pluginId] && typeof data[pluginId] === 'object') ? { ...data[pluginId] } : {};
  rec.deleted = true;
  rec.deletedAt = new Date().toISOString();
  data[pluginId] = rec;
  writeRaw(data);
  return true;
}

/**
 * 插件是否被标记为已删除。
 * @param {string} pluginId
 * @returns {boolean}
 */
function isDeleted(pluginId) {
  if (!pluginId) return false;
  const rec = readRaw()[pluginId];
  return !!(rec && rec.deleted === true);
}

/**
 * 清除全部墓碑（恢复内置插件时调用）。
 * 只删 deleted/deletedAt 字段，config / enabled / pinned 全部保留。
 * @returns {string[]} 被清除墓碑的插件 id 列表
 */
function clearDeleted() {
  const data = { ...readRaw() };
  const cleared = [];
  let changed = false;
  for (const id of Object.keys(data)) {
    const rec = data[id];
    if (rec && typeof rec === 'object' && rec.deleted === true) {
      const next = { ...rec };
      delete next.deleted;
      delete next.deletedAt;
      data[id] = next;
      cleared.push(id);
      changed = true;
    }
  }
  if (changed) writeRaw(data);
  return cleared;
}

/**
 * 列出所有带墓碑的插件 id。
 * @returns {string[]}
 */
function listDeleted() {
  const data = readRaw();
  return Object.keys(data).filter((id) => {
    const rec = data[id];
    return !!(rec && typeof rec === 'object' && rec.deleted === true);
  });
}

module.exports = {
  init, getStoreFile,
  isEnabled, setEnabled,
  isPinned, setPinned,
  removeRecord,
  savePluginConfig, getPluginConfig,
  markDeleted, isDeleted, clearDeleted, listDeleted,
};
