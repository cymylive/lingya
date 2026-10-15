/**
 * DSH 兼容层 - 集成入口（CommonJS）
 *
 * 职责：
 *  - 初始化 paths/state
 *  - 安装 / 卸载 / 启停 / 列出 DSH 插件
 *  - 加载已启用插件 → 把插件注册的工具挂到 LingYa 工具注册表
 *
 * "类似鸿蒙兼容 Android"：DSH 插件原样放进 LingYa 就能跑，不依赖 DSH 代码。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const state = require('./state');
const installer = require('./installer');
const loader = require('./loader');

// 已加载的 DSH 插件：id -> { pluginName, tools, runtime, registeredNames }
const loaded = new Map();
// 宿主能力（由 app 层注入）
let HOST = null;
// 工具注册表（由 app 层注入，用于挂载/卸载工具）
let TOOL_REGISTRY = null;
// 工具变更回调（通知 preload 刷新白名单）
let onToolsChanged = null;

let DATA_DIR = null;

function init(storeDir, opts) {
  paths.init(storeDir);
  state.init(storeDir);
  require('./market').init(storeDir);
  DATA_DIR = storeDir;
  loader.setDataDir(storeDir);
  HOST = (opts && opts.host) || null;
  TOOL_REGISTRY = (opts && opts.toolRegistry) || null;
  onToolsChanged = (opts && opts.onToolsChanged) || null;
  console.log('[DSH] 兼容层已初始化');
}

function notifyChanged() {
  try { if (typeof onToolsChanged === 'function') onToolsChanged(); } catch (_) {}
}

/** 列出插件（含安装/启用/加载状态） */
function listPlugins() {
  const dirs = paths.listDshPluginDirs();
  const out = [];
  for (const dir of dirs) {
    const id = path.basename(dir);
    let name = id, version = '?';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      // 壳目录的 name 不是真插件名，尝试从 dependencies 里取
      const deps = Object.keys((pkg && pkg.dependencies) || {});
      if (deps.length > 0) { name = deps[0]; }
      else if (pkg.name) name = pkg.name;
      version = pkg.version || '?';
    } catch (_) {}
    const rec = loaded.get(id);
    out.push({
      id,
      name,
      version,
      enabled: state.isEnabled(id),
      loaded: !!rec,
      toolNames: rec ? rec.registeredNames : [],
    });
  }
  return out;
}

/** 加载一个插件（注册其工具） */
async function loadOne(id) {
  if (loaded.has(id)) return { success: true, message: '已加载' };
  const dir = paths.getDshPluginDir(id);
  if (!fs.existsSync(dir)) return { success: false, error: '插件目录不存在' };
  try {
    const { pluginName, tools, runtime } = await loader.loadDshPlugin(dir, HOST);
    const registeredNames = [];
    const overridden = new Map();
    for (const t of tools) {
      if (!t || !t.name) continue;
      // 与内置工具重名 → 跳过（内置优先，避免卸载 DSH 插件时误删内置工具）
      const existing = TOOL_REGISTRY.get(t.name);
      if (existing) overridden.set(t.name, existing);
      TOOL_REGISTRY.register(t);
      registeredNames.push(t.name);
    }
    if (overridden.size) {
      console.log('[DSH] 插件 ' + id + ' 覆盖内置工具:', [...overridden.keys()].join(','));
    }
    loaded.set(id, { pluginName, tools, runtime, registeredNames, overridden });
    console.log('[DSH] 已加载插件', id, '(' + pluginName + ')，工具:', registeredNames.join(',') || '无');
    return { success: true, toolNames: registeredNames };
  } catch (err) {
    console.error('[DSH] 加载插件失败', id, ':', err.message);
    return { success: false, error: err.message };
  }
}

/** 卸载一个插件（注销其工具） */
function unloadOne(id) {
  const rec = loaded.get(id);
  if (!rec) return { success: true, message: '未加载' };
  for (const name of rec.registeredNames) {
    try {
      const orig = rec.overridden && rec.overridden.get(name);
      if (orig) TOOL_REGISTRY.register(orig);   // 恢复被覆盖的内置工具
      else TOOL_REGISTRY.unregister(name);       // DSH 独有工具 → 注销
    } catch (_) {}
  }
  loaded.delete(id);
  console.log('[DSH] 已卸载插件', id);
  return { success: true };
}

/** 启动时加载所有已启用插件 */
async function loadEnabledPlugins() {
  const dirs = paths.listDshPluginDirs();
  let ok = 0, fail = 0;
  for (const dir of dirs) {
    const id = path.basename(dir);
    if (!state.isEnabled(id)) continue;
    const r = await loadOne(id);
    if (r.success) ok++; else fail++;
  }
  console.log('[DSH] 启动加载完成：成功 ' + ok + '，失败 ' + fail);
  return { ok, fail };
}

/** 安装插件（npm） */
async function installPlugin(spec) {
  const r = await installer.installPlugin(spec);
  if (r.success) {
    // 默认启用新装的
    state.setEnabled(r.id, true);
    const lr = await loadOne(r.id);
    notifyChanged();
    return Object.assign({}, r, { loaded: lr.success, loadError: lr.error });
  }
  return r;
}

/** 卸载插件 */
async function uninstallPlugin(id) {
  unloadOne(id);
  const r = installer.uninstallPlugin(id);
  state.clearState(id);
  notifyChanged();
  return r;
}

/** 启用/禁用 */
async function setEnabled(id, enabled) {
  state.setEnabled(id, enabled);
  let r;
  if (enabled) r = await loadOne(id);
  else r = unloadOne(id);
  notifyChanged();
  return r;
}

/** 重载 */
async function reloadPlugin(id) {
  unloadOne(id);
  const r = await loadOne(id);
  notifyChanged();
  return r;
}

function loadedIds() { return Array.from(loaded.keys()); }

// 会话查询（供统一插件的 ctx.sessions 使用）
function getCurrentSession() {
  try { return (HOST && HOST.getCurrentSession) ? HOST.getCurrentSession() : { id: null, projectDir: null }; } catch (_) { return { id: null, projectDir: null }; }
}
function listSessions() {
  try { return (HOST && HOST.listSessions) ? HOST.listSessions() : []; } catch (_) { return []; }
}
function getSession(id) {
  try { return (HOST && HOST.getSession) ? HOST.getSession(id) : null; } catch (_) { return null; }
}

/** 收集所有 DSH 插件注册的工具名（供 JsRunner 白名单） */
function getAllToolNames() {
  const out = [];
  for (const rec of loaded.values()) out.push(...rec.registeredNames);
  return out;
}

module.exports = {
  init,
  searchMarket: (opts) => require('./market').search(opts),
  listPlugins,
  loadOne,
  unloadOne,
  loadEnabledPlugins,
  installPlugin,
  uninstallPlugin,
  setEnabled,
  reloadPlugin,
  loadedIds,
  getAllToolNames,
  getCurrentSession,
  listSessions,
  getSession,
};
