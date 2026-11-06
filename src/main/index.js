/**
 * LingYa 主进程入口（多窗口多 profile 版）
 * 由项目根目录 main.js 薄壳加载。
 */
const { app, BrowserWindow, Menu, dialog, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ========== 全局异常保护（必须尽早安装）==========
// 在主进程加载任何业务模块前装好，才能捕获模块初始化阶段的异常。
// 详见 global-guard.js 的说明：不阻止崩溃，但保证崩溃可见、状态可恢复。
const globalGuard = require('./global-guard');
globalGuard.install({
  onError: (info) => {
    // 通知所有窗口：主进程出过问题，UI 可显示提示
    try {
      const { getAllContexts } = require('./window');
      for (const ctx of getAllContexts()) {
        const wc = ctx.rawWin && ctx.rawWin.webContents;
        if (wc && !wc.isDestroyed()) {
          wc.send('lingya-main-error', info);
        }
      }
    } catch (_) { /* window 模块可能尚未初始化 */ }
  },
});

const windowState = require('./window');
const profileManager = require('./profile-manager');
const { createSessionStore } = require('./session-store');
const { getProvider } = require('../providers');
const updater = require('./updater');
const tray = require('./tray');
const petLoader = require('./pet-loader');

// ========== 数据目录解析（便携优先）==========
// 见 data-dir.js：便携版数据与程序同目录，换电脑/搬目录配置不丢。
const { resolveDataDir, resolveInstanceDir } = require('./data-dir');
const SESSION_DIR = process.env.LINGYA_SESSION_DIR || 'lingya-ai-pro-session';

// 读取用户自定义数据目录。
// 配置文件固定在 appData 下（不随数据目录变化），避免「鸡生蛋」问题：
// 若配置跟着数据目录走，改了路径后下次启动就找不到配置了。
let _customDataDir = null;
try {
  const _cfgPath = path.join(app.getPath('appData'), SESSION_DIR, 'data-location.json');
  if (fs.existsSync(_cfgPath)) {
    const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf-8'));
    if (_cfg && typeof _cfg.customDir === 'string' && _cfg.customDir.trim()) {
      _customDataDir = _cfg.customDir.trim();
    }
  }
} catch (err) {
  console.warn('[LingYa] 读取自定义数据目录配置失败:', err.message);
}

const dataDirInfo = resolveDataDir({
  appDataPath: app.getPath('appData'),
  execPath: process.execPath,
  env: process.env,
  fs,
  sessionDir: SESSION_DIR,
  customDir: _customDataDir,
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
if (dataDirInfo.readonlyFallback) {
  console.warn('[LingYa] ⚠️ 程序目录不可写（' + dataDirInfo.intendedDir + '），数据已回退到用户目录');
  console.warn('[LingYa] 建议把 LingYa 装到有写权限的位置（如 D:\\LingYa 或用户目录），');
  console.warn('[LingYa] 这样数据会跟程序放一起，整个目录打包就能迁移。');
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
  const skillStore = require('./skill-store');
  skillStore.init(app.getPath('userData'));
  // 同步应用内置技能（src/assets/<dir>/SKILL.md）
  // 每次启动覆盖同步：SKILL.md 在 asar 里用户改不了，真相源是应用自带版本。
  // 保留用户对同名技能的 enabled 选择与使用统计。
  try {
    skillStore.registerBuiltinSkills(path.join(__dirname, '..', 'assets'));
  } catch (err) {
    console.warn('[LingYa] 同步内置技能失败:', err.message);
  }
} catch (err) {
  console.error('[LingYa] 初始化技能存储失败:', err.message);
}

// 注册内置 graphify MCP server（随应用分发，首次启动自动配置）
// 已存在同名 server 时不覆盖，尊重用户自定义
try {
  const mcpConfig = require('./mcp-config');
  const r = mcpConfig.registerBuiltinGraphify();
  if (!r.registered) console.log('[LingYa] graphify 内置 server 未注册:', r.reason);
} catch (err) {
  console.warn('[LingYa] 注册内置 graphify server 失败:', err.message);
}

// 初始化飞书配置存储（全局共享）
try {
  require('../feishu/config').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化飞书配置存储失败:', err.message);
}

// 初始化微信 iLink 配置存储（全局共享）
try {
  require('../weixin/config').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化微信配置存储失败:', err.message);
}

// 初始化 QQ 配置存储（全局共享）
try {
  require('../qq/config').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化 QQ 配置存储失败:', err.message);
}

// 初始化媒体子系统（收件箱 + 通道适配器）
try {
  require('./media').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化媒体子系统失败:', err.message);
}

// 初始化安全增强配置存储（CTF 注入 + 拒绝拦截）
try {
  const secStore = require('./security-store');
  secStore.init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化安全配置存储失败:', err.message);
}

// 【2026-11-01 新增】初始化用户提示词草稿存储
try {
  require('./prompt-template-store').init(app.getPath('userData'));
  console.log('[LingYa] 提示词草稿存储已初始化');
} catch (err) {
  console.error('[LingYa] 初始化提示词草稿存储失败:', err.message);
}

// 初始化跨窗口 Token 轮转配置存储（全局共享）
try {
  require('./token-rotation').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化轮转配置存储失败:', err.message);
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

// 初始化【用户手动待办】存储（独立文件 lingya-user-todos.json）
// 与上面的 AI 计划（todoWrite）完全分离：AI 的 todoWrite 是"替换完整列表"语义，
// 共用一份会让用户手动记的待办被 AI 覆盖掉。
try {
  require('../../tools/UserTodoStore').init(app.getPath('userData'));
} catch (err) {
  console.error('[LingYa] 初始化用户待办存储失败:', err.message);
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
    if (!ses || typeof ses.flushStorageData !== 'function') continue;
    try {
      // 注意：Electron 33 的 flushStorageData() 返回 undefined（不是 Promise），
      // 直接 .catch 会抛 TypeError。用 Promise.resolve 包一层兜住两种返回。
      promises.push(Promise.resolve(ses.flushStorageData()).catch(err => {
        console.error('[LingYa] 刷新 session 失败:', err && err.message);
      }));
    } catch (err) {
      console.error('[LingYa] 刷新 session 异常:', err && err.message);
    }
  }
  await Promise.all(promises);
  console.log('[LingYa] 全部 session 数据已刷新到磁盘');
}

/**
 * 创建窗口（绑定指定 profile）
 * @param {object|null} profile profile 对象，null 则使用默认 profile
 */
/**
 * 用一个已存在的 WebContentsView 重建独立窗口（拆分合并窗口时用）。
 * 与 createWindow 的区别：不创建新 tab，而是直接接管传入的 view，
 * 保留它原本的 profile / sessionStore（由 ownerCtx 提供），
 * 因此账号、会话、工具执行链完全延续，不会重新登录或丢上下文。
 *
 * @param {WebContentsView} view  要接管并显示的视图
 * @param {object} ownerCtx       该视图原本所属的窗口上下文
 * @returns {Promise<number>} 新窗口 id
 */
async function createRestoredWindow(view, ownerCtx) {
  const profileData = (ownerCtx && ownerCtx.profileId)
    ? profileManager.getProfileById(ownerCtx.profileId)
    : null;
  const provider = getProvider((ownerCtx && ownerCtx.providerId) || 'deepseek') || getProvider('deepseek');
  const prof = profileData || profileManager.getDefaultProfile();
  const sessionStore = (ownerCtx && ownerCtx.sessionStore) || createSessionStore(prof.id, app.getPath('userData'), windowState);

  const b = view.getBounds();
  const winOptions = {
    width: Math.max(800, (b && b.width) || 1280),
    height: Math.max(600, (b && b.height) || 900),
    title: 'LingYa Pro - ' + provider.name + ' - ' + prof.name,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: prof.partition,
      additionalArguments: ['--lingya-user-data=' + app.getPath('userData')],
    },
  };
  const mainWindow = new BrowserWindow(winOptions);
  mainWindow.__sidebarOpen = false;
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

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

  // 视图作为该窗口唯一 tab 接管
  const tabId = 'tab-restored-' + Date.now();
  const tabs = new Map([[tabId, { id: tabId, view, title: '已恢复窗口', url: '', createdAt: Date.now(), isMain: true }]]);

  windowState.addWindow(winProxy, prof.id, prof.providerId || '', sessionStore, view);
  const ctx = windowState.getWindowContext(mainWindow.id);
  ctx.tabs = tabs;
  ctx.activeTabId = tabId;
  windowState.setMainWindow(winProxy);
  mainWindow.__aiView = view;
  // 视图归属改指向新窗口的 ctx（原宿主窗口不再拥有它）
  windowState.rememberViewOwner(view.webContents, windowState.getWindowContext(mainWindow.id));

  const layout = () => { layoutAIView(mainWindow); };
  ctx.relayout = layout;
  mainWindow.on('resize', layout);

  // 把视图挂进新窗口的 contentView
  mainWindow.contentView.addChildView(view);
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
  layout();

  mainWindow.on('resize', () => {
    try {
      const bb = mainWindow.getBounds();
      const sw = currentSidebarWidth(mainWindow);
      mainWindow.__lingyaAiWidth = Math.max(200, bb.width - sw);
    } catch (_) {}
  });

  return mainWindow.id;
}

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
      // 多窗口隔离：壳页面的 localStorage（收藏/主题/侧栏设置等）按 profile 独立，
      // 否则所有窗口共用默认 partition，收藏列表会跨窗口串台。
      partition: profileData.partition,
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

  // 布局：统一委托 layoutAIView（同一份实现同时处理普通多标签与合并分屏）
  const layout = () => { layoutAIView(mainWindow); };
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

  // 扫描用户自建宠物（<userData>/pets/*.json），失败不影响启动
  let externalPets = [];
  try {
    const loaded = petLoader.loadExternalPets(USER_DATA_DIR);
    externalPets = loaded.pets;
    if (loaded.warnings.length) {
      console.warn('[LingYa] 外部宠物加载警告:', loaded.warnings.join('; '));
    }
  } catch (e) {
    console.warn('[LingYa] 外部宠物扫描失败:', e && e.message);
  }
  const mainTab = tabManager.createTab(ctxRef, {
    url: providerChosen ? provider.homeUrl : null,
    profileData,
    userDataDir: app.getPath('userData'),
    externalPets,
    activate: true,
  });
  mainTab.isMain = true;
  // 主标签标题：优先用已有会话标题，否则用「LingYa · <平台名>」
  (function initMainTitle() {
    let t = null;
    try {
      const sid = sessionStore.state && sessionStore.state.currentSessionId;
      if (sid) {
        const all = sessionStore.readSessionStore();
        const e = sessionStore.normalizeEntry ? sessionStore.normalizeEntry(all[sid]) : all[sid];
        if (e && e.title) t = e.title;
      }
    } catch (_) {}
    mainTab.title = t || ('LingYa · ' + provider.name);
  })();

  // 未选平台 → 主标签加载平台选择页
  if (!providerChosen) {
    try {
      mainTab.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'platform-select.html'));
    } catch (_) {}
  }

  const aiView = mainTab.view;
  mainWindow.__aiView = aiView;
  layout();

  // ========== 【Harness 2026-11-02】纯净对话模式 ==========
  let harnessView = null;
  {
    const ctxForHarness = windowState.getWindowContext(mainWindow.id);
    if (ctxForHarness) {
      ctxForHarness.harnessView = null;
      ctxForHarness.harnessVisible = false;
    }
  }

  const ensureHarnessView = () => {
    const curCtx = windowState.getWindowContext(mainWindow.id);
    if (!curCtx) return null;
    if (curCtx.harnessView && !curCtx.harnessView.webContents.isDestroyed()) {
      return curCtx.harnessView;
    }
    const { WebContentsView } = require('electron');
    const hv = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'harness-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: profileData.partition,
        additionalArguments: ['--lingya-user-data=' + app.getPath('userData')],
      },
    });
    mainWindow.contentView.addChildView(hv);
    hv.setBackgroundColor('#0f172a');
    hv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    curCtx.harnessView = hv;
    harnessView = hv;
    hv.webContents.loadFile(path.join(__dirname, '..', 'ui', 'harness.html'));
    hv.webContents.on('did-finish-load', () => {
      console.log('[LingYa Harness] 页面加载完成');
      try {
        const url = aiView.webContents.getURL();
        hv.webContents.send('harness-state', { sessionId: url, harness: true });
      } catch (_) {}
    });
    hv.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[LingYa Harness] 页面加载失败: ' + code + ' ' + desc);
    });
    hv.webContents.on('console-message', (_e, _l, msg) => {
      console.log('[Harness Console] ' + msg);
    });
    hv.webContents.on('before-input-event', (_event, input) => {
      if (input.control && !input.shift && (input.key === 'r' || input.key === 'R')) {
        hv.webContents.reloadIgnoringCache();
      }
    });
    return hv;
  };

  const toggleHarness = (show) => {
    if (mainWindow.isDestroyed()) return;
    const curCtx = windowState.getWindowContext(mainWindow.id);
    if (!curCtx) return;
    const next = typeof show === 'boolean' ? show : !curCtx.harnessVisible;
    curCtx.harnessVisible = next;
    if (next) {
      const hv = ensureHarnessView();
      if (hv) {
        try { hv.setVisible(true); } catch (_) {}
        // 隐藏 AI 视图（优先用 curCtx.tabs 的 active tab，回退到闭包里的 aiView）
        let aiWcForHistory = null;
        try {
          const activeTab = curCtx.tabs ? curCtx.tabs.get(curCtx.activeTabId) : null;
          if (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed()) {
            aiWcForHistory = activeTab.view.webContents;
            activeTab.view.setVisible(false);
          } else if (aiView && !aiView.webContents.isDestroyed()) {
            // 回退：用 createWindow 闭包里的主 AI 视图（首次进纯净模式时 activeTabId 可能未就绪）
            aiWcForHistory = aiView.webContents;
            aiView.setVisible(false);
          }
        } catch (_) {}
        layout();
        try { hv.webContents.focus(); } catch (_) {}
        // 【Harness 历史 2026-11-02】页面加载完成后请求历史（若已加载立即发，否则等 did-finish-load）
        try {
          const sendReq = () => {
            if (!aiWcForHistory) {
              console.warn('[LingYa Harness] aiWcForHistory 为空，无法请求历史');
              return;
            }
            if (aiWcForHistory.isDestroyed()) {
              console.warn('[LingYa Harness] aiWcForHistory 已销毁，无法请求历史');
              return;
            }
            aiWcForHistory.send('harness-request-history');
            console.log('[LingYa Harness] 已请求历史');
          };
          // 1200ms：等 harness.html（2670 行）完成初始化 + onEvent 绑定
          if (hv.webContents.isLoading && hv.webContents.isLoading()) {
            hv.webContents.once('did-finish-load', () => {
              setTimeout(sendReq, 1200);
            });
          } else {
            setTimeout(sendReq, 1200);
          }
        } catch (_) {}
      }
    } else {
      if (curCtx.harnessView && !curCtx.harnessView.webContents.isDestroyed()) {
        try { curCtx.harnessView.setVisible(false); } catch (_) {}
        try { curCtx.harnessView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch (_) {}
      }
      // 恢复 AI 视图
      try {
        const activeTab = curCtx.tabs ? curCtx.tabs.get(curCtx.activeTabId) : null;
        if (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed()) {
          activeTab.view.setVisible(true);
        } else if (aiView && !aiView.webContents.isDestroyed()) {
          aiView.setVisible(true);
        }
      } catch (_) {}
      layout();
    }
    // 通知壳页面更新按钮文字
    try { mainWindow.webContents.send('shell-harness-mode', { harness: next }); } catch (_) {}
    // 通知 AI 页面（bridge 侧）
    try { aiView.webContents.send('harness-mode-changed', { harness: next }); } catch (_) {}
    console.log('[LingYa Harness] 切换: ' + (next ? '纯净模式' : '网页模式'));
  };

  mainWindow.__lingyaToggleHarness = toggleHarness;

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

  // 【封号风险改造 2026-11-01】改为动态取真实内核版本 + 补齐 sec-ch-ua 请求头
  // （原实现硬编码 Chrome/130，且 sec-ch-ua 缺 Google Chrome 品牌 → Electron 指纹命中）
  const { buildChromeUserAgent, buildClientHintsHeaders } = require('./user-agent');
  aiView.webContents.setUserAgent(buildChromeUserAgent());
  try {
    const ses = aiView.webContents.session;
    if (!ses.__lingyaHintsInstalled) {
      ses.__lingyaHintsInstalled = true;
      const hints = buildClientHintsHeaders();
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
          const h = details.requestHeaders || {};
          for (const k of Object.keys(h)) {
            const lk = k.toLowerCase();
            if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-mobile' || lk === 'sec-ch-ua-platform' ||
                lk === 'sec-ch-ua-full-version' || lk === 'sec-ch-ua-full-version-list') {
              delete h[k];
            }
          }
          Object.assign(h, hints);
        } catch (_) {}
        callback({ requestHeaders: details.requestHeaders });
      });
    }
  } catch (err) {
    console.error('[LingYa] 注册 sec-ch-ua 请求头失败:', err && err.message);
  }

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
    try {
      const ctx = windowState.getWindowContext(mainWindow.id);
      // 1) 关闭所有标签的渲染进程
      if (ctx && ctx.tabs) {
        for (const t of ctx.tabs.values()) {
          try { t.view.webContents.close(); } catch (_) {}
        }
        ctx.tabs.clear();
      }
      // 2) 关闭合并进来的附加视图（它们属于别的 profile，不关就泄漏）
      if (ctx && ctx.attachedViews) {
        for (const p of ctx.attachedViews) {
          try { if (p.sidebarView) p.sidebarView.webContents.close(); } catch (_) {}
          try { if (p.view) p.view.webContents.close(); } catch (_) {}
        }
        ctx.attachedViews = [];
        ctx.splitDirection = null;
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

// ========== 下拉浮层（标签列表 / 收藏夹）==========
// 为什么走独立窗口：AI 网页是 WebContentsView（原生层），会盖住壳页面的 HTML，
// 壳页面里的下拉面板落在 AI view 区域就完全看不见。
const dropdownWin = require('./dropdown-window');

ipcMain.handle('lingya-dropdown-open', async (event, payload = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const ownerWin = ctx.rawWin || ctx.win;
    if (!ownerWin || ownerWin.isDestroyed()) return { success: false, error: '窗口已销毁' };

    const type = payload.type || 'tabs';

    // 壳页面传上来的是「页面内坐标」（getBoundingClientRect），
    // 独立下拉窗口需要「屏幕坐标」→ 加上主窗口内容区左上角的屏幕位置。
    const rawAnchor = payload.anchor || { x: 100, y: 60, w: 26, h: 26 };
    let baseX = 0, baseY = 0;
    try {
      const cb = ownerWin.getContentBounds();
      baseX = cb.x;
      baseY = cb.y;
    } catch (_) {}
    const anchor = {
      x: baseX + Math.round(rawAnchor.x || 0),
      y: baseY + Math.round(rawAnchor.y || 0),
      w: Math.round(rawAnchor.w || 26),
      h: Math.round(rawAnchor.h || 26),
    };
    console.log('[LingYa Dropdown] 定位 base=(' + baseX + ',' + baseY + ') page=(' +
      rawAnchor.x + ',' + rawAnchor.y + ') → screen=(' + anchor.x + ',' + anchor.y + ')');

    let data = [];
    if (type === 'tabs') {
      // 下拉只列其他网站的标签；主标签（LingYa 对话）固定在顶部横向
      data = tabManager.listTabs(ctx).filter(function (t) { return !t.isMain; });
    } else {
      data = Array.isArray(payload.bookmarks) ? payload.bookmarks : [];
    }

    dropdownWin.open(ownerWin, {
      type,
      anchor,
      data,
      theme: payload.theme || 'dark',
      onAction: (name, p, updateData) => {
        try {
          if (name === 'tab-switch' && p.tabId) {
            tabManager.switchTab(ctx, p.tabId);
          } else if (name === 'tab-close' && p.tabId) {
            tabManager.closeTab(ctx, p.tabId);
            // 关闭后保持下拉常驻：推送最新标签列表
            try {
              if (typeof updateData === 'function') {
                updateData(tabManager.listTabs(ctx).filter(function (t) { return !t.isMain; }));
              }
            } catch (_) {}
          } else if (name === 'bookmark-open' && p.url) {
            tabManager.navigate(ctx, p.url);
          } else if (name === 'bookmark-add' && p.url) {
            // 回传壳页面（收藏存在壳页面的 localStorage）
            let added = false;
            try {
              const sc = ownerWin.webContents;
              if (sc && !sc.isDestroyed()) {
                sc.send('lingya-bookmark-add', { url: p.url, title: p.title });
                added = true;
              }
            } catch (_) {}
            // 刷新下拉：优先用前端传来的 currentList；缺失时异步从壳页面 localStorage 兜底读
            if (typeof updateData === 'function' && added) {
              if (Array.isArray(p.currentList)) {
                const cur = p.currentList.slice();
                if (!cur.some(x => x.url === p.url)) cur.unshift({ url: p.url, title: p.title || p.url });
                updateData(cur);
              } else {
                // 兜底：等壳页面写完 localStorage 后再读（add 是先 send 再读，给 100ms 缓冲）
                setTimeout(() => {
                  try {
                    const sc = ownerWin.webContents;
                    if (!sc || sc.isDestroyed()) return;
                    sc.executeJavaScript("JSON.parse(localStorage.getItem('lingya-bookmarks')||'[]')")
                      .then((list) => {
                        if (Array.isArray(list)) updateData(list);
                      })
                      .catch(() => {});
                  } catch (_) {}
                }, 100);
              }
            }
          } else if (name === 'bookmark-remove' && p.url) {
            try {
              const sc = ownerWin.webContents;
              if (sc && !sc.isDestroyed()) sc.send('lingya-bookmark-remove', { url: p.url });
            } catch (_) {}
            // 刷新下拉：同样优先用 currentList，缺失时从 localStorage 兜底
            if (typeof updateData === 'function') {
              if (Array.isArray(p.currentList)) {
                updateData(p.currentList.filter(x => x.url !== p.url));
              } else {
                setTimeout(() => {
                  try {
                    const sc = ownerWin.webContents;
                    if (!sc || sc.isDestroyed()) return;
                    sc.executeJavaScript("JSON.parse(localStorage.getItem('lingya-bookmarks')||'[]')")
                      .then((list) => {
                        if (Array.isArray(list)) updateData(list);
                      })
                      .catch(() => {});
                  } catch (_) {}
                }, 100);
              }
            }
          }
        } catch (e) {
          console.error('[LingYa Dropdown] 动作处理失败:', e.message);
        }
      },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lingya-dropdown-close', async () => {
  try { dropdownWin.close(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

// 下拉窗口内动作 → 统一入口
ipcMain.on('lingya-dropdown-action', (event, msg = {}) => {
  try { dropdownWin.emitAction(msg.name, msg.payload); } catch (e) { console.error('[LingYa Dropdown] 转发失败:', e.message); }
});
ipcMain.on('lingya-dropdown-close', () => {
  try { dropdownWin.close(); } catch (_) {}
});

// ========== 状态栏溢出浮层（全部窗口的 token / 速度）==========
// 同样必须用独立 BrowserWindow：AI 网页是 WebContentsView 原生层，
// 壳页面 DOM 一旦落在 AI view 区域就会被完全遮住。
const overflowWin = require('./overflow-window');

ipcMain.handle('lingya-overflow-open', async (event, payload = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const ownerWin = ctx.rawWin || ctx.win;
    if (!ownerWin || ownerWin.isDestroyed()) return { success: false, error: '窗口已销毁' };

    const rawAnchor = payload.anchor || { x: 100, y: 600, w: 60, h: 24 };
    let baseX = 0, baseY = 0;
    try {
      const cb = ownerWin.getContentBounds();
      baseX = cb.x;
      baseY = cb.y;
    } catch (_) {}
    const anchor = {
      x: baseX + Math.round(rawAnchor.x || 0),
      y: baseY + Math.round(rawAnchor.y || 0),
      w: Math.round(rawAnchor.w || 60),
      h: Math.round(rawAnchor.h || 24),
    };

    overflowWin.open(ownerWin, {
      anchor,
      items: Array.isArray(payload.items) ? payload.items : [],
      theme: payload.theme || 'dark',
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lingya-overflow-toggle', async (event, payload = {}) => {
  try {
    if (overflowWin.isOpen()) {
      overflowWin.close();
      return { success: true, closed: true };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const ownerWin = ctx.rawWin || ctx.win;
    if (!ownerWin || ownerWin.isDestroyed()) return { success: false, error: '窗口已销毁' };

    const rawAnchor = payload.anchor || { x: 100, y: 600, w: 60, h: 24 };
    let baseX = 0, baseY = 0;
    try {
      const cb = ownerWin.getContentBounds();
      baseX = cb.x;
      baseY = cb.y;
    } catch (_) {}
    const anchor = {
      x: baseX + Math.round(rawAnchor.x || 0),
      y: baseY + Math.round(rawAnchor.y || 0),
      w: Math.round(rawAnchor.w || 60),
      h: Math.round(rawAnchor.h || 24),
    };
    overflowWin.open(ownerWin, {
      anchor,
      items: Array.isArray(payload.items) ? payload.items : [],
      theme: payload.theme || 'dark',
    });
    return { success: true, opened: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lingya-overflow-update', async (_event, payload = {}) => {
  try {
    const ok = overflowWin.update(
      Array.isArray(payload.items) ? payload.items : [],
      payload.theme || 'dark'
    );
    return { success: true, applied: ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lingya-overflow-close', async () => {
  try { overflowWin.close(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.on('lingya-overflow-close-signal', () => {
  try { overflowWin.close(); } catch (_) {}
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
        {
          label: '纯净对话模式',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow() || windowState.getMainWindow();
            if (!win) return;
            try {
              const raw = win.__rawWindow || win;
              if (typeof raw.__lingyaToggleHarness === 'function') {
                raw.__lingyaToggleHarness();
              }
            } catch (_) {}
          }
        },
        { type: 'separator' },
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

// ========== IPC 来源校验（审计 P0）==========
// 必须在所有 registerXXXIpc() 之前安装，这样每个 ipcMain.handle 都会被包上来源校验。
// 敏感通道（记忆/插件/凭证/配置等）只允许 file:// 协议（LingYa 自己页面）调用，
// 防止 AI 网页里的脚本（XSS/注入）越权操作本地资源。
try {
  require('./ipc-guard').install(ipcMain);
} catch (err) {
  console.error('[LingYa] 安装 IPC 来源校验失败:', err && err.message);
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

// 微信 iLink：若已登录并启用则自动恢复长轮询
try {
  require('./weixin-ipc').autoConnectIfEnabled();
} catch (err) {
  console.error('[LingYa] 初始化微信通道失败:', err.message);
}

// QQ：若已配置并启用则自动连接
try {
  require('./qq-ipc').autoConnectIfEnabled();
} catch (err) {
  console.error('[LingYa] 初始化 QQ 通道失败:', err.message);
}

// 手机远程控制：注册 IPC 并自动启动
try {
  const remoteIpc = require('./remote-ipc');
  remoteIpc.registerRemoteIpc();
  remoteIpc.initRemoteOnBoot().catch((e) => console.warn("[Remote]", e && e.message));
} catch (err) {
  console.error("[LingYa] remote init fail:", err && err.message);
}


// 侧栏开合/调宽（壳页面调用）：按 event.sender 路由到对应窗口，支持多窗口
// 注：ipcMain.handle 是全局的，故此处只注册一次，用 sender 反查窗口。
const { ipcMain: ipcMainForProfile } = require('electron');
const { computeSplitLayout, computeScrollContentWidth } = require('./split-layout');
const windowMerge = require('./window-merge');
const { createPresetStore } = require('./preset-store');
const generationState = require('./generation-state');
// 分屏布局预设：全局单文件，记录「方向 + 面板 profileId 序列」，重启后可按预设重建
let presetStore = null;
function getPresetStore() {
  if (!presetStore) presetStore = createPresetStore(app.getPath('userData'));
  return presetStore;
}
const SIDEBAR_MIN = 240, SIDEBAR_MAX = 640, SIDEBAR_DEFAULT = 320;
const SIDEBAR_COLLAPSED = 46;   // 收起态：仅显示 activitybar 图标条
const TABBAR_HEIGHT = 40;        // 顶部标签栏高度（壳页面绘制，AI view 从其下方开始）
const SPLIT_GAP = 0;             // 合并分屏时两视图之间的间隙（0 = 无缝贴合）
const SPLIT_MIN_WIDTH = 800;     // 左右分屏时每个视图的最小宽度，超出走主窗口横向滚动
const SPLIT_SCROLLBAR_H = 14;    // 底部横向滚动条高度
const STATUS_HEIGHT = 28;        // 底部状态栏高度（壳页面绘制）

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
    let h = Math.max(0, b.height - top - STATUS_HEIGHT);

    // 【Harness 2026-11-02】纯净模式可见时，harness 视图铺满 AI 区域
    if (ctx.harnessVisible && ctx.harnessView && !ctx.harnessView.webContents.isDestroyed()) {
      try {
        ctx.harnessView.setBounds({ x: sw, y: top, width: w, height: h });
      } catch (_) {}
      // AI 视图仍保持原尺寸（隐藏状态），避免显示时位置跳变
    }

    // 合并模式：宿主 active tab -> 附加面板（侧边栏 + AI 视图）
    const attached = ctx.attachedViews || [];
    if (ctx.splitDirection === 'horizontal' && attached.length) {
      const activeTab = ctx.tabs.get(ctx.activeTabId);

      // 1) 计算每个面板的尺寸
      let totalSidebarW = 0;
      for (const p of attached) totalSidebarW += (p.sidebarOpen ? (p.sidebarWidth || 320) : 46);
      const count = 1 + attached.length;
      const availW = w - totalSidebarW;
      const viewW = Math.max(800, Math.floor(availW / count));
      const totalContentW = sw + viewW * count + totalSidebarW;

      if (totalContentW > w) h = Math.max(0, h - SPLIT_SCROLLBAR_H);
      const scrollX = ctx.scrollX || 0;
      let currentX = sw;

      // 2) 宿主面板（只有 AI 视图，侧边栏在最左边）
      if (activeTab && activeTab.view) {
        activeTab.view.setBounds({ x: currentX - scrollX, y: top, width: viewW, height: h });
      }
      currentX += viewW;

      // 3) 附加面板
      for (const panel of attached) {
        const sw2 = panel.sidebarOpen ? (panel.sidebarWidth || 320) : 46;
        if (panel.sidebarView) {
          try { panel.sidebarView.setBounds({ x: currentX - scrollX, y: top, width: sw2, height: h }); } catch (_) {}
        }
        if (panel.view) {
          try { panel.view.setBounds({ x: currentX + sw2 - scrollX, y: top, width: viewW, height: h }); } catch (_) {}
        }
        currentX += sw2 + viewW;
      }

      // 4) 其余隐藏标签
      for (const t of ctx.tabs.values()) {
        if (t === activeTab) continue;
        try { t.view.setBounds({ x: sw - scrollX, y: top, width: viewW, height: h }); } catch (_) {}
      }
      return;
    }

    // 上下分屏（无缝相连 + 最小高度 + 纵向滚动）
    if (ctx.splitDirection === 'vertical' && attached.length) {
      const activeTab = ctx.tabs.get(ctx.activeTabId);
      const count = 1 + attached.length;
      const GAP = 0;
      const MIN_HEIGHT = 600;

      const availableH = h - GAP * (count - 1);
      const viewH = Math.max(MIN_HEIGHT, Math.floor(availableH / count));
      const totalContentH = viewH * count + GAP * (count - 1);

      // 内容溢出时右侧预留滚动条宽度
      let safeW = Math.max(0, w - 1);
      if (totalContentH > h) safeW = Math.max(0, w - SPLIT_SCROLLBAR_H - 1);

      const scrollY = ctx.scrollY || 0;
      let currentY = top - scrollY;

      // 1) 宿主面板
      if (activeTab && activeTab.view) {
        try { activeTab.view.setBounds({ x: sw, y: currentY, width: safeW, height: viewH }); } catch (_) {}
      }
      currentY += viewH + GAP;

      // 2) 附加面板
      for (const panel of attached) {
        if (panel.sidebarView) {
          try { panel.sidebarView.setBounds({ x: 0, y: currentY, width: sw, height: viewH }); } catch (_) {}
        }
        if (panel.view) {
          try { panel.view.setBounds({ x: sw, y: currentY, width: safeW, height: viewH }); } catch (_) {}
        }
        currentY += viewH + GAP;
      }

      // 3) 其余隐藏标签
      for (const t of ctx.tabs.values()) {
        if (t === activeTab) continue;
        try { t.view.setBounds({ x: sw, y: top - scrollY, width: safeW, height: viewH }); } catch (_) {}
      }
      return;
    }

    // 普通模式：所有标签共享完整区域（只有 active 可见）
    for (const t of ctx.tabs.values()) {
      try { t.view.setBounds({ x: sw, y: top, width: w, height: h }); } catch (_) {}
    }
  } catch (_) {}
}

ipcMainForProfile.handle('shell-sidebar-toggle', async (event, { open, width } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };

    // 如果这是分屏面板的侧边栏，只调整该面板
    if (ctx.hostCtx) {
      const hostCtx = ctx.hostCtx;
      const panels = hostCtx.attachedViews || [];
      const panel = panels.find(p => p.sidebarView && p.sidebarView.webContents === event.sender);
      if (panel) {
        panel.sidebarOpen = !!open;
        if (open) panel.sidebarWidth = width || 320;
        layoutAIView(hostCtx.rawWin);
        return { success: true };
      }
    }

    if (!ctx.win) return { success: false, error: '窗口不存在' };
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
    if (!ctx) return { success: false };

    // 如果这是分屏面板的侧边栏拖拽
    if (ctx.hostCtx) {
      const hostCtx = ctx.hostCtx;
      const panels = hostCtx.attachedViews || [];
      const panel = panels.find(p => p.sidebarView && p.sidebarView.webContents === event.sender);
      if (panel) {
        panel.sidebarWidth = width || 320;
        layoutAIView(hostCtx.rawWin);
        return { success: true, width };
      }
    }

    if (!ctx.win) return { success: false };
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
// 侧边栏 → AI 视图：发送消息并**自动提交**（区别于 insert-to-chat 的只填入）
ipcMainForProfile.handle('shell-send-to-chat', async (event, { text, tag } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const wc = windowState.getViewWebContents(ctx);
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-send-to-chat', { text: String(text || ''), tag: tag || '' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMainForProfile.handle('shell-insert-to-chat', async (event, { text, tag, delay } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const wc = windowState.getViewWebContents(ctx);
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-insert-to-chat', { text: String(text||''), tag: tag||'', delay: (typeof delay==='number'?delay:undefined) });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：发起新会话（导航到平台首页）
ipcMainForProfile.handle('shell-new-chat', async (event) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const wc = windowState.getViewWebContents(ctx);
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    let homeUrl = null;
    try { const { getProviderByUrl } = require('../providers'); const p = getProviderByUrl(wc.getURL()); if (p && p.homeUrl) homeUrl = p.homeUrl; } catch (_) {}
    if (!homeUrl) return { success: false, error: '无法确定平台首页' };
    await wc.loadURL(homeUrl);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ===== 跨窗口 Token 轮转 IPC（6 个通道）=====
// 主进程只负责「选目标窗口 + 中继数据 + 管超时」，不碰任何 localStorage、不删任何会话。
// 删旧会话永远由源窗口在 ack 成功后执行。
try {
  const rotation = require('./token-rotation');
  const { getProviderByUrl } = require('../providers');

  /** 取窗口上下文的 AI 视图 wc；不可用返回 null */
  const rotGetWc = (ctx) => (ctx ? windowState.getViewWebContents(ctx) : null);

  /** 该 profile 的窗口是否可接收派发（存在 && 不忙） */
  function rotIsAvailable(profileId) {
    const ctx = windowState.getWindowByProfileId(profileId);
    const wc = rotGetWc(ctx);
    if (!wc) return false;
    try {
      // 生成中视为忙：不能把迁移数据塞进正在跑的会话
      if (generationState.get(wc.id)) return false;
    } catch (_) {}
    return true;
  }

  /** 把窗口导航到平台首页并等加载完成 */
  async function rotEnsureHome(ctx, wc) {
    let homeUrl = null;
    try {
      const p = getProviderByUrl(wc.getURL());
      if (p && p.homeUrl) homeUrl = p.homeUrl;
    } catch (_) {}
    if (!homeUrl) return false;
    if (String(wc.getURL() || '').startsWith(homeUrl)) return true;
    await wc.loadURL(homeUrl);
    return true;
  }

  ipcMainForProfile.handle('rotation-get-config', async () => {
    try {
      return { success: true, config: rotation.getConfig() };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMainForProfile.handle('rotation-set-config', async (event, { patch } = {}) => {
    try {
      return { success: true, config: rotation.updateConfig(patch) };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMainForProfile.handle('rotation-reset', async () => {
    try {
      return { success: true, config: rotation.resetState() };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMainForProfile.handle('rotation-list-candidates', async () => {
    try {
      const cfg = rotation.getConfig();
      const profiles = profileManager.readProfiles();
      const windows = rotation.buildCandidates(
        profiles,
        cfg,
        (pid) => windowState.getWindowByProfileId(pid),
        (pid) => !rotIsAvailable(pid),
      );
      return { success: true, windows };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMainForProfile.handle('rotation-submit', async (event, { data } = {}) => {
    try {
      const srcCtx = windowState.getContextByWebContents(event.sender);
      if (!srcCtx) return { success: false, reason: 'no-source' };
      const sourceProfileId = srcCtx.profileId;
      const cfg = rotation.getConfig();
      const poolItem = (cfg.pool || []).find((x) => x && x.profileId === sourceProfileId);
      const sourceAccountTag = poolItem ? (poolItem.accountTag || '') : '';

      const result = await rotation.submit(sourceProfileId, sourceAccountTag, data || {}, {
        isAvailable: rotIsAvailable,
        dispatch: async (targetProfileId, requestId, payload) => {
          const targetCtx = windowState.getWindowByProfileId(targetProfileId);
          const wc = rotGetWc(targetCtx);
          if (!wc) throw new Error('目标窗口不可用');
          const okHome = await rotEnsureHome(targetCtx, wc);
          if (!okHome) throw new Error('无法确定目标平台首页');
          wc.send('lingya-received-migration', { requestId, ...payload });
        },
        onResult: (srcProfileId, res) => {
          // 回告源窗口：找不到窗口就静默丢弃（源窗口可能已被关闭）
          try {
            const ctx = windowState.getWindowByProfileId(srcProfileId);
            const raw = ctx && ctx.rawWin;
            if (raw && !raw.isDestroyed() && raw.webContents && !raw.webContents.isDestroyed()) {
              raw.webContents.send('lingya-rotation-result', res);
            }
          } catch (err) {
            console.error('[Rotation] 回告源窗口失败:', err.message);
          }
        },
      });
      if (!result.ok) return { success: false, reason: result.reason };
      return { success: true, targetProfileId: result.targetProfileId, requestId: result.requestId };
    } catch (err) { return { success: false, reason: 'error', error: err.message }; }
  });

  ipcMainForProfile.handle('rotation-ack', async (event, { requestId, ok, error } = {}) => {
    try {
      const hit = rotation.ack(String(requestId || ''), ok === true, error);
      return { success: hit };
    } catch (err) { return { success: false, error: err.message }; }
  });
} catch (err) {
  console.error('[LingYa] 注册轮转 IPC 失败:', err.message);
}

// 侧边栏 → AI 视图：执行一个动作（生成文档/沉浸式/停止/压缩/手动解析/导出对话）
ipcMainForProfile.handle('shell-run-action', async (event, { action } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const wc = windowState.getViewWebContents(ctx);
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-run-action', { action: String(action||'') });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：设置偏好（自动注入 / 发送延迟），写入 AI 视图 localStorage
// ===== 窗口合并 / 拆分 =====
// 合并：把「发起方窗口」当前显示的视图搬到 targetWindowId 窗口里并排显示。
// 视图的原 ctx（profile / sessionStore）保持不动，因此工具调用回传不受影响。
/**
 * 执行一次窗口合并（IPC 与「应用预设」共用）
 * @param {object} hostCtx 宿主窗口上下文（保留）
 * @param {object} sourceCtx 来源窗口上下文（视图搬走后关闭）
 * @param {'horizontal'|'vertical'} direction
 */
async function performMerge(hostCtx, sourceCtx, direction) {
  try {
    const plan = windowMerge.planMerge(hostCtx, sourceCtx, direction);
    if (!plan.ok) return { success: false, error: plan.error };

    const hostWin = hostCtx.rawWin;
    const sourceWin = sourceCtx.rawWin;
    if (!hostWin || hostWin.isDestroyed()) return { success: false, error: '发起窗口已销毁' };
    if (!sourceWin || sourceWin.isDestroyed()) return { success: false, error: '目标窗口已销毁' };

    // 1) 为来源窗口创建独立的侧边栏视图
    let sidebarView = null;
    try {
      const profileData = profileManager.getProfileById(sourceCtx.profileId);
      if (profileData) {
        sidebarView = new (require('electron').WebContentsView)({
          webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            partition: profileData.partition,
            additionalArguments: ['--lingya-user-data=' + app.getPath('userData')],
          }
        });
        sidebarView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
        // 注册归属，让这个侧边栏发出的 IPC 能找到原上下文
        windowState.rememberViewOwner(sidebarView.webContents, sourceCtx);
      }
    } catch (e) {
      console.error('[LingYa] 创建分屏侧边栏失败:', e.message);
    }

    // 2) 从来源窗口摘下视图
    try { sourceWin.contentView.removeChildView(plan.view); } catch (_) {}

    // 3) 挂到宿主窗口
    hostWin.contentView.addChildView(plan.view);
    if (sidebarView) hostWin.contentView.addChildView(sidebarView);

    const panel = {
      view: plan.view,
      sidebarView: sidebarView,
      sidebarOpen: false,
      sidebarWidth: 320,
    };
    windowState.addAttachedView(hostCtx.win.id, panel);
    hostCtx.splitDirection = plan.direction;
    // 方向可能变了（左右↔上下），旧滚动值会错位，统一归零
    hostCtx.scrollX = 0;
    hostCtx.scrollY = 0;

    // 4) 登记视图归属（sourceCtx 就是 owner，工具调用靠它找回 profile/session）
    //    注意：不要覆写 sourceCtx.win / rawWin —— 那会让后续逻辑误把宿主当来源
    sourceCtx.hostCtx = hostCtx;
    windowState.rememberViewOwner(plan.view.webContents, sourceCtx);

    // 5) 关闭来源窗口的其余标签视图（只搬走了 active tab，其余留着会泄漏）
    try {
      const keepView = plan.view;
      if (sourceCtx.tabs) {
        for (const t of sourceCtx.tabs.values()) {
          if (!t.view || t.view === keepView) continue;
          try { t.view.webContents.close(); } catch (_) {}
        }
      }
      // 只保留搬走的那个标签，避免 sourceCtx.tabs 引用已销毁视图
      if (sourceCtx.tabs && sourceCtx.activeTabId) {
        const keep = sourceCtx.tabs.get(sourceCtx.activeTabId);
        sourceCtx.tabs.clear();
        if (keep) sourceCtx.tabs.set(sourceCtx.activeTabId, keep);
      }
    } catch (_) {}

    // 6) 来源窗口已空，关闭它（先存 id，避免后续 ctx 变动）
    const sourceId = sourceCtx.win.id;
    try { sourceWin.destroy(); } catch (_) {}
    try { windowState.removeWindow(sourceId); } catch (_) {}

    // 5) 重排宿主窗口
    layoutAIView(hostWin);
    try {
      hostWin.webContents.send('lingya-split-changed', {
        split: plan.direction,
        count: (hostCtx.attachedViews || []).length,
      });
    } catch (_) {}

    return { success: true, direction: plan.direction };
  } catch (err) { return { success: false, error: err.message }; }
}

// ========== 分屏布局预设 ==========
// 快照当前窗口的分屏布局（方向 + 各面板的 profileId 序列）
// 面板顺序：index 0 = 宿主窗口自己的活动标签，1..N = attachedViews 顺序

/** 取某个 ctx 的活动视图对应 profile */
function profileOfCtx(ctx) {
  if (!ctx) return null;
  const activeTab = ctx.tabs ? ctx.tabs.get(ctx.activeTabId) : null;
  let title = '';
  let url = '';
  try {
    if (activeTab && activeTab.view) {
      title = activeTab.view.webContents.getTitle() || '';
      url = activeTab.view.webContents.getURL() || '';
    }
  } catch (_) {}
  const prof = profileManager.getProfileById(ctx.profileId);
  return {
    profileId: ctx.profileId || '',
    profileName: (prof && prof.name) || '',
    providerId: (prof && prof.providerId) || ctx.providerId || '',
    title,
    url,
  };
}

ipcMainForProfile.handle('preset-list', async () => {
  try {
    return { success: true, presets: getPresetStore().list() };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMainForProfile.handle('preset-save', async (event, { name, id } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '找不到窗口' };
    const hostCtx = ctx.hostCtx || ctx;
    const attached = hostCtx.attachedViews || [];
    if (!attached.length) return { success: false, error: '当前窗口没有分屏，先合并几个窗口再保存' };

    const panels = [profileOfCtx(hostCtx)];
    for (const p of attached) {
      const oCtx = windowState.getContextByWebContents(p.view.webContents);
      const base = profileOfCtx(oCtx || hostCtx);
      let title = '', url = '';
      try {
        title = p.view.webContents.getTitle() || '';
        url = p.view.webContents.getURL() || '';
      } catch (_) {}
      panels.push({ ...base, title, url });
    }

    const res = getPresetStore().save({ name, direction: hostCtx.splitDirection || 'horizontal', panels }, id);
    if (res.ok) getPresetStore().flush();
    return res.ok ? { success: true, preset: res.preset } : { success: false, error: res.error };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMainForProfile.handle('preset-rename', async (_event, { id, name } = {}) => {
  try {
    const res = getPresetStore().rename(id, name);
    if (res.ok) getPresetStore().flush();
    return res.ok ? { success: true } : { success: false, error: res.error };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMainForProfile.handle('preset-delete', async (_event, { id } = {}) => {
  try {
    const res = getPresetStore().remove(id);
    if (res.ok) getPresetStore().flush();
    return res.ok ? { success: true } : { success: false, error: res.error };
  } catch (err) { return { success: false, error: err.message }; }
});

/**
 * 应用预设：按 profileId 找回窗口（找不到就按 providerId 新建），
 * 然后把它们依次合并进第一个窗口，最后按预设方向布局。
 */
ipcMainForProfile.handle('preset-apply', async (event, { id } = {}) => {
  try {
    const preset = getPresetStore().get(id);
    if (!preset) return { success: false, error: '预设不存在' };
    const panels = preset.panels || [];
    if (panels.length < 2) return { success: false, error: '预设面板数不足，无法应用' };

    const direction = preset.direction === 'vertical' ? 'vertical' : 'horizontal';
    const missing = [];

    // 1) 逐个面板解析出 ctx：已在开的窗口直接用；已合并在某个宿主里的也算「已开」；
    //    两者都没有才按原 profileId 重新打开窗口。
    //    注意：已合并在宿主里的面板不能重复开窗口，否则会出现两个同 profile 的窗口。
    const findHostOfAttached = (profileId) => {
      for (const c of windowState.getAllContexts()) {
        for (const panel of (c.attachedViews || [])) {
          const o = windowState.getContextByWebContents(panel.view.webContents);
          if (o && o.profileId === profileId) return { host: c, owner: o };
        }
      }
      return null;
    };

    const ctxs = [];
    for (const p of panels) {
      let found = p.profileId ? windowState.getWindowByProfileId(p.profileId) : null;
      if (!found && p.profileId) {
        // 已合并在某个宿主里：先把它从该宿主拆出来，变成独立窗口后再参与合并，
        // 否则会把整个宿主窗口当成「一个面板」，布局就错了。
        const hit = findHostOfAttached(p.profileId);
        if (hit) {
          let wcId = null;
          for (const panel of (hit.host.attachedViews || [])) {
            const o = windowState.getContextByWebContents(panel.view.webContents);
            if (o && o.profileId === p.profileId) { wcId = panel.view.webContents.id; break; }
          }
          if (wcId != null) {
            const unRes = await performUnmerge(hit.host, wcId);
            if (unRes && unRes.success) {
              found = windowState.getWindowByProfileId(p.profileId);
            }
          }
        }
      }
      if (!found) {
        // 优先按原 profileId 找回 profile 配置（保留账号/分区/窗口尺寸），
        // 只有该 profile 已被用户删除时，才降级为新建一个。
        let prof = p.profileId ? profileManager.getProfileById(p.profileId) : null;
        if (!prof) {
          prof = profileManager.createProfile(p.profileName || '预设窗口', p.providerId || '');
        }
        createWindow(prof);
        const newCtx = windowState.getWindowByProfileId(prof.id);
        if (newCtx) {
          found = newCtx;
          // 恢复预设里记录的会话 URL（覆盖默认首页）
          if (p.url) {
            try {
              const tab = newCtx.tabs ? newCtx.tabs.get(newCtx.activeTabId) : null;
              if (tab && tab.view) await tab.view.webContents.loadURL(p.url);
            } catch (_) { /* URL 加载失败不影响合并 */ }
          }
        }
        missing.push(p.profileName || p.providerId || '未知');
      }
      if (found) ctxs.push(found);
    }

    if (ctxs.length < 2) return { success: false, error: '可用窗口不足 2 个，无法应用预设' };

    // 2) 宿主取第一个；若宿主已分屏，先拆干净（应用预设 = 重建布局）
    const hostCtx = ctxs[0];
    if ((hostCtx.attachedViews || []).length) {
      await performUnmerge(hostCtx, null);
    }

    // 3) 依次把其余窗口合并进宿主
    const errors = [];
    for (let i = 1; i < ctxs.length; i++) {
      const src = ctxs[i];
      if (!src.rawWin || src.rawWin.isDestroyed()) { errors.push('窗口已关闭'); continue; }
      const r = await performMerge(hostCtx, src, direction);
      if (!r.success) errors.push(r.error || '合并失败');
    }

    return {
      success: errors.length === 0,
      applied: ctxs.length - errors.length,
      reopened: missing,
      errors,
    };
  } catch (err) { return { success: false, error: err.message }; }
});

// 合并：谁点「合并」，谁就是宿主，被点的那一方视图搬进来、窗口关闭
ipcMainForProfile.handle('window-merge-to', async (event, { targetWindowId, direction } = {}) => {
  const hostCtx = windowState.getContextByWebContents(event.sender);
  if (!hostCtx) return { success: false, error: '找不到发起窗口' };
  // 壳页面传过来的是 profileId（窗口列表用的就是它），也可能直接是 BrowserWindow id
  const sourceCtx = windowState.getWindowByProfileId(targetWindowId)
    || windowState.getWindowContext(targetWindowId);
  if (!sourceCtx) return { success: false, error: '目标窗口不存在（可能已关闭）' };
  return await performMerge(hostCtx, sourceCtx, direction);
});

/**
 * 执行拆分（IPC 与「应用预设」共用）
 * @param {object} ctx 宿主窗口上下文
 * @param {number|null} webContentsId 为空 → 拆全部
 */
async function performUnmerge(ctx, webContentsId) {
  try {
    const hostWin = ctx.rawWin;
    if (!hostWin || hostWin.isDestroyed()) return { success: false, error: '窗口已销毁' };

    const plan = windowMerge.planUnmergeOne(ctx, webContentsId);
    if (!plan.ok) return { success: false, error: plan.error };
    const targets = plan.view ? [plan.view] : plan.views;

    const restoredIds = [];
    for (const view of targets) {
      const ownerCtx = windowState.getContextByWebContents(view.webContents);
      const panels = ctx.attachedViews || [];
      const panel = panels.find(p => p.view === view);

      try { hostWin.contentView.removeChildView(view); } catch (_) {}
      if (panel && panel.sidebarView) {
        try { hostWin.contentView.removeChildView(panel.sidebarView); } catch (_) {}
        try { panel.sidebarView.webContents.close(); } catch (_) {}
      }
      
      windowState.removeAttachedView(ctx.win.id, view);
      try {
        const id = await createRestoredWindow(view, ownerCtx);
        restoredIds.push(id);
      } catch (e) {
        console.error('[LingYa] 拆分视图失败:', e && e.message);
      }
    }

    if (!ctx.attachedViews || ctx.attachedViews.length === 0) {
      ctx.splitDirection = null;
      ctx.scrollX = 0;
      ctx.scrollY = 0;
    }
    layoutAIView(hostWin);
    try {
      hostWin.webContents.send('lingya-split-changed', {
        split: ctx.splitDirection,
        count: (ctx.attachedViews || []).length,
      });
    } catch (_) {}

    return { success: true, windowIds: restoredIds };
  } catch (err) { return { success: false, error: err.message }; }
}

// 拆分：把附加视图还原成独立窗口。
// webContentsId 为空 → 拆全部；传了 → 只拆那一个。
ipcMainForProfile.handle('window-unmerge', async (event, { webContentsId } = {}) => {
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '找不到窗口' };
  return await performUnmerge(ctx, webContentsId);
});

// 查询当前窗口的分屏状态（供 UI 渲染拆分列表 + 滚动条）
ipcMainForProfile.handle('window-split-state', async (event) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '找不到窗口' };
    const panels = ctx.attachedViews || [];
    const profileManager = require('./profile-manager');
    const list = panels.map(p => {
      let title = '窗口';
      try { title = p.view.webContents.getTitle() || title; } catch (_) {}
      // 取附加视图的窗口号（从原 ctx 的 profileId 反查 profile.number）
      let winNo = null;
      try {
        const ownerCtx = windowState.getContextByWebContents(p.view.webContents);
        if (ownerCtx && ownerCtx.profileId) {
          const prof = profileManager.getProfileById(ownerCtx.profileId);
          if (prof && typeof prof.number === 'number') winNo = prof.number;
        }
      } catch (_) {}
      return { webContentsId: p.view.webContents.id, title, winNo };
    });

    // 滚动信息
    let scroll = null, vscroll = null;
    const dir = ctx.splitDirection;
    const hostWin = ctx.rawWin;

    if (dir === 'horizontal' && hostWin && !hostWin.isDestroyed()) {
      const b = hostWin.getContentBounds();
      const sw = currentSidebarWidth(hostWin);
      const w = Math.max(0, b.width - sw);
      let totalSidebarW = 0;
      for (const p of panels) totalSidebarW += (p.sidebarOpen ? (p.sidebarWidth || 320) : 46);
      const count = 1 + panels.length;
      const availW = w - totalSidebarW;
      const viewW = Math.max(SPLIT_MIN_WIDTH, Math.floor(availW / count));
      const contentW = sw + viewW * count + totalSidebarW;
      if (contentW > w) {
        scroll = { viewportWidth: w, contentWidth: contentW, scrollX: ctx.scrollX || 0 };
      }
    } else if (dir === 'vertical' && hostWin && !hostWin.isDestroyed()) {
      const b = hostWin.getContentBounds();
      const h = Math.max(0, b.height - TABBAR_HEIGHT - STATUS_HEIGHT);
      const count = 1 + panels.length;
      const MIN_HEIGHT = 600;
      const viewH = Math.max(MIN_HEIGHT, Math.floor(h / count));
      const contentH = viewH * count;
      if (contentH > h) {
        vscroll = { viewportHeight: h, contentHeight: contentH, scrollY: ctx.scrollY || 0 };
      }
    }

    // 主视图的 webContentsId + 窗口号：供壳页面把主视图也纳入分栏（views 里只有附加视图）
    let mainViewId = null;
    let mainWinNo = null;
    try {
      if (ctx.profileId) {
        const prof = require('./profile-manager').getProfileById(ctx.profileId);
        if (prof && typeof prof.number === 'number') mainWinNo = prof.number;
      }
      if (ctx.view && ctx.view.webContents) {
        mainViewId = ctx.view.webContents.id;
      } else if (ctx.tabs && ctx.activeTabId) {
        // 兼容多标签页架构：视图挂在 tab 上，ctx.view 可能为空
        const activeTab = ctx.tabs.get(ctx.activeTabId);
        if (activeTab && activeTab.view && activeTab.view.webContents) {
          mainViewId = activeTab.view.webContents.id;
        }
      }
    } catch (_) {}
    return { success: true, direction: dir, views: list, mainViewId, mainWinNo, scroll, vscroll };
  } catch (err) { return { success: false, error: err.message }; }
});

// 设置分屏滚动偏移（横向 / 纵向）
ipcMainForProfile.handle('window-split-scroll', async (event, { scrollX, scrollY } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '找不到窗口' };
    const hostWin = ctx.rawWin;
    if (!hostWin || hostWin.isDestroyed()) return { success: false };

    const b = hostWin.getContentBounds();
    const sw = currentSidebarWidth(hostWin);
    const w = Math.max(0, b.width - sw);
    const panels = ctx.attachedViews || [];
    const count = 1 + panels.length;

    if (ctx.splitDirection === 'horizontal') {
      let totalSidebarW = 0;
      for (const p of panels) totalSidebarW += (p.sidebarOpen ? (p.sidebarWidth || 320) : 46);
      const availW = w - totalSidebarW;
      const viewW = Math.max(SPLIT_MIN_WIDTH, Math.floor(availW / count));
      const contentW = sw + viewW * count + totalSidebarW;
      const maxScroll = Math.max(0, contentW - w);
      const x = Math.max(0, Math.min(maxScroll, Number(scrollX) || 0));
      ctx.scrollX = x;
      layoutAIView(hostWin);
      return { success: true, scrollX: x, maxScrollX: maxScroll };
    }

    if (ctx.splitDirection === 'vertical') {
      const h = Math.max(0, b.height - TABBAR_HEIGHT - STATUS_HEIGHT);
      const MIN_HEIGHT = 600;
      const viewH = Math.max(MIN_HEIGHT, Math.floor(h / count));
      const contentH = viewH * count;
      const maxScroll = Math.max(0, contentH - h);
      const y = Math.max(0, Math.min(maxScroll, Number(scrollY) || 0));
      ctx.scrollY = y;
      layoutAIView(hostWin);
      return { success: true, scrollY: y, maxScrollY: maxScroll };
    }

    return { success: false, error: '当前没有分屏' };
  } catch (err) { return { success: false, error: err.message }; }
});

// 聚焦到某个分屏面板（总控台点击卡片时调用）
// 分屏面板都在同一个宿主窗口里，单纯 focus() 没意义 —— 真正要做的是
// 把主窗口的滚动位置挪到该面板可见处（左右分屏滚 X，上下分屏滚 Y）。
ipcMainForProfile.handle('focus-panel', async (event, { webContentsId } = {}) => {
  try {
    const id = Number(webContentsId);
    if (!id) return { success: false, error: '缺少 webContentsId' };

    for (const ctx of windowState.getAllContexts()) {
      const hostWin = ctx.rawWin;
      if (!hostWin || hostWin.isDestroyed()) continue;

      // 找面板索引：0 = 宿主 active tab，1..N = attached
      let idx = -1;
      const activeTab = ctx.tabs ? ctx.tabs.get(ctx.activeTabId) : null;
      if (activeTab && activeTab.view && activeTab.view.webContents.id === id) {
        idx = 0;
      } else {
        const list = ctx.attachedViews || [];
        for (let i = 0; i < list.length; i++) {
          if (list[i].view && list[i].view.webContents.id === id) { idx = i + 1; break; }
        }
      }
      if (idx < 0) continue;

      // 先聚焦并还原窗口
      try { hostWin.focus(); } catch (_) {}
      if (hostWin.isMinimized && hostWin.isMinimized()) {
        try { hostWin.restore(); } catch (_) {}
      }

      // 没有分屏 → 无需滚动
      if (!ctx.splitDirection || !(ctx.attachedViews || []).length) {
        return { success: true, scrolled: false };
      }

      const b = hostWin.getContentBounds();
      const sw = currentSidebarWidth(hostWin);
      const w = Math.max(0, b.width - sw);
      const h = Math.max(0, b.height - TABBAR_HEIGHT - STATUS_HEIGHT);
      const panels = ctx.attachedViews || [];
      const count = 1 + panels.length;

      if (ctx.splitDirection === 'horizontal') {
        // 每个视图宽度（与 layoutAIView 保持一致）
        let totalSidebarW = 0;
        for (const p of panels) totalSidebarW += (p.sidebarOpen ? (p.sidebarWidth || 320) : 46);
        const availW = w - totalSidebarW;
        const viewW = Math.max(SPLIT_MIN_WIDTH, Math.floor(availW / count));

        // 目标面板在内容坐标系里的左边界：前面每个面板的 viewW + 其侧边栏宽度
        let targetLeft = sw;
        for (let i = 0; i < idx; i++) {
          targetLeft += viewW;
          const p = panels[i];
          if (p) targetLeft += (p.sidebarOpen ? (p.sidebarWidth || 320) : 46);
        }

        const contentW = sw + viewW * count + totalSidebarW;
        const maxScroll = Math.max(0, contentW - w);
        const x = Math.max(0, Math.min(maxScroll, targetLeft - sw));
        ctx.scrollX = x;
        layoutAIView(hostWin);
        return { success: true, scrolled: true, scrollX: x };
      }

      if (ctx.splitDirection === 'vertical') {
        const MIN_HEIGHT = 600;
        const viewH = Math.max(MIN_HEIGHT, Math.floor(h / count));
        const contentH = viewH * count;
        const maxScroll = Math.max(0, contentH - h);
        const y = Math.max(0, Math.min(maxScroll, idx * viewH));
        ctx.scrollY = y;
        layoutAIView(hostWin);
        return { success: true, scrolled: true, scrollY: y };
      }
    }
    return { success: false, error: '找不到对应面板（窗口可能已关闭）' };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMainForProfile.handle('shell-set-setting', async (event, { key, value } = {}) => {
  try {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口不存在' };
    const wc = windowState.getViewWebContents(ctx);
    if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };
    wc.send('lingya-set-setting', { key: String(key||''), value: value });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// 侧边栏 → AI 视图：读偏好（返回 Promise，主进程转发后由 AI 视图回填）
// 简化：不实现读回，侧边栏用固定默认值展示

// AI 视图 → 壳窗口：转发任务状态（供侧边栏状态条展示）
// 为什么需要：侧边栏与 AI 视图是两个独立 webContents，状态真相源（task-state +
// backgroundTasks）在 AI 视图侧。不上报的话，侧边栏完全看不到「AI 正在跑」。
ipcMain.on('lingya-report-task-state', (event, payload) => {
  try {
    // 1) 转发给手机远程服务
    try {
      const remoteMgr = require('./remote/manager');
      if (remoteMgr && typeof remoteMgr.broadcastAiEvent === 'function') {
        remoteMgr.broadcastAiEvent(event.sender.id, 'task-state', payload);
      }
    } catch (_) {}

    // 2) 记录下来，供「全部分屏」总控台判定 AI 是否在生成
    //    键用 AI 视图自己的 webContents.id —— 总控台按面板视图 id 查
    try {
      const wcId = event.sender && event.sender.id;
      const before = generationState.get(wcId);
      generationState.set(wcId, payload);
      const after = generationState.get(wcId);
      const bGen = !!(before && before.generating);
      const aGen = !!(after && after.generating);
      const bText = before ? before.text : '';
      const aText = after ? after.text : '';
      const changed = (bGen !== aGen) || (bGen && aGen && bText !== aText);
      if (changed) {
        for (const c of windowState.getAllContexts()) {
          const raw = c.rawWin;
          if (raw && !raw.isDestroyed() && raw.webContents) {
            raw.webContents.send('lingya-all-todos-changed');
          }
        }
      }
    } catch (_) {}

    // 2) 转发给壳窗口侧边栏
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return;
    const rawWin = ctx.rawWin || ctx.win;
    if (rawWin && !rawWin.isDestroyed() && rawWin.webContents) {
      rawWin.webContents.send('lingya-task-state-updated', payload);
    }
  } catch (_) {}
});

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

// 调整窗口顺序（数组顺序即显示顺序，第一位为主窗口）
ipcMainForProfile.handle('reorder-profiles', async (_event, { orderedIds } = {}) => {
  const out = profileManager.reorderProfiles(orderedIds);
  if (!out) return { success: false, error: '参数无效' };
  return { success: true, profiles: out };
});

// 修改窗口编号（重复时占用者及其后顺延）
ipcMainForProfile.handle('update-profile-number', async (_event, { profileId, number } = {}) => {
  const out = profileManager.updateProfileNumber(profileId, number);
  if (!out) return { success: false, error: '参数无效或窗口不存在' };
  return { success: true, profiles: out };
});

// 删除指定 profile（会关闭其窗口）
ipcMainForProfile.handle('delete-profile', async (_event, { profileId }) => {
  if (!profileId) return { success: false, error: '缺少窗口ID' };

  // 1) 独立窗口：直接销毁
  const ctx = windowState.getWindowByProfileId(profileId);
  if (ctx && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.__forceClose = true;
    ctx.win.destroy();
  }

  // 2) 已被合并到别的宿主里：把该面板的视图销毁并从 attachedViews 摘掉
  for (const host of windowState.getAllContexts()) {
    const list = host.attachedViews || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const panel = list[i];
      let owner = null;
      try { owner = windowState.getContextByWebContents(panel.view.webContents); } catch (_) {}
      if (owner && owner.profileId === profileId) {
        try { if (panel.sidebarView) panel.sidebarView.webContents.close(); } catch (_) {}
        try { if (panel.view) panel.view.webContents.close(); } catch (_) {}
        try { if (host.rawWin && !host.rawWin.isDestroyed()) {
          if (panel.view) host.rawWin.contentView.removeChildView(panel.view);
          if (panel.sidebarView) host.rawWin.contentView.removeChildView(panel.sidebarView);
        } } catch (_) {}
        list.splice(i, 1);
      }
    }
    if (list.length === 0) host.splitDirection = null;
    try { if (host.rawWin && !host.rawWin.isDestroyed()) layoutAIView(host.rawWin); } catch (_) {}
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

  // 强制禁用 Windows 11 原生覆盖滚动条，否则自定义 CSS 无法生效
app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar,OverlayScrollbars,WindowsOverlayScrollbar');

// 硬件加速开关（2026-11-06 拟人化改造）：
// 默认开启硬件加速 —— WebGL 渲染器是真实 GPU，指纹更接近普通浏览器用户，
// 避免数美风控 fp.min.js 采集到 UNMASKED_RENDERER_WEBGL = SwiftShader（软件渲染）。
// 旧行为（disableGpu=true）会关闭硬件加速，解决部分 Intel 核显的 GPU 驱动崩溃问题，
// 但 WebGL 会 fallback 到 SwiftShader。用户可在「设置 → 发送延迟 → 性能」中切换。
let _disableGpu = false;
try {
  const _secStore = require('./security-store');
  _disableGpu = _secStore.getConfig().disableGpu === true;
} catch (err) {
  console.warn('[灵鸦] 读取 disableGpu 配置失败，回退为开启硬件加速:', err.message);
  _disableGpu = false;
}
if (_disableGpu) {
  console.log('[灵鸦] 兼容模式：已禁用硬件加速（disableGpu=true）');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
} else {
  console.log('[灵鸦] 已启用硬件加速（WebGL 指纹为真实 GPU）');
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
  // 【审计修复】清理 window.js 里 100ms 节流广播的定时器，防止延迟退出
  try {
    const ws = require('./window');
    if (typeof ws.clearBroadcastTimer === 'function') ws.clearBroadcastTimer();
  } catch (_) {}
  if (quitFlushed) return;
  event.preventDefault();
  quitFlushed = true;
  // 【审计修复 P1】3 秒强制退出兜底：如果 flushAllSessions 卡住，
  // 用户点退出必须能退出，防止主进程永久挂起。
  const forceTimer = setTimeout(() => {
    console.error('[LingYa] 退出清理超时，强制退出');
    try { app.exit(0); } catch (_) {}
  }, 3000);
  if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
  // 终止后台建图子进程，避免退出后留下孤儿进程
  try {
    require('./graphify-builder').cancel();
  } catch (_) {}
  // 停止远程服务与 cloudflared 隧道（防孤儿进程 + 端口残留）
  try {
    require('./remote-ipc').stopAll().catch(() => {});
  } catch (_) {}
  // 刷新会话存档（appendFileSync 已即时落盘，这里只作接口约定兜底）
  try {
    const { createArchiveIpc } = require('./conversation-archive-ipc');
    // archive 实例由 ipc.js 持有，通过全局单例刷新
    if (global.__lingyaArchiveIpc && typeof global.__lingyaArchiveIpc.flushAll === 'function') {
      global.__lingyaArchiveIpc.flushAll();
    }
  } catch (_) {}

  // 先把各窗口的 sessionStore 内存缓存强制落盘（防抖计时器可能还没到点）
  try {
    for (const ctx of windowState.getAllContexts()) {
      const st = ctx && ctx.sessionStore;
      if (st && typeof st.flush === 'function') {
        try { st.flush(); } catch (err) { console.error('[LingYa] flush 会话存储失败:', err && err.message); }
      }
    }
  } catch (err) {
    console.error('[LingYa] 遍历上下文 flush 失败:', err && err.message);
  }
  flushAllSessions().finally(() => {
    app.quit();
  });
});

app.on('activate', () => {
  if (windowState.getAllWindows().length === 0) {
    createWindow(null);
  }
});
