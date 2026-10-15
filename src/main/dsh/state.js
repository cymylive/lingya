/**
 * DSH 兼容层 - 启用状态（CommonJS）
 * 结构：{ "<id>": { "enabled": boolean } }
 * 存储文件：<userData>/lingya-dsh-plugins.json
 */
const fs = require('fs');
const path = require('path');

let STORE_FILE = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-dsh-plugins.json');
  console.log('[DSH] 状态文件:', STORE_FILE);
}

function readTable() {
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      let text = fs.readFileSync(STORE_FILE, 'utf-8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const raw = JSON.parse(text);
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
  } catch (_) {}
  return {};
}

function writeTable(table) {
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(table, null, 2), 'utf-8');
    }
    return true;
  } catch (_) { return false; }
}

/** 是否已启用（默认关闭，与 cuckoo 一致——可执行内容需显式授权） */
function isEnabled(id) {
  const st = readTable()[id];
  return !!(st && typeof st === 'object' && st.enabled === true);
}

function setEnabled(id, enabled) {
  const table = readTable();
  table[id] = { enabled: !!enabled };
  return writeTable(table);
}

function clearState(id) {
  const table = readTable();
  delete table[id];
  writeTable(table);
}

module.exports = { init, isEnabled, setEnabled, clearState, readTable };
