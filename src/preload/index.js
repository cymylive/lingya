/**
 * LingYa preload 入口
 * 原 preload.js 的全部逻辑拆分为本目录下的模块，此处负责组装与初始化，
 * 初始化时序与原文件保持一致。
 */
console.log('[LingYa] Preload script 开始执行');

// 暴露 electronAPI 到渲染进程（contextBridge + window 兜底）
require('./api');

const { webFrame } = require('electron');
const ui = require('./overlay/ui');
const projectDir = require('./overlay/project-dir');
const bindEvents = require('./overlay/events');
const chatInput = require('./dom/chat-input');
const { getProviderByUrl } = require('../providers');
const toolNames = require('./tool-names');

// ========== 平台识别 ==========
// 在 init 之前先判断当前平台，决定走"网络拦截"还是"DOM 抓取"模式
const currentProvider = getProviderByUrl(window.location.href);
const useIntercept = !!(currentProvider && currentProvider.useIntercept);
console.log('[LingYa] 平台=' + (currentProvider ? currentProvider.id : 'unknown') +
  ', 模式=' + (useIntercept ? '网络拦截' : 'DOM 抓取'));

// ========== 主世界注入（拦截模式）==========
// 必须在页面脚本执行前把 hook 注入到主世界，才能覆盖到 window.fetch / XHR。
// preload 早于页面脚本执行，此处的 executeJavaScript 落在主世界。
if (useIntercept) {
  try {
    if (typeof currentProvider.getHookSource === 'function') {
      webFrame.executeJavaScript(currentProvider.getHookSource()).then(
        () => console.log('[LingYa] 主世界拦截器注入成功 (' + currentProvider.id + ')'),
        (err) => console.error('[LingYa] 主世界拦截器注入失败:', err && err.message)
      );
    } else {
      console.warn('[LingYa] 平台 ' + currentProvider.id + ' 未提供 getHookSource()');
    }
  } catch (err) {
    console.error('[LingYa] 加载拦截器失败:', err);
  }
}

// 以下仅对 AI 平台页面生效；非 AI 平台（AI 开的普通网页标签）不注册，避免无谓开销
if (currentProvider) {
  // 注册主进程消息监听（与原 preload.js 顶层注册时机一致）
  chatInput.registerIpcListeners();

  // 工具名集合：拉取一次 + 监听主进程广播（插件启用/禁用后刷新白名单）
  toolNames.refreshToolNames().catch(() => {});
  toolNames.setupToolNamesListener();
}

// ========== 初始化 ==========

/**
 * 初始化 LingYa 扩展
 * 注入样式、覆盖层 HTML，绑定事件，启动回复监听（拦截或 DOM 观察）
 */
function init() {
  // ===== 非 AI 平台页面（如 AI 开的百度标签、任意网页）=====
  // 不注入任何 LingYa UI（悬浮球 / 覆盖层面板 / 计划卡），保持网页原样。
  // 仍保留 electronAPI（供 injectJS 等工具使用）与 IPC 监听（无害）。
  if (!currentProvider) {
    console.log('[LingYa] 当前页面不是 AI 平台（' + location.href + '），跳过覆盖层注入');
    return;
  }

  // ===== 第 1 层：核心执行链路（必须先于一切 UI）=====
  // 【架构不变量】拦截器是 Agent 循环的心脏，必须最先启动，且与 UI 初始化完全解耦。
  //
  // 0.6.94 静默停摆 bug 根因：startInterceptObserver() 曾埋在 UI try 块内、排在
  // ui.injectCSS()/injectOverlay()/bindEvents() 之后。任一 UI 步骤抛异常 → catch
  // → 事件监听器从未注册 → AI 回复到达但无人接收 → 工具永不执行；而 catch 里的
  // forceShowOverlay() 又把面板强行显示出来，伪装成"一切正常"，用户完全无从发现。
  //
  // 此不变量由 test/preload/preload-init-order.test.js 锁定，改动前请先读它。
  let interceptObserver = null;
  try {
    interceptObserver = require('./dom/intercept-observer');
    interceptObserver.startInterceptObserver();
  } catch (err) {
    console.error('[LingYa][致命] 拦截器启动失败，Agent 循环不可用:', err);
  }

  // 第 1 层：手动触发拒绝改写（依赖 interceptObserver，与 UI 显示无关）
  try {
    if (interceptObserver && window.electronAPI && window.electronAPI.onManualRewrite) {
      window.electronAPI.onManualRewrite((payload) => {
        const requestId = (payload && payload.requestId) || '';
        interceptObserver.manualRewrite().then((res) => {
          try {
            if (window.electronAPI.sendManualRewriteResult) {
              window.electronAPI.sendManualRewriteResult(requestId, res || { success: false, error: '空结果' });
            }
          } catch (_) {}
        }).catch((err) => {
          try {
            if (window.electronAPI.sendManualRewriteResult) {
              window.electronAPI.sendManualRewriteResult(requestId, { success: false, error: err.message });
            }
          } catch (_) {}
        });
      });
    }
  } catch (err) {
    console.error('[LingYa][致命] 手动改写监听注册失败:', err);
  }

  // 第 1 层：停滞监督者（兜底心跳，绝不能因 UI 失败而丢）
  try {
    require('./dom/supervisor').startSupervisor();
  } catch (err) {
    console.error('[LingYa][致命] 监督者启动失败:', err);
  }

  // ===== 第 2 层：UI 初始化（失败只影响显示，不影响执行）=====
  try {
    ui.injectCSS();
    ui.injectOverlay();
    projectDir.initProjectDirSection();
    bindEvents();
    ui.updateHomeMode();

    // 监听 URL 变化（SPA 路由）
    window.addEventListener('popstate', ui.updateHomeMode);
    window.addEventListener('hashchange', ui.updateHomeMode);
    setInterval(ui.updateHomeMode, 1500);
    // 首次延迟执行，确保 overlay 已注入
    setTimeout(ui.updateHomeMode, 500);

    // 默认显示覆盖层 - 兜底强制显示
    ui.forceShowOverlay();
  } catch (err) {
    // UI 失败只影响显示，核心执行链路（第 1 层）已在前面独立启动，不受影响
    console.error('[LingYa] UI 初始化失败（不影响工具执行）:', err);
    try { ui.forceShowOverlay(); } catch (_) {}
  }

  // ===== 第 3 层：其余子系统（各自独立，任一失败不拖累其他）=====
  try {
    // 启动新会话自动注入监视（记忆+技能）
    require('./dom/auto-inject').startAutoInjectWatcher();
  } catch (err) {
    console.error('[LingYa] 自动注入监视启动失败:', err);
  }

  try {
    // 飞书同步：上报用户消息/AI回复/工具状态，并接收飞书来消息
    require('./dom/feishu-bridge').initFeishuBridge();
  } catch (err) {
    console.error('[LingYa] 飞书同步启动失败:', err);
  }

  try {
    // 定时任务：接收主进程下发的任务指令并发送给 AI
    require('./dom/schedule-bridge').initScheduleBridge();
  } catch (err) {
    console.error('[LingYa] 定时任务桥接启动失败:', err);
  }

  try {
    // ===== 执行插件注册的 preload 脚本 =====
    // 插件通过 ctx.registerPreload(scriptText) 注册脚本，主进程收集后经 IPC 返回，
    // 这里在页面渲染进程里执行（可挂钩 DOM / 网络）。
    try {
      if (window.electronAPI && window.electronAPI.getPluginPreloads) {
        // 延迟到下一个宏任务再执行，避免同步阻塞 init 主流程（否则会影响 supervisor 的 setInterval 精度）
        setTimeout(function () {
          window.electronAPI.getPluginPreloads().then(function (r) {
            if (!r || !r.success) return;
            var list = r.scripts || [];
            // 每个脚本再单独用 setTimeout 包裹，保证任一插件卡住也不会拖累其他插件和主流程
            list.forEach(function (item) {
              setTimeout(function () {
                try {
                  new Function(item.script)();
                  console.log('[LingYa] 插件 preload 已执行: ' + item.pluginId);
                } catch (e) {
                  console.error('[LingYa] 插件 preload 执行失败 (' + item.pluginId + '):', e && e.message);
                }
              }, 0);
            });
          })['catch'](function (e) {
            console.error('[LingYa] 获取插件 preload 失败:', e && e.message);
          });
        }, 0);
      }
    } catch (_) {}

    // DeepSeek 侧栏「对话归档」注入（仅 DeepSeek 平台）
    // 优先走插件（plugins/deepseek-archive）；插件未启用时才用内置版本，避免重复注入。
    try {
      if (currentProvider && currentProvider.id === 'deepseek') {
        var __needBuiltinArchiver = true;
        try {
          if (window.electronAPI && window.electronAPI.pluginList) {
            window.electronAPI.pluginList().then(function (pr) {
              var plugins = (pr && pr.success && pr.plugins) || [];
              var archPlugin = null;
              for (var i = 0; i < plugins.length; i++) {
                if (plugins[i].id === 'deepseek-archive') { archPlugin = plugins[i]; break; }
              }
              if (archPlugin && archPlugin.enabled) {
                console.log('[LingYa] 归档由插件提供，跳过内置版本');
                return;
              }
              // 插件未启用 → 用内置
              try { require('./dom/deepseek-history-archiver').start(); } catch (e) {
                console.error('[LingYa] 启动内置归档失败:', e && e.message);
              }
            })['catch'](function () {
              try { require('./dom/deepseek-history-archiver').start(); } catch (_) {}
            });
            __needBuiltinArchiver = false;
          }
        } catch (_) {}
        if (__needBuiltinArchiver) {
          require('./dom/deepseek-history-archiver').start();
        }
      }
    } catch (e) {
      console.error('[LingYa] 启动 DeepSeek 归档注入失败:', e.message);
    }

    // 会话标题更新 → 调平台 API 改名 + DOM 双写（含 MutationObserver 守护）
    // （nameConversation / 手动改名原本只改 LingYa 本地存储，不碰网页自身 UI）
    try {
      if (window.electronAPI && window.electronAPI.onSessionTitleUpdated) {
        window.electronAPI.onSessionTitleUpdated(async (payload) => {
          try {
            const p = payload || {};
            const newTitle = String(p.title || '').trim();
            const sid = String(p.sessionId || '').trim();
            if (!newTitle || !sid) return;
            // 标记已命名：无论来源是 AI 自动命名 / 用户手动改名 / 自动重命名，
            // 后续 init-project 都不该再触发一次自动重命名
            try { require('./dom/auto-rename').markRenamed(sid); } catch (_) {}
            const sync = require('./dom/page-title-sync');
            const r = await sync.syncSessionTitle(sid, newTitle);
            console.log('[LingYa] 会话标题同步: ' + JSON.stringify({
              sid, title: newTitle, api: r.api, dom: r.dom, current: r.current,
            }));
          } catch (e) { console.error('[LingYa] 同步会话标题失败:', e.message); }
        });
      }

      // SPA 路由切换后重新应用标题（DeepSeek 是 pushState 导航）
      const syncMod = require('./dom/page-title-sync');
      window.addEventListener('popstate', () => { try { syncMod.onUrlChanged(); } catch (_) {} });
      let lastHref = location.href;
      setInterval(() => {
        if (location.href !== lastHref) { lastHref = location.href; try { syncMod.onUrlChanged(); } catch (_) {} }
      }, 800);
    } catch (_) { /* ignore */ }
  } catch (err) {
    // 第 3 层兜底：这里的异常只可能来自插件/归档/标题同步等辅助功能。
    // 核心链路（第 1 层）与 UI（第 2 层）都已独立 try，不受影响。
    console.error('[LingYa] 辅助子系统初始化失败（不影响核心执行）:', err);
  }

  // 对话记录：累积用户/AI 消息，供导出 Markdown
  try {
    require('./dom/conversation-log').initConversationLog();
  } catch (err) {
    console.error('[LingYa] 对话记录启动失败:', err);
  }

  // 定期巡检：防止面板被意外隐藏
  ui.startOverlayWatcher();

  // 定期提取当前平台用户信息并更新窗口名
  let lastSentUserName = '';
  setInterval(() => {
    try {
      const provider = getProviderByUrl(window.location.href);
      if (!provider || typeof provider.extractUserInfo !== 'function') return;
      const text = provider.extractUserInfo();
      if (text && text !== lastSentUserName) {
        lastSentUserName = text;
        window.electronAPI.updateWindowName(text).catch(() => {});
      }
    } catch (e) {
      console.error('[LingYa] 轮询用户名异常:', e.message);
    }
  }, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
