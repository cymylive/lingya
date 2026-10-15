/**
 * DSH 兼容层 - 目录约定（CommonJS）
 *
 * 目录：
 *  - 用户根：<userData>/dsh-plugins/（由 init 设置）
 *  - 插件目录：<root>/<id>/（每个插件一个 npm 包目录）
 *  - 启用状态：<userData>/lingya-dsh-plugins.json
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidPluginId(id) {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id);
}

let ROOT_DIR = null;

function init(storeDir) {
  ROOT_DIR = path.join(storeDir, 'dsh-plugins');
  try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch (_) {}
  console.log('[DSH] 插件目录:', ROOT_DIR);
}

function getDshPluginsDir() { return ROOT_DIR; }

function getDshPluginDir(id) { return path.join(ROOT_DIR, id); }

/** 列出已安装的 DSH 插件目录（含 package.json 的目录） */
function listDshPluginDirs() {
  if (!ROOT_DIR) return [];
  let entries;
  try { entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(ROOT_DIR, ent.name);
    if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
  }
  return out;
}

module.exports = { init, isValidPluginId, getDshPluginsDir, getDshPluginDir, listDshPluginDirs };
