/**
 * 会话存档 IPC 通道
 *
 * 把 conversation-archive 的读写能力暴露给渲染进程。
 * 每 profile 惰性创建一个 archive 实例，缓存在 Map 里。
 */
const path = require('path');
const { createConversationArchive } = require('./conversation-archive');

/**
 * @param {object} ipcMain Electron ipcMain（测试时可注入 fake）
 * @param {object} windowState window 管理模块（提供 getContextByWebContents）
 * @param {string} userDataDir 用户数据根目录
 * @returns {{ flushAll: () => boolean }}
 */
function createArchiveIpc(ipcMain, windowState, userDataDir) {
  const instances = new Map(); // profileId -> archive

  function getArchive(profileId) {
    if (!profileId) return null;
    let a = instances.get(profileId);
    if (!a) {
      a = createConversationArchive(profileId, userDataDir);
      instances.set(profileId, a);
    }
    return a;
  }

  function resolveProfileId(event) {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      return ctx && ctx.profileId ? ctx.profileId : null;
    } catch (_) {
      return null;
    }
  }

  ipcMain.handle('conversation-archive-append', async (event, { sessionId, entry } = {}) => {
    const pid = resolveProfileId(event);
    if (!pid) return { success: false, error: '窗口上下文不存在' };
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    const a = getArchive(pid);
    return a.appendEntry(sessionId, entry);
  });

  ipcMain.handle('conversation-archive-read', async (event, { sessionId } = {}) => {
    const pid = resolveProfileId(event);
    if (!pid) return { success: false, entries: [], error: '窗口上下文不存在' };
    if (!sessionId) return { success: false, entries: [], error: '缺少 sessionId' };
    const a = getArchive(pid);
    return a.readEntries(sessionId);
  });

  ipcMain.handle('conversation-archive-has', async (event, { sessionId } = {}) => {
    const pid = resolveProfileId(event);
    if (!pid) return { success: false, exists: false, error: '窗口上下文不存在' };
    if (!sessionId) return { success: false, exists: false, error: '缺少 sessionId' };
    const a = getArchive(pid);
    return { success: true, exists: a.hasArchive(sessionId) };
  });

  /** 退出前调用：刷新所有实例 */
  function flushAll() {
    for (const a of instances.values()) {
      try { a.flush(); } catch (_) {}
    }
    return true;
  }

  return { flushAll };
}

module.exports = { createArchiveIpc };
