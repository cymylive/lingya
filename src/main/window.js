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
  windows.set(win.id, { win, rawWin, view: view || null, profileId, providerId, sessionStore });
  lastActiveWindowId = win.id;
  win.on('closed', () => {
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

function removeWindow(windowId) {
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
  for (const ctx of windows.values()) {
    // 1) 真实壳窗口（Proxy 的 target）—— 壳页面 IPC 走这里
    if (ctx.rawWin && ctx.rawWin.webContents === webContents) return ctx;
    // 2) Proxy 的 .webContents（= AI view）
    if (ctx.win && ctx.win.webContents === webContents) return ctx;
    // 3) AI 视图直接匹配
    if (ctx.view && ctx.view.webContents === webContents) return ctx;
  }
  return null;
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

function getWindowByProfileId(profileId) {
  for (const ctx of windows.values()) {
    if (ctx.profileId === profileId) return ctx;
  }
  return null;
}

module.exports = {
  addWindow,
  setWindowView,
  removeWindow,
  getWindowContext,
  getContextByWebContents,
  getView,
  getViewWebContents,
  getMainWindow,
  getMainContext,
  setMainWindow,
  getAllWindows,
  getAllContexts,
  getWindowByProfileId,
};
