/**
 * 监督机制激活状态存储（按会话独立、持久化、无上限）
 *
 * 【为什么需要独立存储】
 * 监督者是否该介入，取决于「本会话是否建过 todo 计划」。这个状态必须：
 *   1. 按会话独立 —— 会话 A 建过计划不代表 B 也该被催
 *   2. 跨会话切换保持 —— 切走再切回 A，A 仍处于激活态
 *   3. 跨重启保持 —— 关掉 LingYa 再开，A 仍然激活（用户明确要求 1B）
 *
 * 存到独立文件而不是塞进 session-store：session-store 的结构已被大量代码依赖，
 * 往里加字段风险高于收益；且这里的语义是「监督者运行时状态」，与用户数据无关。
 *
 * 存储文件：<userData>/lingya-supervisor-state.json
 * 结构：{ activatedSessions: { [sessionId]: { activatedAt: <ISO 字符串> } } }
 *
 * 无上限：用户明确要求不设上限。每个会话约 100 字节，1000 个会话约 100KB，可接受。
 */
const fs = require('fs');
const path = require('path');

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-supervisor-state.json');
  cache = null;
  console.log('[SupervisorStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      const sessions = (parsed && typeof parsed === 'object' && parsed.activatedSessions
        && typeof parsed.activatedSessions === 'object') ? parsed.activatedSessions : {};
      cache = { activatedSessions: sessions };
      return cache;
    }
  } catch (err) {
    // 文件损坏时降级为空表，不阻断功能（最坏情况是用户需要重新建一次计划）
    console.error('[SupervisorStore] 读取失败，降级为空表:', err.message);
  }
  cache = { activatedSessions: {} };
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
    console.error('[SupervisorStore] 写入失败:', err.message);
  }
}

/** 某会话是否已激活监督机制 */
function isActivated(sessionId) {
  if (!sessionId) return false;
  const data = readRaw();
  return Object.prototype.hasOwnProperty.call(data.activatedSessions, sessionId);
}

/**
 * 激活某会话的监督机制。幂等：已激活时不覆盖 activatedAt。
 * @returns {boolean} true 表示本次新激活，false 表示已激活或参数无效
 */
function activate(sessionId) {
  if (!sessionId) return false;
  const data = readRaw();
  if (Object.prototype.hasOwnProperty.call(data.activatedSessions, sessionId)) return false;
  data.activatedSessions[sessionId] = { activatedAt: new Date().toISOString() };
  writeRaw(data);
  console.log('[SupervisorStore] 监督机制已激活: ' + sessionId);
  return true;
}

/** 取消激活（供调试或用户手动重置） */
function deactivate(sessionId) {
  if (!sessionId) return false;
  const data = readRaw();
  if (!Object.prototype.hasOwnProperty.call(data.activatedSessions, sessionId)) return false;
  delete data.activatedSessions[sessionId];
  writeRaw(data);
  return true;
}

/** 某会话的激活时刻（ISO 字符串），未激活返回 null */
function getActivatedAt(sessionId) {
  if (!sessionId) return null;
  const data = readRaw();
  const rec = data.activatedSessions[sessionId];
  return rec ? rec.activatedAt : null;
}

/** 所有已激活会话 ID（无上限） */
function listActivated() {
  return Object.keys(readRaw().activatedSessions);
}

module.exports = {
  init,
  getStoreFile,
  isActivated,
  activate,
  deactivate,
  getActivatedAt,
  listActivated,
};
