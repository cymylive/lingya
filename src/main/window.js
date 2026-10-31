/**
 * 窗口管理（多窗口 + 每窗口 profile 上下文）
 * 每个窗口关联一个 profileId，拥有独立的 sessionStore 实例。
 *
 * 架构（0.6.29 起）：每个逻辑窗口 = BrowserWindow（壳，含左侧栏）+ WebContentsView（AI 网页）
 *  - ctx.win  : BrowserWindow（壳页面，承载侧栏 UI）
 *  - ctx.view : WebContentsView（AI 网页，承载注入的覆盖层 + 工具执行）
 *
 * 兼容：旧代码用 ctx.win.webContents 操作 AI 页面 —— 已迁移为 ctx.view.webContents。
 * getContextByWebContents 同时匹配两者，故 IPC 从任一来源都能定位上下文。
 */
const windows = new Map(); // windowId -> { win, view, profileId, providerId, sessionStore }
let lastActiveWindowId = null;

/**
 * 视图归属表：webContents -> 拥有它的原始 ctx。
 * 窗口合并会把视图从原窗口搬到宿主窗口，源窗口随即销毁、ctx 从 windows 移除；
 * 若只靠 windows 遍历查找，合并后的视图就查不到自己的 profile / sessionStore，
 * 工具结果回传、会话写入全部失败。这里做一层「视图 → 原 ctx」的持久登记。
 */
const viewOwners = new WeakMap();

/** 登记视图归属（合并前调用，记住它属于哪个原始窗口上下文） */
function rememberViewOwner(webContents, ctx) {
  if (!webContents || !ctx) return null;
  viewOwners.set(webContents, ctx);
  return ctx;
}

/** 清除视图归属（拆分回独立窗口后重新登记时会覆盖，窗口彻底关闭时调用） */
function forgetViewOwner(webContents) {
  if (!webContents) return null;
  viewOwners.delete(webContents);
  return null;
}

/**
 * @param {BrowserWindow} win 壳窗口
 * @param {object} profileId
 * @param {object} providerId
 * @param {object} sessionStore
 * @param {WebContentsView|null} view AI 网页视图（可为 null，如平台选择页阶段）
 */
function addWindow(win, profileId, providerId, sessionStore, view) {
  // win 可能是 Proxy（其 .webContents 被重定向到 AI view）。
  // rawWin 保存真实 BrowserWindow —— 壳页面 IPC（侧栏/文件树）需用它反查上下文。
  const rawWin = (win && win.__rawWindow) ? win.__rawWindow : win;
  // tabs / activeTabId 由 tab-manager 维护；view 始终指向当前 active tab 的 view
  windows.set(win.id, {
    win, rawWin,
    view: view || null,
    attachedViews: [],
    splitDirection: null,
    tabs: new Map(),
    activeTabId: null,
    profileId, providerId, sessionStore,
  });
  lastActiveWindowId = win.id;
  console.log('[window] addWindow: id=' + win.id + ' profileId=' + profileId + ' providerId=' + providerId + '，当前共 ' + windows.size + ' 个');
  win.on('closed', () => {
    console.log('[window] closed 事件触发: id=' + win.id + ' profileId=' + profileId);
    windows.delete(win.id);
    if (lastActiveWindowId === win.id) {
      const remaining = Array.from(windows.keys());
      lastActiveWindowId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  });
}

/** 窗口创建后挂载 AI 视图（先 addWindow 再挂 view 的场景） */
function setWindowView(windowId, view) {
  const ctx = windows.get(windowId);
  if (ctx) ctx.view = view || null;
}

/**
 * 挂载来自其它窗口的视图（窗口合并场景）
 * 视图本身仍属于它原来的 profile/sessionStore（由其原始 ctx 维护），
 * 这里只登记“它现在显示在这个窗口里”，供 IPC 反查用。
 * @returns {object|null} 挂载成功返回 ctx，窗口不存在返回 null
 */
function addAttachedView(windowId, panel) {
  const ctx = windows.get(windowId);
  if (!ctx) return null;
  if (!ctx.attachedViews) ctx.attachedViews = [];
  // panel = { view, sidebarView, sidebarOpen, sidebarWidth }
  if (panel && panel.view && !ctx.attachedViews.find(p => p.view === panel.view)) {
    ctx.attachedViews.push(panel);
  }
  return ctx;
}

/** 解除附加视图挂载（拆分或窗口关闭时调用） */
function clearAttachedView(windowId) {
  const ctx = windows.get(windowId);
  if (!ctx) return null;
  ctx.attachedViews = [];
  ctx.splitDirection = null;
  return ctx;
}

/** 移除单个附加视图（拆分指定窗口时调用） */
function removeAttachedView(windowId, view) {
  const ctx = windows.get(windowId);
  if (!ctx || !ctx.attachedViews) return null;
  const idx = ctx.attachedViews.findIndex(p => p.view === view);
  if (idx >= 0) ctx.attachedViews.splice(idx, 1);
  if (ctx.attachedViews.length === 0) ctx.splitDirection = null;
  return ctx;
}

function removeWindow(windowId) {
  console.log('[window] removeWindow: id=' + windowId + '，删前 ' + windows.size + ' 个');
  windows.delete(windowId);
  if (lastActiveWindowId === windowId) {
    const remaining = Array.from(windows.keys());
    lastActiveWindowId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
}

function getWindowContext(windowId) {
  return windows.get(windowId) || null;
}

/** 按 webContents 找上下文：同时匹配壳窗口与 AI 视图（IPC 来源可能是任一） */
function getContextByWebContents(webContents) {
  if (!webContents) return null;
  // 0) 视图归属表优先（合并后源窗口已销毁，只能靠这里找回原上下文）
  const owner = viewOwners.get(webContents);
  if (owner) return owner;
  for (const ctx of windows.values()) {
    // 1) 真实壳窗口（Proxy 的 target）—— 壳页面 IPC 走这里
    if (ctx.rawWin && ctx.rawWin.webContents === webContents) return ctx;
    // 2) Proxy 的 .webContents（= AI view）
    if (ctx.win && ctx.win.webContents === webContents) return ctx;
    // 3) AI 视图直接匹配
    if (ctx.view && ctx.view.webContents === webContents) return ctx;
    // 4) 任意 tab 的视图匹配（多标签场景）
    if (ctx.tabs && ctx.tabs.size) {
      for (const t of ctx.tabs.values()) {
        if (t.view && t.view.webContents === webContents) return ctx;
      }
    }

  }
  return null;
}

/** 按 webContents 精确定位到 tab（返回 { ctx, tab }，找不到 tab 时 tab 为 null） */
function getTabByWebContents(webContents) {
  if (!webContents) return { ctx: null, tab: null };
  for (const ctx of windows.values()) {
    if (ctx.tabs && ctx.tabs.size) {
      for (const t of ctx.tabs.values()) {
        if (t.view && t.view.webContents === webContents) return { ctx, tab: t };
      }
    }
  }
  const ctx = getContextByWebContents(webContents);
  return { ctx, tab: null };
}

/** 取某上下文对应的 AI 视图（旧代码用 ctx.win.webContents 的地方改用此） */
function getView(ctx) {
  return ctx ? ctx.view : null;
}

/** 取 AI 视图的 webContents（工具结果回传、session 操作等都走它） */
function getViewWebContents(ctx) {
  return (ctx && ctx.view && !ctx.view.webContents.isDestroyed()) ? ctx.view.webContents : null;
}

function getMainWindow() {
  if (!lastActiveWindowId) return null;
  const ctx = windows.get(lastActiveWindowId);
  return ctx ? ctx.win : null;
}

function getMainContext() {
  if (!lastActiveWindowId) return null;
  return windows.get(lastActiveWindowId) || null;
}

function setMainWindow(win) {
  if (win) {
    lastActiveWindowId = win.id;
  } else {
    lastActiveWindowId = null;
  }
}

function getAllWindows() {
  return Array.from(windows.values()).map(ctx => ctx.win);
}

function getAllContexts() {
  return Array.from(windows.values());
}

// ===== 【2026-10-30】「全部分屏」总控台变更广播（100ms 节流）=====
// 触发源：todo 变化 / 工具开始结束 / AI 生成状态变化。
// 为什么要节流：AI 一轮任务可能连续调十几个工具，每次都广播会让侧边栏
// 反复拉全量数据。100ms 内的多次变化合并成一次，肉眼仍是实时的。
let __allTodosTimer = null;
function broadcastAllTodosChanged() {
  if (__allTodosTimer) return;
  __allTodosTimer = setTimeout(() => {
    __allTodosTimer = null;
    for (const c of windows.values()) {
      try {
        const raw = c.rawWin;
        if (raw && !raw.isDestroyed() && raw.webContents && !raw.webContents.isDestroyed()) {
          raw.webContents.send('lingya-all-todos-changed');
        }
      } catch (_) { /* 单窗口失败不影响其他 */ }
    }
  }, 100);
}

function getWindowByProfileId(profileId) {
  for (const ctx of windows.values()) {
    if (ctx.profileId === profileId) return ctx;
  }
  return null;
}

// 主进程退出前清理节流定时器，防止延迟退出 100ms
function clearBroadcastTimer() {
  if (__allTodosTimer) {
    try { clearTimeout(__allTodosTimer); } catch (_) {}
    __allTodosTimer = null;
  }
}

module.exports = {
  clearBroadcastTimer,
  addWindow,
  setWindowView,
  addAttachedView,
  clearAttachedView,
  removeAttachedView,
  rememberViewOwner,
  forgetViewOwner,
  removeWindow,
  getWindowContext,
  getContextByWebContents,
  getTabByWebContents,
  getView,
  getViewWebContents,
  getMainWindow,
  getMainContext,
  setMainWindow,
  getAllWindows,
  getAllContexts,
  getWindowByProfileId,
  broadcastAllTodosChanged,
};
