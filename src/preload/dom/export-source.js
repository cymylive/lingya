/**
 * 导出数据源解析
 *
 * 优先级：本地存档 → 平台 IndexedDB → 空（带提示文案）
 *
 * 本地存档是 LingYa 自己在对话进行时累积的完整记录（含工具执行结果），
 * 不依赖平台侧是否保留会话，因此永远优先。
 */
'use strict';

/**
 * @param {string} sessionId
 * @param {{readArchive:Function, readIndexedDB:Function}} [deps] 可注入（测试用）
 * @returns {Promise<{source:'archive'|'indexeddb'|'empty', entries:Array, message?:string}>}
 */
async function resolveExportEntries(sessionId, deps) {
  const d = deps || {};

  function getReadArchive() {
    if (typeof d.readArchive === 'function') return d.readArchive;
    return async function (sid) {
      if (typeof window === 'undefined' || !window.electronAPI
          || typeof window.electronAPI.conversationArchiveRead !== 'function') {
        return { success: false, entries: [] };
      }
      return window.electronAPI.conversationArchiveRead(sid);
    };
  }

  function getReadIndexedDB() {
    if (typeof d.readIndexedDB === 'function') return d.readIndexedDB;
    return async function () {
      // 生产环境的 IndexedDB 读取由 chat-input.js 的现有逻辑提供；
      // 这里默认返回空，调用方应显式注入。
      return [];
    };
  }

  if (!sessionId) {
    return { source: 'empty', entries: [], message: '该会话暂无对话内容' };
  }

  // 1. 本地存档
  try {
    const r = await getReadArchive()(sessionId);
    if (r && r.success && Array.isArray(r.entries) && r.entries.length > 0) {
      return { source: 'archive', entries: r.entries };
    }
  } catch (_) { /* 存档失败，继续回退 */ }

  // 2. 平台 IndexedDB
  try {
    const msgs = await getReadIndexedDB()(sessionId);
    if (Array.isArray(msgs) && msgs.length > 0) {
      return { source: 'indexeddb', entries: msgs };
    }
  } catch (_) { /* IDB 失败，返回空 */ }

  // 3. 都没有
  return { source: 'empty', entries: [], message: '该会话暂无对话内容' };
}

module.exports = { resolveExportEntries };
