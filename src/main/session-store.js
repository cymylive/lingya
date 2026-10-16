/**
 * 会话-目录映射持久化存储 + URL 会话检测（每 profile 独立实例）
 * 由原 session-store.js 改造：从单例改为工厂函数，每个 profile 拥有独立存储文件和状态。
 */
const fs = require('fs');
const path = require('path');
const { getProviderByUrl } = require('../providers');

/**
 * 创建 profile 专属的 session store 实例
 * @param {string} profileId profile id
 * @param {string} storeDir 存储目录（通常是 userData）
 * @param {object} windowState window 管理模块引用
 */
function createSessionStore(profileId, storeDir, windowState) {
  const STORE_FILE = path.join(storeDir, 'session-dir-map-' + profileId + '.json');

  function readSessionStore() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('[LingYa] 读取会话存储失败:', err.message);
    }
    return {};
  }

  function writeSessionStore(store) {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
      console.log('[LingYa] 会话存储已保存:', STORE_FILE);
    } catch (err) {
      console.error('[LingYa] 写入会话存储失败:', err.message);
    }
  }

  /** 兼容旧数据：把 store[id] 归一化为对象 { projectDir, title, createdAt, updatedAt } */
  function normalizeEntry(entry) {
    if (entry == null) return null;
    if (typeof entry === 'string') return { projectDir: entry, title: null, createdAt: null, updatedAt: null };
    if (typeof entry === 'object') return {
      projectDir: entry.projectDir != null ? entry.projectDir : null,
      title: entry.title || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    };
    return null;
  }

  function getProjectDirBySessionId(sessionId) {
    if (!sessionId) return null;
    const store = readSessionStore();
    const e = normalizeEntry(store[sessionId]);
    return e ? e.projectDir : null;
  }

  function saveSessionDirMapping(sessionId, projectDir) {
    if (!sessionId) return;
    const store = readSessionStore();
    const old = normalizeEntry(store[sessionId]);
    const now = new Date().toISOString();
    if (old) {
      old.projectDir = projectDir;
      if (old.createdAt != null) old.updatedAt = now;
      store[sessionId] = old;
    } else {
      store[sessionId] = { projectDir, title: null, createdAt: now, updatedAt: now };
    }
    writeSessionStore(store);
  }

  /** 通知渲染进程会话标题已更新（会话列表实时刷新） */
  function notifyTitleUpdated(sessionId, title) {
    try {
      const win = windowState && windowState.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('session-title-updated', { sessionId, title });
      }
    } catch (_) { /* ignore */ }
  }

  /** 更新会话标题（AI 命名对话）。条目不存在时新建。 */
  function updateSessionTitle(sessionId, title) {
    if (!sessionId || !title) return false;
    const t = String(title).trim();
    if (!t) return false;
    const store = readSessionStore();
    const old = normalizeEntry(store[sessionId]);
    const now = new Date().toISOString();
    if (old) {
      old.title = t;
      if (old.createdAt != null) old.updatedAt = now;
      store[sessionId] = old;
    } else {
      store[sessionId] = { projectDir: state.selectedProjectDir || null, title: t, createdAt: now, updatedAt: now };
    }
    writeSessionStore(store);
    notifyTitleUpdated(sessionId, t);
    return true;
  }

  /**
   * 设置当前会话标题。若尚无会话 ID（新对话首条消息还没生成 URL），先暂存，
   * 等会话 ID 出现后由 handleUrlChange 自动绑定。
   */
  function setSessionTitle(title) {
    const t = String(title || '').trim();
    if (!t) return { success: false, error: '标题为空' };
    if (state.currentSessionId) {
      updateSessionTitle(state.currentSessionId, t);
      return { success: true, sessionId: state.currentSessionId };
    }
    state.pendingTitle = t;
    console.log('[LingYa][' + profileId + '] 暂存对话标题，等待会话ID出现后绑定: ' + t);
    return { success: true, pending: true };
  }

  function extractSessionIdFromUrl(url) {
    if (!url) return null;
    // 平台差异全部下沉到 provider.extractSessionId
    try {
      const provider = getProviderByUrl(url);
      if (provider && typeof provider.extractSessionId === 'function') {
        return provider.extractSessionId(url);
      }
    } catch (_) { /* provider 异常时返回 null */ }
    return null;
  }

  const state = {
    currentSessionId: null,
    selectedProjectDir: null,
    pendingProjectDir: null,
    pendingTitle: null,
  };

  function handleUrlChange(url, targetWindow) {
    const sessionId = extractSessionIdFromUrl(url);
    const win = targetWindow || (windowState && windowState.getMainWindow());

    if (sessionId) {
      state.currentSessionId = sessionId;
      console.log('[LingYa][' + profileId + '] 当前会话ID: ' + sessionId);

      // 会话 ID 出现 → 把临时待办（pending:<profileId>）迁移到真实 sessionId 键
      try {
        require('../../tools/TodoWriteTool').migratePendingTodos(sessionId, profileId);
      } catch (_) { /* 尽力而为 */ }

      if (state.pendingProjectDir) {
        saveSessionDirMapping(sessionId, state.pendingProjectDir);
        state.selectedProjectDir = state.pendingProjectDir;
        state.pendingProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', state.selectedProjectDir);
        }
        console.log('[LingYa][' + profileId + '] 暂存目录已绑定');
        return;
      }

      // 暂存标题（AI 命名在会话 ID 出现前调用）→ 绑定
      if (state.pendingTitle) {
        updateSessionTitle(sessionId, state.pendingTitle);
        console.log('[LingYa][' + profileId + '] 暂存标题已绑定: ' + state.pendingTitle);
        state.pendingTitle = null;
      }

      const restoredDir = getProjectDirBySessionId(sessionId);
      if (restoredDir) {
        state.selectedProjectDir = restoredDir;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', restoredDir);
        }
      } else {
        state.selectedProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', null);
        }
      }
    } else {
      // 提取不到会话 ID（如 ChatGPT 首页 https://chatgpt.com/）：
      // 若有暂存目录（刚初始化但还没绑定会话），保留目录；否则清空（恢复原行为）。
      state.currentSessionId = null;
      if (!state.pendingProjectDir) {
        state.selectedProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', null);
        }
      }
    }
  }

  function tryRestoreSessionFromUrl(targetWindow) {
    const win = targetWindow || (windowState && windowState.getMainWindow());
    if (!win || win.isDestroyed()) return;
    const url = win.webContents.getURL();
    handleUrlChange(url, win);
  }

  return {
    readSessionStore,
    writeSessionStore,
    normalizeEntry,
    getProjectDirBySessionId,
    saveSessionDirMapping,
    updateSessionTitle,
    setSessionTitle,
    extractSessionIdFromUrl,
    handleUrlChange,
    tryRestoreSessionFromUrl,
    state,
  };
}

module.exports = { createSessionStore };
