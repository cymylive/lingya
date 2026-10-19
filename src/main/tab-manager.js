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

  // ===== 渲染进程崩溃 / 无响应监听 =====
  // 页面进程崩溃（OOM、原生模块段错误、Chrome 内部错误）时，默认表现是标签变白，
  // 用户不知道发生了什么，preload 里的工具执行链也随之消失（任务静默死亡）。
  // 这里做两件事：记录原因 + 自动重载（配合 preload 的状态机持久化，能接着跑）。
  try {
    view.webContents.on('render-process-gone', (_e, details) => {
      const reason = (details && details.reason) || 'unknown';
      const code = (details && details.exitCode) != null ? details.exitCode : '?';
      console.error('[LingYa Tab] 渲染进程崩溃: reason=' + reason + ' exitCode=' + code +
        ' tab=' + tabId + ' url=' + (tab.url || ''));
      try {
        require('./global-guard').record('render-process-gone',
          new Error('tab=' + tabId + ' reason=' + reason + ' exitCode=' + code + ' url=' + (tab.url || '')),
          false);
      } catch (_) {}
      // 用户主动关闭 / 标签已不存在：不重载
      if (reason === 'clean-exit' || !tabs.has(tabId)) return;
      // 延迟 800ms 重载，避免崩溃后立刻重载又被同样的页面内容搞崩（崩溃循环）
      setTimeout(() => {
        try {
          if (!tabs.has(tabId) || view.webContents.isDestroyed()) return;
          console.log('[LingYa Tab] 自动重载崩溃标签: ' + tabId);
          view.webContents.reload();
        } catch (e) {
          console.error('[LingYa Tab] 自动重载失败:', e && e.message);
        }
      }, 800);
    });
  } catch (_) { /* 旧版本 Electron 可能不支持该事件 */ }

  // 无响应（页面卡死但未崩溃）：只记录，不强制重载（用户可能只是页面在跑重活）
  try {
    view.webContents.on('unresponsive', () => {
      console.warn('[LingYa Tab] 页面无响应: tab=' + tabId + ' url=' + (tab.url || ''));
      try {
        require('./global-guard').record('unresponsive',
          new Error('tab=' + tabId + ' url=' + (tab.url || '')), false);
      } catch (_) {}
    });
    view.webContents.on('responsive', () => {
      console.log('[LingYa Tab] 页面已恢复响应: tab=' + tabId);
    });
  } catch (_) {}

  // 标题跟随网页 title（主标签除外：主标签用 LingYa 对话名，由 session-store 驱动）
  view.webContents.on('page-title-updated', (_e, title) => {
    try {
      if (tab.isMain) return;
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

  // ===== 拦截 window.open / target=_blank → 转为当前窗口的新标签 =====
  // 不拦的话 Electron 默认会弹独立 BrowserWindow（如百度「更多」点出来的是新窗口）
  try {
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      try {
        if (!targetUrl || targetUrl === 'about:blank') {
          // 有些站点先 window.open('') 再 document.write，这种没法转标签，直接拒绝
          console.log('[LingYa Tab] 拒绝 about:blank 弹窗');
          return { action: 'deny' };
        }
        console.log('[LingYa Tab] window.open 拦截 → 开新标签: ' + targetUrl);
        // 在当前窗口开新标签（复用同一个 ctx / profileData）
        createTab(ctx, {
          url: targetUrl,
          profileData: o.profileData,
          userDataDir: o.userDataDir,
          activate: true,
        });
      } catch (e) {
        console.error('[LingYa Tab] 转新标签失败:', e && e.message);
      }
      return { action: 'deny' };  // 阻止 Electron 弹独立窗口
    });
  } catch (e) {
    console.error('[LingYa Tab] setWindowOpenHandler 注册失败:', e && e.message);
  }

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

/** 设置主标签标题（LingYa 对话名） */
function setMainTabTitle(ctx, title) {
  if (!ctx || !ctx.tabs) return;
  for (const t of ctx.tabs.values()) {
    if (t.isMain) {
      t.title = String(title || 'LingYa').slice(0, 60);
      if (ctx.onTabUpdated) ctx.onTabUpdated(t.id);
      return;
    }
  }
}

module.exports = { createTab, switchTab, closeTab, listTabs, navigate, setMainTabTitle };
