/**
 * LingYa preload 入口
 * 原 preload.js 的全部逻辑拆分为本目录下的模块，此处负责组装与初始化，
 * 初始化时序与原文件保持一致。
 */
console.log('[LingYa] Preload script 开始执行');

// 暴露 electronAPI 到渲染进程（contextBridge + window 兜底）
require('./api');

// 主进程通知规则表已变（侧栏导入/新增/删除/采纳）→ 重新拉取，当前会话立刻用新规则
try {
  if (window.electronAPI && window.electronAPI.onRedactionRulesChanged) {
    window.electronAPI.onRedactionRulesChanged(() => {
      try {
        require('./dom/redaction-filter').refreshRules().then(() => {
          console.log('[⟦自动_1⟧] 脱敏规则已刷新');
        }).catch(() => {});
      } catch (_) {}
    });
  }
} catch (_) {}

// 2026-11-02：初始化时拉取一次脱敏规则，后续 redactText 同步可用
try {
  require('./dom/redaction-filter').refreshRules().then(() => {
    console.log('[LingYa] 脱敏规则已就绪');
  }).catch((err) => {
    console.warn('[LingYa] 脱敏规则加载失败:', err && err.message);
  });
} catch (err) {
  console.warn('[LingYa] 脱敏引擎初始化异常:', err && err.message);
}

const { webFrame } = require('electron');

// ========== 主世界指纹修正（最早注入，先于 hook/页面脚本）==========
// 【封号风险改造 2026-11-01】移植自 Cuckoo-Code 0.8.19：
//  - Electron 默认 navigator.userAgentData.brands 缺少 "Google Chrome" 品牌
//  - navigator.webdriver 可能为 true（或可被反爬库识别）
// 两者都是 Electron 应用默认特征，会被 DeepSeek 等平台的风控识别。
// 必须在页面脚本执行前（preload 阶段）注入到主世界，否则会被页面抢先读到默认值。
try {
  const {
    buildUserAgentDataFix,
    buildChromeObjectFix,
    buildPermissionsFix,
    buildNotificationFix,
    buildNativeMask,
  } = require('../main/user-agent');
  // 2026-11-02：三项反检测补丁（基于实测指纹体检报告）
  //  - window.chrome 空壳（Electron keys:[]）→ 补 runtime/loadTimes/csi/app
  //  - permissions.query 全部 granted → 按 Chrome 默认策略返回 prompt/denied
  //  - Notification.permission granted → default
  // 均通过 webFrame.executeJavaScript 注入主世界，先于页面任何脚本。
  const fixes = [
    ['nativeMask', buildNativeMask()],
    ['userAgentData', buildUserAgentDataFix()],
    ['chrome',        buildChromeObjectFix()],
    ['permissions',   buildPermissionsFix()],
    ['notification',  buildNotificationFix()],
  ];
  for (const [name, code] of fixes) {
    webFrame.executeJavaScript(code).then(
      () => console.log('[LingYa] 主世界指纹修正已注入: ' + name),
      (err) => console.warn('[LingYa] 主世界指纹修正注入失败(' + name + '):', err && err.message)
    );
  }
} catch (err) {
  console.warn('[LingYa] 主世界指纹修正异常:', err && err.message);
}

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

// ========== 回复捕获通道 ==========
// 两条路，二选一：
//  A. CDP 捕获（useCdp: true）—— 主进程 webContents.debugger 监听 Network 域，
//     不碰页面 JS 环境。回复在流结束后由主进程解析并推事件回来。
//  B. 主世界 hook（旧路径）—— 注入覆盖 window.fetch / XHR。
//
// 【为什么优先 A（CDP）】CDP 是进程外监听，页面 JS 完全感知不到：
//  - Hook 会改写 window.fetch / XMLHttpRequest.prototype，页面一行
//    fetch.toString() 就能发现被劫持（即使伪造 native code 也会暴露，
//    见 deepseek.js 的「移除 spoofNative」决策）
//  - CDP 在独立进程监听 Network 域，不触碰页面任何 JS API
//  - 页面内任何反作弊脚本都无法通过 JS 层面探测到 CDP 存在
// 结论：CDP 的检测成本 >> Hook，是更隐蔽的方案。
if (useIntercept) {
  const useCdp = currentProvider && currentProvider.useCdp === true;
  if (useCdp) {
    try {
      const { ipcRenderer } = require('electron');
      require('./dom/cdp-bridge').install();
      ipcRenderer.invoke('lingya-cdp-enable', { providerId: currentProvider.id })
        .then((r) => {
          if (r && r.ok) {
            console.log('[LingYa] CDP 捕获已启用 (' + currentProvider.id + ')');
          } else {
            console.error('[LingYa] CDP 捕获启用失败:', (r && r.error) || '未知原因');
          }
        })
        .catch((err) => {
          console.error('[LingYa] CDP 捕获启用异常:', err && err.message);
        });
    } catch (err) {
      console.error('[LingYa] CDP 桥初始化失败:', err && err.message);
    }
  } else {
    // 旧路径：主世界 hook 注入。必须在页面脚本执行前完成，
    // preload 早于页面脚本执行，此处 executeJavaScript 落在主世界。
    try {
      if (typeof currentProvider.getHookSource === 'function') {
        // 【封号风险改造 2026-11-01】传入随机后缀事件名（防页面脚本预埋监听器）
        const evtNames = require('./dom/evt-names');
        webFrame.executeJavaScript(currentProvider.getHookSource(evtNames)).then(
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
}

// ========== 主进程异常可见化 ==========
// 主进程 global-guard 捕获到未处理异常后会广播 'lingya-main-error'，
// 但此前全项目没有任何监听者 —— 异常被发出来又丢掉，用户和开发者都看不到。
// 这里补上监听：至少落到控制台，同时给用户一个可见提示。
try {
  const { ipcRenderer } = require('electron');
  ipcRenderer.on('lingya-main-error', (_ev, info) => {
    // global-guard 传过来的是 { kind, message, fatal }
    const kind = (info && info.kind) ? String(info.kind) : 'error';
    const fatal = !!(info && info.fatal);
    const msg = (info && info.message) ? String(info.message) : String(info || '未知错误');
    console.error('[LingYa] 主进程异常 [' + kind + ']' + (fatal ? '(致命)' : '') + ': ' + msg);
    try {
      const { showToast } = require('./overlay/ui');
      if (showToast) {
        showToast(
          (fatal ? '主进程发生致命错误，即将退出：' : '主进程异常：') + msg.slice(0, 60),
          fatal ? 15000 : 8000
        );
      }
    } catch (_) { /* 覆盖层尚未就绪时忽略 */ }
  });
} catch (err) {
  console.error('[LingYa] 注册主进程异常监听失败:', err && err.message);
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

  // ===== 全局轻量滚动条样式注入 =====
  // 解决分屏时网页原生滚动条过宽、视觉突兀的问题
  try {
    const style = document.createElement('style');
    style.textContent = `
      /* 横向滚动条也染成青色，保留显示 */
      /* 不再切断横向溢出，顺其自然 */
      /* 纵向滚动条变细、主题青色 */
      ::-webkit-scrollbar {
        width: 10px !important;
        height: 10px !important;
      }
      ::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.03) !important;
      }
      ::-webkit-scrollbar-thumb {
        background: rgba(45, 212, 191, 0.55) !important;
        border-radius: 5px !important;
        border: 2px solid transparent !important;
        background-clip: padding-box !important;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(45, 212, 191, 0.85) !important;
      }
      /* 已删除 scrollbar-color 避免原生接管 */
    `;
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {
    console.warn('[LingYa] 注入全局滚动条样式失败:', e.message);
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

  // 【封号风险改造 2026-11-01】启动限流退避引擎（紧跟拦截器，早于任何发送）
  // 监听 lingya-ai-error(reason=rate_limit) 事件，遇到 429/40029/限流文案时进入
  // 2min → 5min → 15min → 30min 指数退避，期间丢弃所有自动发送。
  try {
    require('./dom/rate-limit-retry').startRateLimitEngine();
  } catch (err) {
    console.error('[LingYa] 限流退避引擎启动失败:', err && err.message);
  }

  // ===== 第 2 层：UI 初始化（失败只影响显示）=====
  try {
    ui.injectCSS();
    ui.injectOverlay();
    // 启动统一任务状态条：订阅状态机，任何「进行中」状态都持续显示（含秒级计时）。
    // 放在 injectOverlay 之后，确保 #lingya-taskbar 已存在。
    ui.startTaskbar();
    projectDir.initProjectDirSection();
    bindEvents();
    ui.updateHomeMode();

    // 监听 URL 变化（SPA 路由）
    window.addEventListener('popstate', ui.updateHomeMode);
    window.addEventListener('hashchange', ui.updateHomeMode);
    // 【2026-11-06 修复 #5】定时器幂等：SPA 路由切换不会卸载 preload，
    // 若 init 被重复调用会叠加 interval 造成内存/CPU 浪费。用模块级标志防重入。
    if (!window.__lyHomeModeTimer) {
      window.__lyHomeModeTimer = setInterval(ui.updateHomeMode, 1500);
    }
    // 首次延迟执行，确保 overlay 已注入
    setTimeout(ui.updateHomeMode, 500);

    // 默认显示覆盖层 - 兜底强制显示
    ui.forceShowOverlay();
  } catch (err) {
    // UI 失败只影响显示，核心执行链路（第 1 层）已在前面独立启动，不受影响
    console.error('[LingYa] UI 初始化失败（不影响工具执行）:', err);
    try { ui.forceShowOverlay(); } catch (_) {}
  }

  // ===== 第 2.5 层：Harness 桥接（纯净模式，独立于 UI）=====
  // 只挂监听器，不阻塞任何流程。harness 视图不存在时上报会被主进程丢弃。
  try {
    require('./harness-bridge').initHarnessBridge();
  } catch (err) {
    console.error('[LingYa] Harness bridge 初始化失败:', err && err.message);
  }

  // ===== 第 3 层：其余子系统（各自独立，任一失败不拖累其他）=====
  try {
    // 眼珠跟随鼠标：鼠标在窗口内时，悬浮球宠物的眼睛朝鼠标方向偏移
    require('./overlay/eye-tracking').startEyeTracking();
  } catch (err) {
    console.error('[LingYa] 眼珠跟随启动失败（不影响工具执行）:', err);
  }

  try {
    // 启动新会话自动注入监视（记忆+技能）
    require('./dom/auto-inject').startAutoInjectWatcher();
  } catch (err) {
    console.error('[LingYa] 自动注入监视启动失败:', err);
  }

  try {
    // 飞书同步：上报用户消息/AI回复/工具状态，并接收飞书来消息
    require('./dom/feishu-bridge').initFeishuBridge();
    require('./dom/weixin-bridge').initWeixinBridge();
    require('./dom/qq-bridge').initQqBridge();
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
    //
    // 执行前先装好 window.__lingyaPluginAPI：插件脚本是裸函数，不能 require
    // 内部模块，靠这个对象发送消息 / 读运行时状态。
    try {
      require('./plugin-api').install();
    } catch (err) {
      console.error('[LingYa] 安装插件运行时 API 失败:', err && err.message);
    }

    try {
      if (window.electronAPI && window.electronAPI.getPluginPreloads) {
        // 延迟到下一个宏任务再执行，避免同步阻塞 init 主流程
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

    // 【对齐 Cuckoo 2026-11-01】DeepSeek 侧栏「对话归档」注入已停用。
    // 原因：往 DeepSeek 原生侧栏插入「📦 已归档」分组，会破坏页面原貌，
    // 且增加 DOM 指纹（与 Cuckoo-Code 不碰页面 DOM 的做法冲突）。
    // 保留 archiver 模块本身（deleteSessionSilent 用于轮转/迁移时删旧会话，不注入任何 UI）。
    // 此处调 stop() 清理：万一老版本或插件已启动过 archiver，重启时把注入的 DOM 清掉。
    try {
      if (currentProvider && currentProvider.id === 'deepseek') {
        try {
          const archiver = require('./dom/deepseek-history-archiver');
          if (archiver && typeof archiver.stop === 'function') archiver.stop();
        } catch (e) { /* 模块未加载时忽略 */ }
      }
    } catch (e) {
      console.error('[LingYa] 归档清理失败:', e.message);
    }

  } catch (err) {
    // 第 3 层兜底：这里的异常只可能来自插件/归档/标题同步等辅助功能。
    // 核心链路（第 1 层）与 UI（第 2 层）都已独立 try，不受影响。
    console.error('[LingYa] 辅助子系统初始化失败（不影响核心执行）:', err);
  }

  // 对话记录：累积用户/AI 消息，供导出 Markdown
  try {
    require('./dom/conversation-log').initConversationLog();
    // 2026-11-05: 启动 DOM 占位符还原——AI 回复里的 ⟦xxx⟧ 在本地显示时换回真词
    try {
      require('./dom/dom-unredact').startDomUnredact();
    } catch (e) { console.warn('[灵鸦] DOM 还原启动失败:', e && e.message); }
  } catch (err) {
    console.error('[LingYa] 对话记录启动失败:', err);
  }

  // 定期巡检：防止面板被意外隐藏
  ui.startOverlayWatcher();

  // 定期提取当前平台用户信息并更新窗口名
  // 【2026-11-06 修复 #5】幂等保护
  if (!window.__lyUserNameTimer) {
    let lastSentUserName = '';
    window.__lyUserNameTimer = setInterval(() => {
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
