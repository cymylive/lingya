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

  /** 兼容旧数据：把 store[id] 归一化为对象 { projectDir, title, createdAt, updatedAt, archivedAt } */
  function normalizeEntry(entry) {
    if (entry == null) return null;
    if (typeof entry === 'string') return { projectDir: entry, title: null, createdAt: null, updatedAt: null, archivedAt: null };
    if (typeof entry === 'object') return {
      projectDir: entry.projectDir != null ? entry.projectDir : null,
      title: entry.title || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
      // 归档时间戳（ISO 字符串）；null/undefined = 未归档
      archivedAt: entry.archivedAt || null,
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

  /**
   * 通知渲染进程会话标题已更新（会话列表实时刷新）。
   * 广播给所有窗口：改名入口在壳窗口（侧栏），会话列表在 AI 视图，
   * 只发给主窗口会漏掉另一个。
   */
  function notifyTitleUpdated(sessionId, title) {
    const payload = { sessionId, title };
    try {
      if (windowState && typeof windowState.getAllContexts === 'function') {
        for (const ctx of windowState.getAllContexts()) {
          // 只处理「当前会话就是这个 sessionId」的窗口：窗口标题 + 页面标题都跟着变
          const st = ctx.sessionStore;
          const isCurrent = !!(st && st.state && st.state.currentSessionId === sessionId);
          if (isCurrent) {
            // 同步 Electron 窗口标题（rawWin 才是真实 BrowserWindow，ctx.win 可能是 Proxy）
            try {
              const w = ctx.rawWin || ctx.win;
              if (w && !w.isDestroyed() && typeof w.setTitle === 'function') {
                w.setTitle('LingYa - ' + title);
              }
            } catch (_) {}
            // 同步顶部主标签标题（横向只显示主标签 = LingYa 对话名）
            try {
              const tm = require('./tab-manager');
              if (tm && tm.setMainTabTitle) tm.setMainTabTitle(ctx, title);
            } catch (_) {}
          }
          // 广播给渲染进程（页内标题同步由 preload 处理）
          try {
            const wc = ctx.win && ctx.win.webContents;
            if (wc && !wc.isDestroyed()) wc.send('session-title-updated', payload);
          } catch (_) {}
          try {
            const raw = ctx.rawWin;
            if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('session-title-updated', payload);
          } catch (_) {}
        }
        return;
      }
      const win = windowState && windowState.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('session-title-updated', payload);
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

  /**
   * 按 sessionId 设置标题（用于会话列表里手动重命名任意对话，不要求该会话是当前会话）。
   * 指定 sessionId 时直接写入该条目；未指定则退回 setSessionTitle（当前会话）。
   */
  function setSessionTitleById(sessionId, title) {
    const t = String(title || '').trim();
    if (!t) return { success: false, error: '标题为空' };
    if (!sessionId) return setSessionTitle(t);
    if (!updateSessionTitle(sessionId, t)) {
      return { success: false, error: '写入会话标题失败' };
    }
    return { success: true, sessionId };
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

  /** 广播会话变化给所有窗口（AI 视图 + 壳窗口），供侧栏/覆盖层刷新计划等 */
  function broadcastSessionChanged(sessionId) {
    try {
      if (!windowState || !windowState.getAllContexts) return;
      for (const ctx of windowState.getAllContexts()) {
        const payload = { sessionId: sessionId || null };
        try { const wc = ctx.win && ctx.win.webContents; if (wc && !wc.isDestroyed()) wc.send('lingya-session-changed', payload); } catch (_) {}
        try { const raw = ctx.rawWin; if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('lingya-session-changed', payload); } catch (_) {}
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * 归档 / 取消归档某个会话。
   * @param {string} sessionId
   * @param {boolean} archived true = 归档，false = 取消归档
   * @returns {{success:boolean, error?:string, archivedAt?:string|null}}
   */
  function setSessionArchived(sessionId, archived) {
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    const store = readSessionStore();
    const old = normalizeEntry(store[sessionId]);
    if (!old) return { success: false, error: '会话不存在' };
    const now = new Date().toISOString();
    old.archivedAt = archived ? now : null;
    store[sessionId] = old;
    writeSessionStore(store);
    notifyArchivedUpdated(sessionId, old.archivedAt);
    return { success: true, archivedAt: old.archivedAt };
  }

  /** 广播归档状态变化（所有窗口的会话列表都要刷新） */
  function notifyArchivedUpdated(sessionId, archivedAt) {
    const payload = { sessionId, archivedAt };
    try {
      if (windowState && typeof windowState.getAllContexts === 'function') {
        for (const ctx of windowState.getAllContexts()) {
          try {
            const wc = ctx.win && ctx.win.webContents;
            if (wc && !wc.isDestroyed()) wc.send('session-archived-updated', payload);
          } catch (_) {}
          try {
            const raw = ctx.rawWin;
            if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('session-archived-updated', payload);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  /** 读取某会话的标题（无则返回 null） */
  function getSessionTitleById(sessionId) {
    if (!sessionId) return null;
    try {
      const store = readSessionStore();
      const e = normalizeEntry(store[sessionId]);
      return (e && e.title) ? e.title : null;
    } catch (_) { return null; }
  }

  /**
   * 把会话标题同步到顶部主标签（LingYa 对话那个）。
   * 切换会话时调用 —— 之前只在「改名」时同步，切会话标题一直是初始值。
   *
   * @param {string} title 新标题
   * @param {object} [targetWin] 目标窗口（Proxy 或 BrowserWindow）。
   *   必须传入，否则会用全局「最近活跃窗口」，导致多窗口时改错窗口的标签。
   */
  function syncMainTabTitle(title, targetWin) {
    try {
      let ctx = null;
      if (targetWin && windowState && typeof windowState.getWindowContext === 'function') {
        // 优先按目标窗口反查上下文（多窗口隔离）
        try { ctx = windowState.getWindowContext(targetWin.id); } catch (_) {}
      }
      // 兜底：没传或不匹配时用主上下文
      if (!ctx && windowState && typeof windowState.getMainContext === 'function') {
        ctx = windowState.getMainContext();
      }
      if (!ctx) return;
      const tm = require('./tab-manager');
      if (tm && typeof tm.setMainTabTitle === 'function') {
        tm.setMainTabTitle(ctx, title || ('LingYa · ' + profileId));
      }
    } catch (_) { /* ignore */ }
  }

  function handleUrlChange(url, targetWindow) {
    const sessionId = extractSessionIdFromUrl(url);
    const win = targetWindow || (windowState && windowState.getMainWindow());

    // 会话变化 → 广播（无论提取到 sessionId 与否，都通知侧栏刷新）
    broadcastSessionChanged(sessionId);

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

      // 同步主标签标题：切到该会话时显示它自己的标题（无标题则显示短 sessionId）
      const restoredTitle = getSessionTitleById(sessionId);
      syncMainTabTitle(restoredTitle || ('会话 ' + String(sessionId).slice(0, 8)), win);
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
      // 新会话（还没生成 URL）→ 主标签显示「新对话」
      syncMainTabTitle('新对话', win);
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
    setSessionTitleById,
    setSessionArchived,
    getSessionTitleById,
    syncMainTabTitle,
    extractSessionIdFromUrl,
    handleUrlChange,
    tryRestoreSessionFromUrl,
    state,
  };
}

module.exports = { createSessionStore };
