/**
 * 标签页管理（每个窗口内多个 WebContentsView，同时只显示一个）
 *
 * 结构：
 *   BrowserWindow（壳）→ shell.html（侧栏 + 标签栏 + 地址栏）
 *                      → WebContentsView × N（每个是一个标签）
 *
 * 只有一个 tab 是 active（可见），其余 setVisible(false) 隐藏。
 * ctx.view 始终指向 active tab 的 view，保证 85 处旧代码（ctx.win.webContents）继续工作。
 */
const path = require('path');
const { WebContentsView } = require('electron');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const AI_PRELOAD = path.join(__dirname, '..', '..', 'preload.js');

let _nextTabId = 1;

/**
 * 给窗口创建一个新标签
 * @param {object} ctx windowState 的窗口上下文（含 rawWin / tabs / activeTabId）
 * @param {object} opts { url, profileData, userDataDir, activate }
 */
function createTab(ctx, opts) {
  const { rawWin, tabs } = ctx;
  if (!rawWin || rawWin.isDestroyed()) throw new Error('窗口已销毁');
  const o = opts || {};
  const profileData = o.profileData || {};

  const view = new WebContentsView({
    webPreferences: {
      preload: AI_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: profileData.partition,
      backgroundThrottling: false,
      additionalArguments: ['--lingya-user-data=' + (o.userDataDir || '')],
    },
  });
  view.webContents.setUserAgent(USER_AGENT);

  const tabId = 'tab-' + (_nextTabId++);
  const tab = {
    id: tabId,
    view,
    title: '新标签',
    url: o.url || '',
    createdAt: Date.now(),
    // 是否为主标签（第一个，承载 AI 平台）
    isMain: false,
  };
  tabs.set(tabId, tab);

  // 忽略 beforeunload（工具打开的标签要能随时关）
  try {
    view.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  } catch (_) {}

  // 标题跟随网页 title
  view.webContents.on('page-title-updated', (_e, title) => {
    try {
      tab.title = String(title || '').slice(0, 60) || '未命名';
      if (ctx.onTabUpdated) ctx.onTabUpdated(tabId);
    } catch (_) {}
  });

  // URL 变化 → 通知壳页面刷新地址栏
  const onNav = (_e, url) => {
    try {
      tab.url = url;
      if (ctx.onTabUpdated) ctx.onTabUpdated(tabId);
    } catch (_) {}
  };
  view.webContents.on('did-navigate', onNav);
  view.webContents.on('did-navigate-in-page', onNav);

  // 加载
  if (o.url) {
    try { view.webContents.loadURL(o.url); } catch (_) {}
  }

  // 挂载 + 默认隐藏（除非要求激活）
  rawWin.contentView.addChildView(view);
  try { view.setVisible(false); } catch (_) {}

  if (o.activate !== false) {
    switchTab(ctx, tabId);
  }
  if (ctx.onTabUpdated) ctx.onTabUpdated(tabId);
  return tab;
}

/** 切换活动标签 */
function switchTab(ctx, tabId) {
  const { tabs, rawWin } = ctx;
  const tab = tabs.get(tabId);
  if (!tab) return { success: false, error: '标签不存在' };
  for (const [id, t] of tabs) {
    try { t.view.setVisible(id === tabId); } catch (_) {}
  }
  ctx.activeTabId = tabId;
  // 更新 ctx.view 别名（window.js 存的字段）
  ctx.view = tab.view;
  // 重排
  if (ctx.relayout) ctx.relayout();
  if (ctx.onTabUpdated) ctx.onTabUpdated(tabId);
  return { success: true, tabId };
}

/** 关闭标签 */
function closeTab(ctx, tabId) {
  const { tabs, rawWin } = ctx;
  const tab = tabs.get(tabId);
  if (!tab) return { success: false, error: '标签不存在' };
  if (tabs.size <= 1) return { success: false, error: '至少保留一个标签' };
  if (tab.isMain) return { success: false, error: '主标签不可关闭' };

  try { rawWin.contentView.removeChildView(tab.view); } catch (_) {}
  try { tab.view.webContents.close(); } catch (_) {}
  tabs.delete(tabId);

  if (ctx.activeTabId === tabId) {
    const first = tabs.keys().next().value;
    if (first) switchTab(ctx, first);
  }
  if (ctx.onTabUpdated) ctx.onTabUpdated(null);
  return { success: true };
}

/** 列出所有标签（供壳页面渲染） */
function listTabs(ctx) {
  const out = [];
  for (const [id, t] of ctx.tabs) {
    out.push({ id, title: t.title, url: t.url, isMain: !!t.isMain, active: id === ctx.activeTabId });
  }
  return out;
}

/** 导航活动标签（或指定标签） */
function navigate(ctx, url, tabId) {
  const id = tabId || ctx.activeTabId;
  const tab = ctx.tabs.get(id);
  if (!tab) return { success: false, error: '标签不存在' };
  try {
    tab.view.webContents.loadURL(url);
    tab.url = url;
    if (ctx.onTabUpdated) ctx.onTabUpdated(id);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { createTab, switchTab, closeTab, listTabs, navigate };
