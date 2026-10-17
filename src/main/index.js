/**
 * LingYa 主进程入口（多窗口多 profile 版）
 * 由项目根目录 main.js 薄壳加载。
 */
const { app, BrowserWindow, Menu, dialog, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const windowState = require('./window');
const profileManager = require('./profile-manager');
const { createSessionStore } = require('./session-store');
const { getProvider } = require('../providers');
const updater = require('./updater');
const tray = require('./tray');

// ========== 数据目录解析（便携优先）==========
// 见 data-dir.js：便携版数据与程序同目录，换电脑/搬目录配置不丢。
const { resolveDataDir, resolveInstanceDir } = require('./data-dir');
const SESSION_DIR = process.env.LINGYA_SESSION_DIR || 'lingya-ai-pro-session';
const dataDirInfo = resolveDataDir({
  appDataPath: app.getPath('appData'),
  execPath: process.execPath,
  env: process.env,
  fs,
  sessionDir: SESSION_DIR,
});
const USER_DATA_DIR = dataDirInfo.dir;

// ========== 多实例支持 ==========
// 默认允许多开：第二及后续实例自动使用隔离数据目录，互不干扰。
//   - 第一个实例：用基础数据目录（保留既有配置）
//   - 第二及后续：自动隔离到 <数据目录>/instances/auto-<pid>
//   - 具名实例：设 LINGYA_INSTANCE=<名> -> <数据目录>/instances/<名>（固定，配置可持久）
//   - 恢复单实例：设 LINGYA_SINGLE=1（第二次启动直接退出）
//
// 顺序要点：先 setPath 到基础目录，让单实例锁基于真实数据目录，
// 再请求锁；拿到锁用基础目录，没拿到则切到隔离目录。
const _forceSingle = process.env.LINGYA_SINGLE === '1';
const _namedInstance = resolveInstanceDir(USER_DATA_DIR, process.env);

// 基础目录必须先存在（setPath 要求）
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
} catch (err) {
  console.error('[LingYa] 创建基础数据目录失败:', err.message);
}
app.setPath('userData', USER_DATA_DIR);

let EFFECTIVE_USER_DATA_DIR = USER_DATA_DIR;
let _shouldQuit = false;
let _isolatedInstance = false;

if (_namedInstance) {
  EFFECTIVE_USER_DATA_DIR = _namedInstance;
  _isolatedInstance = true;
} else {
  const _gotLock = app.requestSingleInstanceLock();
  if (!_gotLock) {
    if (_forceSingle) {
      _shouldQuit = true;
    } else {
      EFFECTIVE_USER_DATA_DIR = path.join(USER_DATA_DIR, 'instances', 'auto-' + process.pid);
      _isolatedInstance = true;
    }
  }
}

// 单实例模式且未拿到锁：直接退出，跳过后续所有初始化（审计优化，避免无用 init）
if (_shouldQuit) {
  app.quit();
  return;
}

if (dataDirInfo.migrated) {
  console.log('[LingYa] 已将旧数据从 ' + dataDirInfo.legacyDir + ' 迁移到便携目录');
}

// 启动时清理过期的自动隔离实例目录（>7 天），避免 instances/auto-* 无限累积
try {
  const cleaned = require("./data-dir").cleanStaleInstances(USER_DATA_DIR, 7 * 24 * 60 * 60 * 1000, fs);
  if (cleaned > 0) console.log("[LingYa] 已清理 " + cleaned + " 个过期隔离实例目录");
} catch (_) {}

// 隔离实例：把 userData 切到隔离目录
try {
  fs.mkdirSync(EFFECTIVE_USER_DATA_DIR, { recursive: true });
} catch (err) {
  console.error('[LingYa] 创建 userData 目录失败:', err.message);
}
app.setPath('userData', EFFECTIVE_USER_DATA_DIR);
console.log('[LingYa] 数据目录:', app.getPath('userData') + (dataDirInfo.portable ? '（便携模式）' : ''));

// 初始化记忆存储（全局共享）
try {
  require('./memory-store').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化记忆存储失败:', err.message);
}

// 初始化技能存储（全局共享）
try {
  require('./skill-store').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化技能存储失败:', err.message);
}

// 初始化飞书配置存储（全局共享）
try {
  require('../feishu/config').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化飞书配置存储失败:', err.message);
}

// 初始化安全增强配置存储（CTF 注入 + 拒绝拦截）
try {
  require('./security-store').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化安全配置存储失败:', err.message);
}

// 初始化 Agent 状态存储（Plan / Build 模式，per-profile）
try {
  require('./agent-store').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化 Agent 存储失败:', err.message);
}

// 初始化定时任务存储（全局共享）
try {
  require('./schedule-store').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化定时任务存储失败:', err.message);
}

// 初始化待办存储（按会话隔离，持久化到 lingya-todos.json）
try {
  require('../../tools/TodoWriteTool').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化待办存储失败:', err.message);
}

// 初始化插件系统（状态存储 + 宿主）
// 注意：必须在 registerIpcHandlers() 之前加载，否则插件贡献的工具不会进入 IPC 可达范围
try {
  const pluginStore = require('./plugin-store');
  const pluginHost = require('./plugin-host');
  pluginStore.init(app.getPath('userData'));
  pluginHost.init(app.getPath('userData'));
  Promise.resolve(pluginHost.loadAllEnabled()).catch((e) => console.error('[LingYa] 加载插件失败:', e.message));
  pluginHost.startWatching();
} catch (err) {
  console.error('[LingYa] 初始化插件系统失败:', err.message);
}

// 初始化 DSH 兼容层（异步加载已启用的 dsh 插件）
// 宿主能力在 registerIpcHandlers 之后可用；这里先 init，稍后 loadEnabledPlugins
let _dshInitPromise = null;
try {
  const dsh = require('./dsh');
  const { toolRegistry } = require('./tool-registry');
  const memoryStore = require('./memory-store');
  const skillStore = require('./skill-store');
  const windowState = require('./window');
  dsh.init(app.getPath('userData'), {
    toolRegistry,
    onToolsChanged: () => {
      // 广播工具集变化（复用插件系统的事件名）
      try {
        for (const ctx of windowState.getAllContexts()) {
          try { const wc = ctx.win && ctx.win.webContents; if (wc && !wc.isDestroyed()) wc.send('lingya-tools-changed'); } catch (_) {}
          try { const raw = ctx.rawWin; if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('lingya-tools-changed'); } catch (_) {}
        }
      } catch (_) {}
    },
    host: {
      getToolNames: () => toolRegistry.listNames(),
      getPluginConfig: (id) => { try { return memoryStore.getPluginConfig ? memoryStore.getPluginConfig('dsh:' + id) : {}; } catch (_) { return {}; } },
      setPluginConfig: (id, v) => { try { return memoryStore.setPluginConfig ? memoryStore.setPluginConfig('dsh:' + id, v) : false; } catch (_) { return false; } },
      getCurrentSession: () => {
        try {
          const ctx = windowState.getMainContext();
          const st = ctx && ctx.sessionStore;
          return { id: (st && st.state.currentSessionId) || null, projectDir: (st && st.state.selectedProjectDir) || null };
        } catch (_) { return { id: null, projectDir: null }; }
      },
      listSessions: () => {
        try {
          const ctx = windowState.getMainContext();
          const st = ctx && ctx.sessionStore;
          if (!st) return [];
          const all = st.readSessionStore();
          return Object.keys(all).map((id) => ({ id, title: (st.normalizeEntry ? st.normalizeEntry(all[id]) : all[id]).title }));
        } catch (_) { return []; }
      },
      getSession: (id) => {
        try {
          const ctx = windowState.getMainContext();
          const st = ctx && ctx.sessionStore;
          if (!st) return null;
          const all = st.readSessionStore();
          const e = all[id] ? (st.normalizeEntry ? st.normalizeEntry(all[id]) : all[id]) : null;
          return e ? { id, title: e.title } : null;
        } catch (_) { return null; }
      },
      getSessionTitle: () => {
        try { const ctx = windowState.getMainContext(); return (ctx && ctx.sessionStore && ctx.sessionStore.state.currentSessionId) || null; } catch (_) { return null; }
      },
      setSessionTitle: (t) => {
        try { const ctx = windowState.getMainContext(); return !!(ctx && ctx.sessionStore && ctx.sessionStore.setSessionTitle(t).success); } catch (_) { return false; }
      },
    },
  });
  _dshInitPromise = dsh.loadEnabledPlugins().catch((e) => console.error('[DSH] 加载已启用插件失败:', e.message));
} catch (err) {
  console.error('[LingYa] 初始化 DSH 兼容层失败:', err.message);
}

// 渲染进程日志输出目录（仅开发环境持久化；打包版不写日志文件）
const RENDERER_LOG_DIR = app.isPackaged
  ? null
  : path.join(app.getPath('userData'), 'wyp', 'log');
if (RENDERER_LOG_DIR) {
  fs.mkdirSync(RENDERER_LOG_DIR, { recursive: true });
  // 开发环境每次启动清空平台日志，避免无限累积（与 start.js 清空 electron.log 一致）
  try {
    for (const f of fs.readdirSync(RENDERER_LOG_DIR)) {
      if (f.endsWith('.log')) fs.writeFileSync(path.join(RENDERER_LOG_DIR, f), '', 'utf-8');
    }
  } catch (err) {
    console.warn('[LingYa] 清空平台日志失败:', err.message);
  }
}

const { registerIpcHandlers } = require('./ipc');

// 退出前需要 flush 的 sessions
const sessionsToFlush = new Set();

async function flushAllSessions() {
  const promises = [];
  for (const ses of sessionsToFlush) {
    promises.push(ses.flushStorageData().catch(err => {
      console.error('[LingYa] 刷新 session 失败:', err.message);
    }));
  }
  await Promise.all(promises);
  console.log('[LingYa] 全部 session 数据已刷新到磁盘');
}

/**
 * 创建窗口（绑定指定 profile）
 * @param {object|null} profile profile 对象，null 则使用默认 profile
 */
function createWindow(profile) {
  const profileData = profile || profileManager.getDefaultProfile();
  const provider = getProvider(profileData.providerId || 'deepseek') || getProvider('deepseek');
  const storeDir = app.getPath('userData');
  const sessionStore = createSessionStore(profileData.id, storeDir, windowState);
  const providerChosen = !!profileData.providerId;

  const savedBounds = profileData.windowBounds;
  const winOptions = {
    width: (savedBounds && savedBounds.width) || 1280,
    height: (savedBounds && savedBounds.height) || 900,
    title: 'LingYa Pro - ' + provider.name + ' - ' + profileData.name,
    webPreferences: {
      // 壳页面 preload（只服务左侧栏）
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--lingya-user-data=' + app.getPath('userData')],
    },
  };
  if (savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)) {
    winOptions.x = savedBounds.x;
    winOptions.y = savedBounds.y;
  }
  const iconCandidates = [
    path.join(process.resourcesPath || '', 'assets', 'icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  ];
  for (const p of iconCandidates) {
    if (p && fs.existsSync(p)) { winOptions.icon = p; break; }
  }

  const mainWindow = new BrowserWindow(winOptions);
  mainWindow.__sidebarOpen = false;

  // 阻止壳页面 <title> 覆盖窗口标题（Electron 默认 page-title-updated 会改窗口标题）
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  // 用自定义标题
  try { mainWindow.setTitle('LingYa Pro - ' + provider.name + ' - ' + profileData.name); } catch (_) {}

  // ===== 兼容代理（先建，供 tab-manager 回调时用）=====
  // webContents / loadURL / loadFile 动态指向「当前活动标签」的 view，
  // 保证 85 处旧代码（ctx.win.webContents.send/getURL/loadURL）在多标签下仍正确。
  const winProxy = new Proxy(mainWindow, {
    get(target, prop) {
      const ctx = windowState.getWindowContext(target.id);
      const activeTab = ctx && ctx.tabs ? ctx.tabs.get(ctx.activeTabId) : null;
      const activeView = activeTab ? activeTab.view : (target.__aiView || null);
      if (prop === '__rawWindow') return target;
      if (prop === '__aiView') return activeView;
      if (prop === 'webContents') return activeView ? activeView.webContents : null;
      if (prop === 'loadURL') return (url, opts) => activeView ? activeView.webContents.loadURL(url, opts) : Promise.reject(new Error('无活动标签'));
      if (prop === 'loadFile') return (f, opts) => activeView ? activeView.webContents.loadFile(f, opts) : Promise.reject(new Error('无活动标签'));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  // 先注册窗口上下文（此时 tabs 为空，稍后由 createTab 填充）
  windowState.addWindow(winProxy, profileData.id, profileData.providerId || '', sessionStore, null);
  windowState.setMainWindow(winProxy);

  // 布局：所有标签共享同一区域（顶部让出标签栏，只有 active 可见）
  const layout = () => {
    try {
      const ctx = windowState.getWindowContext(mainWindow.id);
      if (!ctx || !ctx.tabs) return;
      const b = mainWindow.getContentBounds();
      const sw = currentSidebarWidth(mainWindow);
      const top = TABBAR_HEIGHT;
      const w = Math.max(0, b.width - sw);
      const h = Math.max(0, b.height - top);
      for (const t of ctx.tabs.values()) {
        try { t.view.setBounds({ x: sw, y: top, width: w, height: h }); } catch (_) {}
      }
    } catch (err) { /* ignore */ }
  };
  mainWindow.on('resize', layout);

  // ===== 创建第一个（主）标签承载 AI 平台 =====
  const tabManager = require('./tab-manager');
  const ctxRef = windowState.getWindowContext(mainWindow.id);
  ctxRef.relayout = layout;
  ctxRef.onTabUpdated = (tabId) => {
    try {
      if (tabId === null) {
        // 结构变化（关闭标签）
      }
      const tabs = tabManager.listTabs(ctxRef);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lingya-tabs-updated', { tabs, activeTabId: ctxRef.activeTabId });
      }
    } catch (_) {}
  };

  const mainTab = tabManager.createTab(ctxRef, {
    url: providerChosen ? provider.homeUrl : null,
    profileData,
    userDataDir: app.getPath('userData'),
    activate: true,
  });
  mainTab.isMain = true;
  mainTab.title = provider.name;

  // 未选平台 → 主标签加载平台选择页
  if (!providerChosen) {
    try {
      mainTab.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'platform-select.html'));
    } catch (_) {}
  }

  const aiView = mainTab.view;
  mainWindow.__aiView = aiView;
  layout();

  const winSession = aiView.webContents.session;
  sessionsToFlush.add(winSession);

  if (windowState.getAllWindows().length === 1) {
    updater.initAutoUpdater(mainWindow);
  }

  // 壳页面：加载左侧栏 UI
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));

  // 壳页面 console 转发（便于诊断侧栏问题）
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (/\[LingYa Shell\]/.test(message)) console.log('[Shell Console][' + profileData.name + ']', message);
  });

  // AI view 的 console 转发 + 日志
  aiView.webContents.on('console-message', (_event, level, message) => {
    console.log('[Renderer Console][' + profileData.name + ']', message);
    if (!RENDERER_LOG_DIR) return;
    let providerId = profileData.providerId || 'default';
    const ctx = windowState.getContextByWebContents(aiView.webContents);
    if (ctx && ctx.providerId) providerId = ctx.providerId;
    const logFile = path.join(RENDERER_LOG_DIR, providerId + '.log');
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '][' + profileData.name + '] ' + message + '\n', 'utf-8');
  });

  if (!savedBounds) {
    mainWindow.maximize();
  } else if (savedBounds.maximized) {
    mainWindow.maximize();
  }
  mainWindow.on('resize', layout);

  // 关键：每次窗口尺寸变化都同步 AI 基准宽（否则用户手动调整后，保存时会用陈旧值）
  // 公式：aiWidth = 当前窗口宽 - 当前侧栏宽
  // 侧栏开合触发的 setBounds 也走这里 → aiWidth = (aiW+sw) - sw = aiW（稳定，不会漂移）
  mainWindow.on('resize', () => {
    try {
      const b = mainWindow.getBounds();
      const sw = currentSidebarWidth(mainWindow);
      mainWindow.__lingyaAiWidth = Math.max(200, b.width - sw);
    } catch (_) {}
  });

  // 窗口位置/大小保存
  let boundsSaveTimer = null;
  const saveWindowBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const maximized = mainWindow.isMaximized();
      const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      // 归一化宽度：优先用 __lingyaAiWidth（真实 AI 宽，不受屏幕 clamp 污染）；
      // 回退到「当前宽 - 侧栏宽 + 收起宽」
      const curSw = currentSidebarWidth(mainWindow);
      const aiW = (typeof mainWindow.__lingyaAiWidth === 'number')
        ? mainWindow.__lingyaAiWidth
        : (b.width - curSw);
      const normWidth = aiW + SIDEBAR_COLLAPSED;
      profileManager.updateProfileBounds(profileData.id, {
        x: b.x, y: b.y, width: normWidth, height: b.height, maximized,
      });
    } catch (err) { console.error('[LingYa] 保存窗口大小失败:', err.message); }
  };
  const scheduleSaveBounds = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(saveWindowBounds, 500);
  };
  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);

  // UA（作用于 AI view，避免被识别为第三方客户端）
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  aiView.webContents.setUserAgent(userAgent);

  // 主标签的导航/会话监听（tab-manager 已负责标题/URL 同步）
  aiView.webContents.on('did-finish-load', () => {
    if (!mainWindow.isDestroyed()) {
      sessionStore.tryRestoreSessionFromUrl(winProxy);
    }
  });
  aiView.webContents.on('did-navigate', (_e, url) => { sessionStore.handleUrlChange(url, winProxy); });
  aiView.webContents.on('did-navigate-in-page', (_e, url) => { sessionStore.handleUrlChange(url, winProxy); });
  aiView.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') aiView.webContents.toggleDevTools();
  });

  mainWindow.on('close', (event) => {
    saveWindowBounds();
    if (global.__lingyaQuitting) return;
    if (!tray.hasTray()) return;
    if (mainWindow.__forceClose) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    sessionsToFlush.delete(winSession);
    // 关闭所有标签的渲染进程，防止泄漏
    try {
      const ctx = windowState.getWindowContext(mainWindow.id);
      if (ctx && ctx.tabs) {
        for (const t of ctx.tabs.values()) {
          try { t.view.webContents.close(); } catch (_) {}
        }
        ctx.tabs.clear();
      }
    } catch (_) {}
    windowState.removeWindow(mainWindow.id);
  });
}

// ========== 标签页 IPC（每个窗口独立）==========
const tabManager = require('./tab-manager');

function getCtxFromEvent(event) {
  const ctx = windowState.getContextByWebContents(event.sender);
  return ctx || null;
}

ipcMain.handle('lingya-tab-list', async (event) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  return { success: true, tabs: tabManager.listTabs(ctx), activeTabId: ctx.activeTabId };
});

ipcMain.handle('lingya-tab-new', async (event, { url, activate } = {}) => {
  try {
    const ctx = getCtxFromEvent(event);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const tab = tabManager.createTab(ctx, {
      url: url || 'about:blank',
      activate: activate !== false,
    });
    return { success: true, tabId: tab.id };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('lingya-tab-switch', async (event, { tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  return tabManager.switchTab(ctx, tabId);
});

ipcMain.handle('lingya-tab-close', async (event, { tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  return tabManager.closeTab(ctx, tabId);
});

ipcMain.handle('lingya-tab-navigate', async (event, { url, tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  if (!url || !/^https?:\/\//i.test(url) && url !== 'about:blank') {
    // 允许省略协议：自动补 https
    if (url && !/^[a-z]+:/i.test(url)) url = 'https://' + url;
  }
  return tabManager.navigate(ctx, url, tabId);
});

ipcMain.handle('lingya-tab-back', async (event, { tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  const t = ctx.tabs.get(tabId || ctx.activeTabId);
  if (!t) return { success: false, error: '标签不存在' };
  try { if (t.view.webContents.canGoBack()) t.view.webContents.goBack(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('lingya-tab-forward', async (event, { tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  const t = ctx.tabs.get(tabId || ctx.activeTabId);
  if (!t) return { success: false, error: '标签不存在' };
  try { if (t.view.webContents.canGoForward()) t.view.webContents.goForward(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('lingya-tab-reload', async (event, { tabId } = {}) => {
  const ctx = getCtxFromEvent(event);
  if (!ctx) return { success: false, error: '窗口不存在' };
  const t = ctx.tabs.get(tabId || ctx.activeTabId);
  if (!t) return { success: false, error: '标签不存在' };
  try { t.view.webContents.reload(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

// ========== 应用菜单 ==========
function setupAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const profiles = profileManager.readProfiles();
            createWindow(profileManager.createProfile('窗口' + (profiles.length + 1), ''));
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '导航',
      submenu: [
        {
          label: '后退',
          accelerator: 'Alt+Left',
          click: (_item, focusedWindow) => {
            if (focusedWindow) focusedWindow.webContents.navigationHistory.goBack();
          }
        },
        {
          label: '前进',
          accelerator: 'Alt+Right',
          click: (_item, focusedWindow) => {
            if (focusedWindow) focusedWindow.webContents.navigationHistory.goForward();
          }
        },
        { type: 'separator' },
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, focusedWindow) => {
            if (focusedWindow) focusedWindow.reload();
          }
        },
        {
          label: '停止加载',
          accelerator: 'Esc',
          click: (_item, focusedWindow) => {
            if (focusedWindow) focusedWindow.webContents.stop();
          }
        },
        { type: 'separator' },
        {
          label: '主页',
          click: (_item, focusedWindow) => {
            if (focusedWindow) {
              const ctx = windowState.getContextByWebContents(focusedWindow.webContents);
              if (ctx && ctx.providerId) {
                const provider = getProvider(ctx.providerId);
                if (provider) focusedWindow.loadURL(provider.homeUrl);
              }
            }
          }
        }
      ]
    },
    {
      label: '查看',
      submenu: [
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' },
        { type: 'separator' },
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, focusedWindow) => {
            // 真正关闭当前窗口：置 __forceClose 标记后 close()，绕过"关闭=隐藏到托盘"的拦截
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || windowState.getMainWindow();
            if (win && !win.isDestroyed()) {
              win.__forceClose = true;
              win.close();
            }
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            updater.checkForUpdates();
          }
        },
        { type: 'separator' },
        { role: 'about', label: '关于 LingYa' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ========== IPC 处理器 ==========
registerIpcHandlers();

// 定时任务：注册 IPC + 启动调度器（在目标窗口新开对话执行）
try {
  require('./schedule-ipc').registerScheduleIpc();
} catch (err) {
  console.error('[LingYa] 初始化定时任务失败:', err.message);
}

// 飞书同步：若已配置并启用则自动连接
try {
  require('./feishu-ipc').initFeishu();
} catch (err) {
  console.error('[LingYa] 初始化飞书失败:', err.message);
}

// 侧栏开合/调宽（壳页面调用）：按 event.sender 路由到对应窗口，支持多窗口
// 注：ipcMain.handle 是全局的，故此处只注册一次，用 sender 反查窗口。
const { ipcMain: ipcMainForProfile } = require('electron');
const SIDEBAR_MIN = 240, SIDEBAR_MAX = 640, SIDEBAR_DEFAULT = 320;
const SIDEBAR_COLLAPSED = 46;   // 收起态：仅显示 activitybar 图标条
const TABBAR_HEIGHT = 40;        // 顶部标签栏高度（壳页面绘制，AI view 从其下方开始）

/** 当前侧栏实际占宽：展开=自定义宽，收起=46 */
function currentSidebarWidth(w) {
  return w.__sidebarOpen ? (w.__sidebarWidth || SIDEBAR_DEFAULT) : SIDEBAR_COLLAPSED;
}

/** 重排所有标签的 view：顶部让出标签栏，侧栏展开时右移 sw */
function layoutAIView(mainWindow) {
  try {
    const ctx = windowState.getWindowContext(mainWindow.id);
    if (!ctx || !ctx.tabs || !ctx.tabs.size) return;
    const b = mainWindow.getContentBounds();
    const sw = currentSidebarWidth(mainWindow);
    const top = TABBAR_HEIGHT;
    const w = Math.max(0, b.width - sw);
    const h = Math.max(0, b.height - top);
    for (const t of ctx.tabs.values()) {
      try { t.view.setBounds({ x: sw, y: top, width: w, height: h }); } catch (_) {}
    }
  } catch (_) {}
}

ipcMainForProfile.handle('shell-sidebar-toggle', async (event, { open, width } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false, error: '窗口不存在' };
    const mainWindow = ctx.win.__rawWindow || ctx.win;
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    const w = (typeof width === 'number' && width >= SIDEBAR_MIN && width <= SIDEBAR_MAX) ? Math.round(width) : SIDEBAR_DEFAULT;
    const cur = mainWindow.getBounds();
    // __lingyaAiWidth = AI 网页应有宽度（不含侧栏）。
    // 窗口宽 = AI 宽 + 当前侧栏宽（收起 46 / 展开 w）。
    if (typeof mainWindow.__lingyaAiWidth !== 'number') {
      // 首次记录：当前窗口宽 - 当前侧栏宽（默认收起 46）
      // 最大化/全屏时 cur.width 是屏幕宽，会污染基准 → 用 getNormalBounds 还原
      const baseW = (mainWindow.isMaximized() || mainWindow.isFullScreen())
        ? mainWindow.getNormalBounds().width : cur.width;
      mainWindow.__lingyaAiWidth = Math.max(200, baseW - SIDEBAR_COLLAPSED);
    }
    mainWindow.__sidebarOpen = !!open;
    if (open) mainWindow.__sidebarWidth = w;
    const sw = open ? w : SIDEBAR_COLLAPSED;
    const wa = require('electron').screen.getDisplayMatching(cur).workAreaSize;
    const targetW = Math.min(mainWindow.__lingyaAiWidth + sw, wa.width);
    // 最大化/全屏时不改窗口尺寸（只移 AI view）
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      mainWindow.setBounds({ x: cur.x, y: cur.y, width: targetW, height: cur.height });
    }
    setTimeout(() => layoutAIView(mainWindow), 30);
    return { success: true, windowWidth: targetW, aiWidth: mainWindow.__lingyaAiWidth, sidebarWidth: sw };
  } catch (err) { return { success: false, error: err.message }; }
});

// 拖拽中实时调宽：只重排 AI view，不改窗口宽（拖拽结束后由 toggle 统一改窗口宽）
ipcMainForProfile.handle('shell-sidebar-resize', async (event, { width } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false };
    const mainWindow = ctx.win.__rawWindow || ctx.win;
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    const w = (typeof width === 'number' && width >= SIDEBAR_MIN && width <= SIDEBAR_MAX) ? Math.round(width) : SIDEBAR_DEFAULT;
    mainWindow.__sidebarWidth = w;
    layoutAIView(mainWindow);
    return { success: true, width: w };
  } catch (err) { return { success: false, error: err.message }; }
});

// 拖拽开始/结束：结束时可同步调整窗口宽度（保持 AI 可用宽度不变）
ipcMainForProfile.handle('shell-sidebar-drag', async (event, { phase } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false };
    const mainWindow = ctx.win.__rawWindow || ctx.win;
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    if (phase === 'end' && mainWindow.__sidebarOpen && typeof mainWindow.__lingyaAiWidth === 'number') {
      // 结束拖拽：窗口宽 = AI 宽 + 新侧栏宽（AI 净宽始终不变）
      const cur = mainWindow.getBounds();
      const w = mainWindow.__sidebarWidth || SIDEBAR_DEFAULT;
      const wa = require('electron').screen.getDisplayMatching(cur).workAreaSize;
      const target = Math.min(mainWindow.__lingyaAiWidth + w, wa.width);
      mainWindow.setBounds({ x: cur.x, y: cur.y, width: target, height: cur.height });
      setTimeout(() => layoutAIView(mainWindow), 30);
    }
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：把文本插入到聊天输入框（跨 webContents 转发）
ipcMainForProfile.handle('shell-insert-to-chat', async (event, { text, tag, delay } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false, error: '窗口不存在' };
    const wc = ctx.win.webContents;
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-insert-to-chat', { text: String(text||''), tag: tag||'', delay: (typeof delay==='number'?delay:undefined) });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：发起新会话（导航到平台首页）
ipcMainForProfile.handle('shell-new-chat', async (event) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false, error: '窗口不存在' };
    const wc = ctx.win.webContents;
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    let homeUrl = null;
    try { const { getProviderByUrl } = require('../providers'); const p = getProviderByUrl(wc.getURL()); if (p && p.homeUrl) homeUrl = p.homeUrl; } catch (_) {}
    if (!homeUrl) return { success: false, error: '无法确定平台首页' };
    await wc.loadURL(homeUrl);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：执行一个动作（生成文档/沉浸式/停止/压缩/手动解析/导出对话）
ipcMainForProfile.handle('shell-run-action', async (event, { action } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false, error: '窗口不存在' };
    const wc = ctx.win.webContents;
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-run-action', { action: String(action||'') });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：设置偏好（自动注入 / 发送延迟），写入 AI 视图 localStorage
ipcMainForProfile.handle('shell-set-setting', async (event, { key, value } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win) return { success: false, error: '窗口不存在' };
    const wc = ctx.win.webContents;
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-set-setting', { key: String(key||''), value: value });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：读偏好（返回 Promise，主进程转发后由 AI 视图回填）
// 简化：不实现读回，侧边栏用固定默认值展示

// AI 视图 → 壳窗口：转发命令历史（供侧边栏日志面板展示）
ipcMain.on('lingya-report-history', (event, payload) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return;
    const rawWin = ctx.rawWin || ctx.win;
    if (rawWin && !rawWin.isDestroyed() && rawWin.webContents) {
      rawWin.webContents.send('lingya-history-updated', payload);
    }
  } catch (_) {}
});

// 覆盖层"新建窗口"按钮触发
ipcMainForProfile.handle('create-profile-window', async (_event, { providerId } = {}) => {
  const profiles = profileManager.readProfiles();
  // 不指定平台时创建"未确定平台"的 profile，窗口会显示平台选择页
  const pid = providerId || '';
  createWindow(profileManager.createProfile('窗口' + (profiles.length + 1), pid));
  return { success: true };
});

// 列出所有 profiles
ipcMainForProfile.handle('list-profiles', async () => {
  return { success: true, profiles: profileManager.readProfiles() };
});

// 删除指定 profile（会关闭其窗口）
ipcMainForProfile.handle('delete-profile', async (_event, { profileId }) => {
  if (!profileId) return { success: false, error: '缺少窗口ID' };
  const ctx = windowState.getWindowByProfileId(profileId);
  if (ctx && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.__forceClose = true;
    ctx.win.destroy();
  }
  const ok = profileManager.deleteProfile(profileId);
  if (ok) {
    try { require('./agent-store').clearProfile(profileId); } catch (_) {}
  }
  return { success: ok, error: ok ? null : '窗口不存在' };
});

// 列出所有内置平台
ipcMainForProfile.handle('list-providers', async () => {
  const { getAllProviders } = require('../providers');
  return {
    success: true,
    providers: getAllProviders().map(p => ({
      id: p.id,
      name: p.name,
      custom: !!p._customPath,
      path: p._customPath || null,
    })),
  };
});

// 导入自定义 Provider（弹文件选择框，复制到 userData，并处理重名）
ipcMainForProfile.handle('import-provider', async (event, { replace = false } = {}) => {
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择自定义 Provider 文件',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { importCustomProvider } = require('../providers/custom/loader');
  try {
    const res = importCustomProvider(filePath, { replace });
    if (res.exists && !replace) {
      // 同名 provider 已存在，询问是否替换
      const confirmRes = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        title: 'Provider 已存在',
        message: '已导入过 id 为 "' + res.provider.id + '" 的 Provider，是否替换？',
      });
      if (confirmRes.response !== 1) {
        return { success: false, canceled: true };
      }
      // 用户确认替换，重新导入
      const finalRes = importCustomProvider(filePath, { replace: true });
      return { success: true, provider: { id: finalRes.provider.id, name: finalRes.provider.name, path: finalRes.targetPath } };
    }
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err) {
    return { success: false, error: '加载失败: ' + err.message };
  }
});

// 删除自定义 Provider（先检查是否有窗口在使用）
ipcMainForProfile.handle('remove-provider', async (_event, { path: filePath, providerId }) => {
  if (!filePath) return { success: false, error: '缺少文件路径' };

  // 检查是否有窗口正在使用该 provider
  const usingContexts = windowState.getAllContexts().filter(
    (ctx) => ctx.providerId === providerId
  );

  if (usingContexts.length > 0) {
    const profileNames = usingContexts
      .map((ctx) => {
        const profile = profileManager.getProfileById(ctx.profileId);
        return profile ? profile.name : ctx.profileId;
      })
      .join('、');
    return {
      success: false,
      error: '以下窗口正在使用此 Provider，请先在窗口管理中更换这些窗口的平台再删除：' + profileNames,
    };
  }

  const { removeCustomProviderPath } = require('../providers/custom/loader');
  removeCustomProviderPath(filePath);
  return { success: true };
});

// 替换自定义 Provider（弹文件选择框，校验 id 一致后覆盖）
ipcMainForProfile.handle('replace-provider', async (event, { providerId }) => {
  if (!providerId) return { success: false, error: '缺少 providerId' };
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择新的 Provider 文件（id 必须为 ' + providerId + '）',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { replaceCustomProvider } = require('../providers/custom/loader');
  try {
    const res = replaceCustomProvider(providerId, filePath);
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err) {
    return { success: false, error: '替换失败: ' + err.message };
  }
});

// 用户在平台选择页选择平台后，绑定 profile 并重建窗口（partition 必须随 profile 更新）
ipcMainForProfile.handle('select-platform', async (event, { providerId }) => {
  if (!providerId) return { success: false, error: '缺少平台ID' };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };

  const provider = getProvider(providerId);
  if (!provider) return { success: false, error: '平台不存在: ' + providerId };

  // 更新该窗口 profile 的 providerId 和 partition
  const updatedProfile = profileManager.updateProfileProvider(ctx.profileId, providerId);
  if (!updatedProfile) return { success: false, error: '更新 profile 失败' };

  // 关闭旧窗口（其 session 仍是旧 partition）
  // 注意：这里销毁最后一个窗口会触发 window-all-closed，
  // 但紧接着会 createWindow 重建，故 window-all-closed 采用延迟确认避免误退。
  console.log('[LingYa] 切换平台: ' + ctx.providerId + ' -> ' + providerId + '，重建窗口');
  const oldWin = ctx.win;
  if (oldWin && !oldWin.isDestroyed()) {
    oldWin.destroy();
  }

  // 用新 profile（含新 partition）重建窗口
  createWindow(updatedProfile);
  console.log('[LingYa] 切换平台完成，当前窗口数=' + windowState.getAllWindows().length);
  return { success: true };
});

// 打开指定 profile 的窗口（若已存在则聚焦）
ipcMainForProfile.handle('open-profile-window', async (_event, { profileId }) => {
  const existing = windowState.getWindowByProfileId(profileId);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    const win = existing.win;
    if (win.isMinimized()) win.restore();
    win.focus();
    return { success: true, focused: true };
  }
  const profile = profileManager.getProfileById(profileId);
  if (!profile) return { success: false, error: '窗口不存在' };
  createWindow(profile);
  return { success: true, focused: false };
});

// 更新窗口名称（提取到 DeepSeek 用户信息后）
ipcMainForProfile.handle('update-window-name', async (event, { displayName }) => {
  if (!displayName || !displayName.trim()) return { success: false };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };
  const updated = profileManager.updateProfileName(ctx.profileId, displayName);
  if (updated && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.setTitle('LingYa Pro - ' + updated.name);
  }
  return { success: !!updated, name: updated ? updated.name : null };
});

// ========== MCP 相关 IPC ==========
const mcpConfig = require('./mcp-config');
const mcpClient = require('./mcp-client');

// 列出所有 MCP server（含启用状态）
ipcMainForProfile.handle('list-mcp-servers', async () => {
  const servers = mcpConfig.getServers();
  const connected = new Set(mcpClient.getConnectedServers().map(s => s.name));
  console.log('[MCP DEBUG] servers:', JSON.stringify(servers.map(s => ({ name: s.name, enabled: s.enabled }))));
  console.log('[MCP DEBUG] connected:', JSON.stringify(Array.from(connected)));
  return { success: true, servers: servers.map(s => ({ ...s, connected: connected.has(s.name) })) };
});

// 添加或更新 MCP server 配置
ipcMainForProfile.handle('upsert-mcp-server', async (_event, { server }) => {
  if (!server || !server.name || !server.type) {
    return { success: false, error: 'server 配置不完整（需要 name 和 type）' };
  }
  mcpConfig.upsertServer(server);
  return { success: true };
});

// 删除 MCP server
ipcMainForProfile.handle('remove-mcp-server', async (_event, { name }) => {
  await mcpClient.disconnectServerByName(name);
  mcpConfig.removeServer(name);
  return { success: true };
});

// 启用 MCP server（连接并拉取工具）
ipcMainForProfile.handle('enable-mcp-server', async (_event, { name }) => {
  try {
    mcpConfig.setServerEnabled(name, true);
    await mcpClient.connectServerByName(name);
    console.log('[MCP DEBUG] enable 完成, connections:', JSON.stringify(Array.from(mcpClient.getConnectedServers().map(s => s.name))));
    return { success: true };
  } catch (err) {
    console.error('[MCP DEBUG] enable 失败:', err);
    return { success: false, error: err.message };
  }
});

// 禁用 MCP server（断开连接）
ipcMainForProfile.handle('disable-mcp-server', async (_event, { name }) => {
  mcpConfig.setServerEnabled(name, false);
  await mcpClient.disconnectServerByName(name);
  return { success: true };
});

// 获取已启用 server 的工具列表（用于注入提示词）
ipcMainForProfile.handle('get-mcp-tools', async () => {
  return { success: true, tools: mcpClient.getMcpToolList() };
});

// ========== 单实例锁（多实例支持）==========
// 锁的获取已在顶部「多实例支持」段完成，这里只决定是否退出 + 是否注册聚焦。
if (_shouldQuit) {
  app.quit();
} else {
  // 仅单实例模式才把「第二次启动」聚焦到已有窗口；多开模式忽略（用户本就想多开）。
  if (_forceSingle) {
    app.on('second-instance', () => {
      const mainWindow = windowState.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(() => {
    setupAppMenu();
    createWindow(null);

    // 注册窗口重建回调（供托盘"显示窗口"在无窗口时调用）
    global.__lingyaCreateWindow = () => createWindow(null);

    // 创建系统托盘
    tray.createTray();

    // 后台连接已启用的 MCP server，不阻塞窗口创建
    mcpClient.connectEnabledServers().catch(err => {
      console.error('[MCP] 初始化连接失败:', err.message);
    });

    if (_isolatedInstance) {
      console.log('[LingYa] 多实例模式（独立数据目录）:', EFFECTIVE_USER_DATA_DIR);
    }
  });
}

app.on('window-all-closed', () => {
  // 用户主动退出
  if (global.__lingyaQuitting) {
    app.quit();
    return;
  }
  // 无托盘时退化为原行为（延迟确认，避免切换平台间隙误退）
  if (!tray.hasTray()) {
    // 切换平台时会先销毁旧窗口（select-platform）再创建新窗口，
    // 这个间隙窗口数会短暂为 0，若直接 quit 会导致闪退。
    setTimeout(() => {
      if (windowState.getAllWindows().length === 0) {
        app.quit();
      }
    }, 500);
  }
  // 有托盘：保持后台常驻（窗口隐藏，托盘可见）
});

// 退出前刷新所有 session 数据
let quitFlushed = false;
app.on('before-quit', (event) => {
  if (quitFlushed) return;
  event.preventDefault();
  quitFlushed = true;
  flushAllSessions().finally(() => {
    app.quit();
  });
});

app.on('activate', () => {
  if (windowState.getAllWindows().length === 0) {
    createWindow(null);
  }
});
