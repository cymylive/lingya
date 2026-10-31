/**
 * 覆盖层按钮事件绑定
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const state = require('../dom/state');
const { hideOverlay, showOverlay, renderHistory, commandHistory, showToast, showConfirmDialog, hideFirstTimeDialog, setStopped, clearBackgroundTasks, setFabSize } = require('./ui');
const { handleInitProject, renderSessions } = require('../dom/session-list');
const { sendToChat } = require('../dom/chat-input');
const { runCompaction, checkPendingInit } = require('../dom/compaction');
const { bindMemoryPanelEvents, closeMemoryManager } = require('./memory-panel');
const { bindSkillPanelEvents, closeSkillManager } = require('./skill-panel');
const { bindSecurityPanelEvents, closeSecurityManager } = require('./security-panel');
const { bindFeishuPanelEvents, closeFeishuManager } = require('./feishu-panel');
const { bindWeixinPanelEvents, closeWeixinManager } = require('./weixin-panel');
const { bindCommPanelEvents, closeCommManager } = require('./comm-panel');
const { bindQqPanelEvents, closeQqManager } = require('./qq-panel');
const { bindSchedulePanelEvents, closeScheduleManager } = require('./schedule-panel');
const { bindAgentPanelEvents } = require('./agent-panel');
const { bindPlanPanelEvents } = require('./plan-panel');

/**
 * 绑定页签切换：点击页签显示对应面板，并记住上次选择
 */
function bindTabEvents() {
  const tabbar = document.getElementById('lingya-tabbar');
  if (!tabbar) return;
  const tabs = tabbar.querySelectorAll('.lingya-tab');

  function activate(name) {
    tabs.forEach((t) => t.classList.toggle('lingya-tab-active', t.dataset.tab === name));
    document.querySelectorAll('.lingya-tab-panel').forEach((p) => {
      p.classList.toggle('lingya-tab-panel-active', p.dataset.tab === name);
    });
    try { localStorage.setItem('lingya-active-tab', name); } catch (_) {}
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activate(tab.dataset.tab));
  });

  // 恢复上次选中的页签（默认主页）
  let saved = 'home';
  try { saved = localStorage.getItem('lingya-active-tab') || 'home'; } catch (_) {}
  if (saved !== 'home' && [...tabs].some((t) => t.dataset.tab === saved)) {
    activate(saved);
  }
}

/**
 * 渲染窗口列表（浮动管理面板内）
 */
async function renderWindowList() {
  const list = document.getElementById('lingya-window-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.listProfiles();
    const profiles = res && res.success ? res.profiles : [];
    if (!profiles || profiles.length === 0) {
      list.innerHTML = '<div class="lingya-session-empty">暂无窗口</div>';
      return;
    }
    // 获取平台名映射
    const providerMap = {};
    try {
      const pvRes = await window.electronAPI.listProviders();
      if (pvRes && pvRes.success) {
        (pvRes.providers || []).forEach(pv => { providerMap[pv.id] = pv.name; });
      }
    } catch (_) {}

    list.innerHTML = profiles.map(p => {
      const pname = providerMap[p.providerId] || '平台';
      return '<div class="lingya-window-item" data-profile-id="' + p.id + '">' +
        '<span class="lingya-window-left">' +
          '<span class="lingya-window-name">' + p.name + '</span>' +
          '<span class="lingya-window-sep">|</span>' +
          '<span class="lingya-window-status">' + pname + '</span>' +
        '</span>' +
        '<span class="lingya-window-del" data-profile-id="' + p.id + '" title="删除窗口">删除</span>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.lingya-window-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        // 点击删除按钮不触发切换
        if (e.target.classList.contains('lingya-window-del')) return;
        const profileId = el.dataset.profileId;
        try {
          const r = await window.electronAPI.openProfileWindow(profileId);
          if (r && r.success) {
            showToast(r.focused ? '已切换到该窗口' : '已打开窗口', 2000);
            closeWindowManager();
          } else {
            showToast((r && r.error) || '打开失败', 3000);
          }
        } catch (err) {
          showToast('打开窗口失败: ' + (err.message || err), 3000);
        }
      });
    });
    // 绑定删除按钮
    list.querySelectorAll('.lingya-window-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const profileId = btn.dataset.profileId;
        try {
          const r = await window.electronAPI.deleteProfileWindow(profileId);
          if (r && r.success) {
            showToast('已删除窗口', 2000);
            await renderWindowList();
          } else {
            showToast((r && r.error) || '删除失败', 3000);
          }
        } catch (err) {
          showToast('删除失败: ' + (err.message || err), 3000);
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="lingya-session-empty">加载失败</div>';
  }
}

/**
 * 打开窗口管理浮动面板
 */
function openWindowManager() {
  const panel = document.getElementById('lingya-window-manager');
  if (panel) {
    panel.classList.remove('lingya-hidden');
    renderWindowList();
  }
}

/**
 * 关闭窗口管理浮动面板
 */
function closeWindowManager() {
  const panel = document.getElementById('lingya-window-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/** 保存"新会话自动注入"开关 */
function saveAutoInjectSetting() {
  const el = document.getElementById('lingya-auto-inject');
  try {
    localStorage.setItem('lingya-auto-inject', el && el.checked ? '1' : '0');
  } catch (_) {}
}

/**
 * 停止当前任务：
 *   1) 通知主进程 kill 所有活动子进程并置中止标志
 *   2) 尝试点击页面自带的「停止生成」按钮，中断 AI 输出
 *   3) 置本地 stopped 标志，丢弃后续 AI 回复与工具结果
 */
async function stopTask(silent) {
  // 先置本地标志，避免停止过程中又有回复进入处理
  state.stopped = true;
  // 记录停止时刻：intercept-observer 用它判断「停止后收到的新回复」是否该自动恢复
  state.stoppedAt = Date.now();
  try { await window.electronAPI.stopExecution(); } catch (_) {}
  // 点击页面原生「停止生成」按钮（各平台选择器不同）
  try {
    const { getProviderByUrl } = require('../../providers');
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.findStopButton === 'function') {
      const btn = provider.findStopButton();
      if (btn) btn.click();
    }
  } catch (_) {}
  // 清除生成兜底定时器与生成态
  try {
    const io = require('../dom/intercept-observer');
    if (io.resetGenerating) io.resetGenerating();
  } catch (_) {}
  setStopped(true);
  // 停止时清空后台任务登记（主进程已 kill 全部子进程），否则状态条会一直挂着不消失
  try { clearBackgroundTasks(); } catch (_) {}
  if (!silent) showToast('已停止。发送任意消息即可恢复自动执行', 3000);
}

/**
 * 清除停止状态（用户下次发消息时调用）
 */
async function clearStopped() {
  if (!state.stopped) return;
  state.stopped = false;
  state.stoppedAt = 0;
  try { await window.electronAPI.clearAbort(); } catch (_) {}
  setStopped(false);
}

/**
 * 生成项目说明文档按钮点击处理
 */
function handleGenerateDoc() {
  const message = '根据当前项目生成一个类似 claude.md 的项目说明文件，并将文件放到当前项目 .lingyaCode/LINGYA.md';
  if (!sendToChat(message, '生成文档', 300)) {
    showToast('未找到输入框，请确保已打开聊天界面', 3000);
  }
}

/**
 * 加载配置到 JSON 框
 */
async function loadMcpConfigToJson() {
  const res = await window.electronAPI.listMcpServers();
  const servers = res && res.success ? res.servers : [];
  // 转成主流 mcpServers 格式
  const mcpServers = {};
  for (const s of servers) {
    const def = {};
    if (s.type === 'http') {
      if (s.url) def.url = s.url;
      if (s.headers) def.headers = s.headers;
    } else {
      if (s.command) def.command = s.command;
      if (s.args && s.args.length) def.args = s.args;
      if (s.env) def.env = s.env;
    }
    mcpServers[s.name] = def;
  }
  const jsonInput = document.getElementById('lingya-mcp-json');
  if (jsonInput) jsonInput.value = JSON.stringify({ mcpServers }, null, 2);
}

/**
 * 渲染 MCP server 列表
 */
async function renderMcpList() {
  const list = document.getElementById('lingya-mcp-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.listMcpServers();
    const servers = res && res.success ? res.servers : [];
    if (!servers || servers.length === 0) {
      list.innerHTML = '<div class="lingya-session-empty">暂无 MCP Server</div>';
      return;
    }
    list.innerHTML = servers.map(s => {
      const status = s.connected ? '已连接' : (s.enabled ? '未连接' : '已禁用');
      const statusColor = s.connected ? '#4ade80' : (s.enabled ? '#ffc107' : '#5d6280');
      return '<div class="lingya-window-item lingya-mcp-item" data-mcp-name="' + s.name + '">' +
        '<span class="lingya-window-name">' + s.name + '</span>' +
        '<span class="lingya-mcp-dot" style="width:8px;height:8px;border-radius:50%;background:' + statusColor + ';flex-shrink:0;" title="' + status + '"></span>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.lingya-mcp-item').forEach(el => {
      el.addEventListener('click', async () => {
        const name = el.dataset.mcpName;
        const server = servers.find(s => s.name === name);
        if (!server) return;

        // 点击后立即显示 loading
        const dot = el.querySelector('.lingya-mcp-dot');
        if (dot) dot.style.background = '#ffc107';
        el.style.pointerEvents = 'none';

        try {
          if (server.connected || server.enabled) {
            // 已连接或已启用 → 断开/禁用
            await window.electronAPI.disableMcpServer(name);
            showToast('已断开 ' + name, 2000);
          } else {
            // 未启用 → 连接
            await window.electronAPI.enableMcpServer(name);
            showToast('已连接 ' + name, 2000);
          }
          await renderMcpList();
          await loadMcpConfigToJson();
        } catch (err) {
          showToast('操作失败: ' + (err.message || err), 3000);
          await renderMcpList();
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="lingya-session-empty">加载失败</div>';
  }
}

/**
 * 打开 MCP 管理面板
 */
function openMcpManager() {
  const panel = document.getElementById('lingya-mcp-manager');
  if (panel) {
    panel.classList.remove('lingya-hidden');
    renderMcpList();
    loadMcpConfigToJson();
  }
}

/**
 * 关闭 MCP 管理面板
 */
function closeMcpManager() {
  const panel = document.getElementById('lingya-mcp-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/**
 * 绑定覆盖层所有 UI 事件
 * 包括按钮点击、键盘快捷键、状态徽章点击等
 */
let eventsBound = false;
let mcpSending = false; // 防止 MCP 信息重复发送

/**
 * 手动解析分派：
 * - 拦截模式：复用最近一次拦截到的完整文本（不依赖 DOM）
 * - DOM 模式：走 observer 的 DOM 抓取
 */
function handleManualParseDispatch() {
  const interceptObserver = require('../dom/intercept-observer');
  const text = interceptObserver.getLastInterceptedText();
  if (!text) {
    showToast('暂无可解析的回复（请先让 AI 回复一次）', 3000);
    return;
  }
  showToast('已触发手动解析', 3000);
  interceptObserver.processInterceptedResponse(text, true).catch((err) => {
    console.error('[LingYa] 手动解析出错:', err);
    showToast('手动解析出错: ' + err.message, 3000);
  });
}

/**
 * 格式化 token 数：过万显示为「xxx万」，否则原样显示
 * @param {number} n
 * @returns {string}
 */
function formatTokenCount(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 10000) {
    return (n / 10000).toFixed(2) + '万';
  }
  return String(Math.round(n));
}

/**
 * 刷新面板里的「对话 Token」显示
 * 数据来源：服务端 accumulated_token_usage（含 prompt+输出）；
 * 未收到服务端数据时显示 0。
 */
/**
 * 获取「有效 token 数」——扣除基线偏移后的值。
 * 迁移新建的会话在历史注入完成后会记录基线（state.tokenBaselineBySession[sid]），
 * 之后显示和阈值判定都用 Math.max(0, accumulated - baseline)，让新会话从 0 开始算。
 * 无数据时返回 null（调用方自行处理为显示 0）。
 */
function getEffectiveTokenCount() {
  const server = state.serverTokenUsage;
  if (!server || typeof server.accumulatedTokens !== 'number') return null;
  // 迁移进行中：新会话尚未记录基线，先按 0 显示，避免把承接的历史算进去
  if (state.isMigrating) return 0;
  const sid = state.currentSessionId || '__home__';
  const baseline = (state.tokenBaselineBySession && state.tokenBaselineBySession[sid]) || 0;
  return Math.max(0, server.accumulatedTokens - baseline);
}

function updateConversationTokenDisplay() {
  const countEl = document.getElementById('lingya-conv-token-count');
  
  const effective = getEffectiveTokenCount();
  let tokenText = '0';
  if (effective !== null) {
    tokenText = formatTokenCount(effective);
  }

  if (countEl) {
    countEl.textContent = tokenText;
  }

  // 完全动态创建，不依赖任何模板 HTML
  let fabTokenEl = document.getElementById('lingya-fab-token');
  if (!fabTokenEl) {
    fabTokenEl = document.createElement('div');
    fabTokenEl.id = 'lingya-fab-token';
    // 初始位置放到屏幕外，防止在计算坐标前闪现在左上角
    fabTokenEl.style.cssText = 'position: fixed; left: -9999px; top: -9999px; transform: translate(-50%, -100%); background: rgba(12, 14, 16, 0.95); border: 1px solid #2dd4bf; border-radius: 12px; padding: 2px 8px; font-size: 11px; font-weight: bold; color: #2dd4bf; pointer-events: none; z-index: 2147483647; white-space: nowrap; display: block;';
    document.body.appendChild(fabTokenEl);
  }

  fabTokenEl.textContent = tokenText;

  // 同步位置
  const badgeEl = document.getElementById('lingya-status-badge');
  if (badgeEl) {
    const rect = badgeEl.getBoundingClientRect();
    if (rect.width > 0) {
      fabTokenEl.style.left = (rect.left + rect.width / 2) + 'px';
      fabTokenEl.style.top = (rect.top - 6) + 'px';
    }
  }
}

// ========== 自动压缩上下文 ==========
// 配置的唯一入口是侧边栏设置（写入 localStorage），此处每秒实时读取。
// 悬浮球面板不再提供阈值设置。
// 防止压缩过程中重复触发
let autoCompactTriggering = false;

/**
 * 检查是否触发自动压缩
 * 数据源：state.serverTokenUsage.accumulatedTokens
 */
function checkAutoCompact() {
  if (autoCompactTriggering) return;

  const server = state.serverTokenUsage;
  if (!server || typeof server.accumulatedTokens !== "number") return;
  // 【修复】用扣除基线后的「有效 token 数」判定阈值，避免迁移后新会话拿原值继续触发
  const effective = getEffectiveTokenCount();
  const current = effective !== null ? effective : server.accumulatedTokens;

  // ===== 优先级 1：跨窗口轮转 =====
  // 轮转是独立开关，不看旧「自动压缩」开关，用自己的阈值。
  // 启用状态与阈值缓存在 localStorage（由 rotSave 保存时写入），同步读取，避免每秒 IPC。
  let rotOn = false;
  let rotThresholdWan = 10;
  try {
    rotOn = localStorage.getItem("lingya-rotation-enabled") === "1";
    const rt = localStorage.getItem("lingya-rotation-threshold");
    if (rt) rotThresholdWan = parseFloat(rt) || 10;
  } catch (_) { rotOn = false; }
  if (rotOn) {
    const rotThresholdTokens = rotThresholdWan * 10000;
    if (current < rotThresholdTokens) return;
    autoCompactTriggering = true;
    console.log("[LingYa 轮转] 自动触发：当前有效 " + current + " >= 轮转阈值 " + rotThresholdTokens);
    runRotationMigration().catch((e) => console.error("[LingYa 轮转] 异常:", e && e.message));
    return;
  }

  // ===== 优先级 2：原地迁移（原有逻辑，行为完全不变）=====
  let enabled = false;
  let thresholdWan = 80;
  try {
    enabled = localStorage.getItem("lingya-auto-compact-enabled") === "1";
    const th = localStorage.getItem("lingya-auto-compact-threshold");
    thresholdWan = th ? (parseFloat(th) || 80) : 80;
  } catch (_) { return; }
  if (!enabled) return;
  const thresholdTokens = thresholdWan * 10000;
  if (current < thresholdTokens) return;
  autoCompactTriggering = true;
  console.log("[LingYa Compact] 自动触发：当前有效 " + current + " >= 阈值 " + thresholdTokens);
  runMigration().catch((e) => console.error("[LingYa 迁移] 异常:", e && e.message));
}

/** 原地迁移：Token 超阈值 → 打包历史 → 新会话承接（原有逻辑，行为不变） */
async function runMigration() {
  {
    if (state.isMigrating) return;
    state.isMigrating = true;
    // 增加时间戳，如果 15 秒后页面还没刷新，判定为切换失败，本次任务彻底结束
    state.migratingAt = Date.now();
    showToast('Token 超阈值，正在自动开启新会话并全量迁移上下文...', 4000);
    
    try {
      // 强制中断当前任务
      state.stopped = true;
      try { window.electronAPI.clearAbort(); } catch (_) {}
      
      // 收集全量历史
      const cLog = require('../dom/conversation-log');
      const historyEntries = cLog.getEntries ? cLog.getEntries() : [];
      const historyMd = cLog.buildMarkdown(historyEntries, { 
        platform: 'DeepSeek', 
        projectDir: state.currentProjectDir,
        now: Date.now()
      }, { includeToolBlocks: true });
      
      // 获取当前旧会话 ID（优先用 state 里的，URL 在切页时可能已改变）
      let oldSid = state.currentSessionId;
      if (!oldSid) {
        try {
          const provider = require('../../../providers').getProviderByUrl(window.location.href);
          if (provider && provider.extractSessionId) {
            oldSid = provider.extractSessionId(window.location.href);
          }
        } catch (_) {}
      }
      console.log('[LingYa 迁移] 当前待删除旧会话 ID: ' + oldSid);

      // 存入 localStorage，供 auto-inject 读取
      const migrationData = {
        history: historyMd,
        // 兜底：state.currentProjectDir 只在收到 project-dir-updated 时赋值，
        // 新开会话/页面重载后会短暂为 null。此时回退读 lingya-last-project-dir
        // （由 project-dir.js 维护，只写有效值、不被 null 覆盖），
        // 避免自动迁移把"项目路径为空"带到新会话。
        projectDir: state.currentProjectDir
          || (() => { try { return localStorage.getItem('lingya-last-project-dir') || null; } catch (_) { return null; } })(),
        oldSessionId: oldSid,
        timestamp: Date.now()
      };
      localStorage.setItem('lingya-pending-migration', JSON.stringify(migrationData));
      console.log('[LingYa 迁移] 历史已打包，长度=' + historyMd.length + '，准备切新会话');
      
      // 清空旧会话记录
      if (cLog.clearEntries) cLog.clearEntries();
      
      // 切新会话（回到首页）
      if (window.electronAPI && window.electronAPI.newChat) {
        await window.electronAPI.newChat();
      } else {
        throw new Error('window.electronAPI.newChat 不可用');
      }
    } catch (err) {
      console.error('[LingYa 迁移] 失败:', err);
      state.isMigrating = false;
      showToast('自动迁移失败: ' + err.message, 5000);
    } finally {
      autoCompactTriggering = false;
      // 如果 15 秒后还卡在 isMigrating=true（说明切换失败或页面未刷新），强制解锁，并清理迁移数据
      setTimeout(() => {
        if (state.isMigrating && Date.now() - state.migratingAt >= 15000) {
          console.warn('[LingYa 迁移] 超时未收到新会话回复，迁移失败，强制解除防爆锁');
          state.isMigrating = false;
          // 如果数据还没被 auto-inject 处理完，说明失败了，直接清理，防止死循环
          if (localStorage.getItem('lingya-pending-migration')) {
             localStorage.removeItem('lingya-pending-migration');
             console.log('[LingYa 迁移] 已清理超时的迁移数据');
          }
        }
      }, 15000);
    }
  }
}

// ========== 跨窗口 Token 轮转（源窗口触发端）==========
// 与原地迁移的区别：历史不留在本窗口，而是交给主进程转给窗口池里的下一个窗口。
// 铁律：删旧会话只在目标窗口 ack 成功之后执行，任何失败路径都不删。

/** 收尾指令：让 AI 先输出交接摘要，再切窗口（决策 D2） */
const ROTATION_CLOSING_INSTRUCTION =
  '请把当前工作收尾，并输出一份交接摘要：已完成什么、未完成什么、下一步该做什么。直接输出摘要。';

/**
 * 等待 AI 回复完成。超时返回 null（调用方降级为打包全量历史），不抛错。
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function waitForRotationResponse(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let off = () => {};
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { off(); } catch (_) {}
      resolve(null);
    }, timeoutMs);
    try {
      const { onInterceptedResponse } = require('../dom/intercept-observer');
      off = onInterceptedResponse((text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { off(); } catch (_) {}
        resolve(text);
      });
    } catch (err) {
      console.warn('[LingYa 轮转] 无法监听回复，直接降级:', err && err.message);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * 跨窗口轮转的源窗口流程（spec 7.4 的 10 步）。
 * 失败一律回落原地迁移，绝不丢任务上下文。
 */
async function runRotationMigration() {
  if (state.isMigrating) return;
  state.isMigrating = true;
  state.migratingAt = Date.now();
  let oldSid = state.currentSessionId;
  try {
    let cfg = {};
    try {
      const rc = await window.electronAPI.rotationGetConfig();
      cfg = (rc && rc.success && rc.config) || {};
    } catch (_) { cfg = {}; }

    showToast('Token 超阈值，正在收尾并准备跨窗口轮转...', 4000);

    // 1-3) 发收尾指令并等回复；超时降级为直接打包全量历史
    state.stopped = true;
    try { window.electronAPI.clearAbort(); } catch (_) {}
    try {
      const chatInput = require('../dom/chat-input');
      if (typeof chatInput.sendMessageToChat === 'function') {
        chatInput.sendMessageToChat(ROTATION_CLOSING_INSTRUCTION, '轮转收尾', { auto: true });
        state.stopped = false;
        await waitForRotationResponse(120000);
      }
    } catch (err) {
      console.warn('[LingYa 轮转] 收尾指令发送失败，降级为直接打包全量历史:', err && err.message);
    }

    // 4) 打包历史
    const cLog = require('../dom/conversation-log');
    const historyEntries = cLog.getEntries ? cLog.getEntries() : [];
    let historyMd = cLog.buildMarkdown(historyEntries, {
      platform: 'DeepSeek',
      projectDir: state.currentProjectDir,
      now: Date.now(),
    }, { includeToolBlocks: true });

    // 5) 超限截断（Review Focus 5）
    const maxBytes = (typeof cfg.historyMaxBytes === 'number' && cfg.historyMaxBytes > 0)
      ? cfg.historyMaxBytes : 2097152;
    if (historyMd && historyMd.length > maxBytes) {
      historyMd = historyMd.slice(0, maxBytes) + String.fromCharCode(10,10) + '[...历史过长已截断...]';
      console.warn('[LingYa 轮转] 历史超过 ' + maxBytes + ' 字符，已截断');
    }

    // 取旧会话 ID（URL 在切页时可能已变，优先 state）
    if (!oldSid) {
      try {
        const provider = require('../../providers').getProviderByUrl(window.location.href);
        if (provider && provider.extractSessionId) oldSid = provider.extractSessionId(window.location.href);
      } catch (_) {}
    }

    // 6) 提交给主进程
    const submitRes = await window.electronAPI.rotationSubmit({
      history: historyMd,
      projectDir: state.currentProjectDir
        || (() => { try { return localStorage.getItem('lingya-last-project-dir') || null; } catch (_) { return null; } })(),
      oldSessionId: oldSid || null,
      timestamp: Date.now(),
    });

    // 7) 提交失败 → 回落原地迁移
    if (!submitRes || !submitRes.success) {
      const reason = (submitRes && submitRes.reason) || 'unknown';
      console.warn('[LingYa 轮转] 提交失败 reason=' + reason + '，回落到原地迁移');
      showToast('无可用目标窗口（' + reason + '），本窗口继续', 4000);
      state.isMigrating = false;
      return runMigration();
    }

    // 8) 等 ack 结果（主进程看门狗 90s，这里留足余量）
    const result = await new Promise((resolve) => {
      let done = false;
      let off = () => {};
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { off(); } catch (_) {}
        resolve({ ok: false, reason: 'timeout' });
      }, 120000);
      try {
        off = window.electronAPI.onRotationResult((r) => {
          if (done) return;
          if (!r || r.requestId !== submitRes.requestId) return;
          done = true;
          clearTimeout(timer);
          try { off(); } catch (_) {}
          resolve(r);
        });
      } catch (_) {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'listen-failed' });
      }
    });

    if (result && result.ok) {
      // 9) 承接成功：这时才删旧会话
      try {
        if (oldSid) {
          const archiver = require('../dom/deepseek-history-archiver');
          if (archiver.deleteSessionSilent) await archiver.deleteSessionSilent(oldSid);
        }
      } catch (err) {
        console.error('[LingYa 轮转] 删除旧会话失败:', err && err.message);
      }
      try { if (cLog.clearEntries) cLog.clearEntries(); } catch (_) {}
      showToast('已切换到窗口 ' + (result.targetProfileId || '') + '，本窗口任务结束', 5000);
    } else {
      // 10) 承接失败：不删，本窗口继续
      const reason = (result && result.reason) || 'unknown';
      console.warn('[LingYa 轮转] 承接失败 reason=' + reason);
      showToast('切换失败：' + reason + '，本窗口继续', 5000);
      state.isMigrating = false;
    }
  } catch (err) {
    console.error('[LingYa 轮转] 异常:', err && err.message);
    showToast('轮转异常: ' + (err && err.message), 5000);
    state.isMigrating = false;
  } finally {
    autoCompactTriggering = false;
    setTimeout(() => {
      if (state.isMigrating && Date.now() - state.migratingAt >= 15000) {
        state.isMigrating = false;
      }
    }, 15000);
  }
}


/**
 * 启动对话 token 显示（每秒刷新）+ 自动压缩检查
 */
function startTokenCounter() {
  setInterval(() => {
    updateConversationTokenDisplay();
    checkAutoCompact();
  }, 1000);
  updateConversationTokenDisplay();
}

/**
 * 让悬浮球支持鼠标拖动，并持久化位置
 * 拖动超过阈值视为移动，否则视为点击（保留切换面板功能）
 * @param {HTMLElement} badge
 */
function makeFabDraggable(badge) {
  const THRESHOLD = 4;
  const POS_KEY = 'lingya-fab-pos';
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  function applyPos(left, top) {
    const w = badge.offsetWidth || 48;
    const h = badge.offsetHeight || 48;
    left = Math.max(0, Math.min(left, window.innerWidth - w));
    top = Math.max(0, Math.min(top, window.innerHeight - h));
    badge.style.left = left + 'px';
    badge.style.top = top + 'px';
    badge.style.right = 'auto';

    // 同步更新 Token 标签位置
    const tokenEl = document.getElementById('lingya-fab-token');
    if (tokenEl) {
      tokenEl.style.left = cx + 'px';
      tokenEl.style.top = (top - 6) + 'px';
    }
    badge.style.bottom = 'auto';
  }

  // 恢复保存的位置
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const p = JSON.parse(saved);
      if (typeof p.left === 'number' && typeof p.top === 'number') {
        applyPos(p.left, p.top);
      }
    }
  } catch (_) { /* ignore */ }

  badge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = badge.getBoundingClientRect();
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    try { badge.setPointerCapture(e.pointerId); } catch (_) {}
  });

  badge.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
    moved = true;
    applyPos(startLeft + dx, startTop + dy);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { badge.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) {
      try {
        const rect = badge.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (_) { /* ignore */ }
    }
  }
  badge.addEventListener('pointerup', endDrag);
  badge.addEventListener('pointercancel', endDrag);

  // 拖动后拦截本次 click，避免误触切换面板（捕获阶段优先执行）
  badge.addEventListener('click', (e) => {
    if (moved) {
      e.stopImmediatePropagation();
      e.preventDefault();
      moved = false;
    }
  }, true);

  // 窗口尺寸变化时把悬浮球约束回视口
  window.addEventListener('resize', () => {
    const rect = badge.getBoundingClientRect();
    applyPos(rect.left, rect.top);
  });
}

function bindEvents() {
  // 防止重复绑定（SPA 导航或 preload 重载时可能导致多次执行）
  if (eventsBound) return;
  eventsBound = true;

  // 延迟配置的恢复已在 chat-input.js 的 restoreThinkDelayConfig 完成，
  // UI 输入框已移除，这里无需再同步。

  // 悬浮球尺寸切换
  const fabSizeSwitch = document.getElementById('lingya-fab-size-switch');
  if (fabSizeSwitch) {
    fabSizeSwitch.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.lingya-size-btn') : null;
      if (!btn) return;
      const size = parseInt(btn.getAttribute('data-size'), 10);
      if (!isNaN(size)) setFabSize(size);
    });
  }
  const minimizeBtn = document.getElementById('lingya-btn-minimize');
  const initBtn = document.getElementById('lingya-btn-init');
  const clearBtn = document.getElementById('lingya-btn-clear');

  minimizeBtn?.addEventListener('click', hideOverlay);
  initBtn?.addEventListener('click', handleInitProject);

  // 压缩上下文按钮
  const compactBtn = document.getElementById('lingya-btn-compact');
  compactBtn?.addEventListener('click', runCompaction);

  // 首次使用提示浮窗已移除（底部/侧边栏已有初始化按钮）
  clearBtn?.addEventListener('click', () => {
    commandHistory.length = 0;
    renderHistory();
  });

  // 手动解析按钮
  const manualParseBtn = document.getElementById('lingya-btn-manual-parse');
  manualParseBtn?.addEventListener('click', handleManualParseDispatch);

  // 停止按钮
  const stopBtn = document.getElementById('lingya-btn-stop');
  stopBtn?.addEventListener('click', () => { stopTask(false); });

  // 窗口管理按钮：打开浮动管理面板
  const windowManagerBtn = document.getElementById('lingya-btn-window-manager');
  windowManagerBtn?.addEventListener('click', () => {
    openWindowManager();
  });

  // MCP 按钮：打开 MCP 管理面板
  const mcpBtn = document.getElementById('lingya-btn-mcp');
  mcpBtn?.addEventListener('click', openMcpManager);

  // MCP 面板：关闭
  const mcpCloseBtn = document.getElementById('lingya-mcp-close');
  mcpCloseBtn?.addEventListener('click', closeMcpManager);

  // MCP 面板：刷新
  const mcpRefreshBtn = document.getElementById('lingya-mcp-refresh');
  mcpRefreshBtn?.addEventListener('click', renderMcpList);

  // MCP 面板：保存配置
  const mcpSaveBtn = document.getElementById('lingya-mcp-save');
  mcpSaveBtn?.addEventListener('click', async () => {
    const jsonInput = document.getElementById('lingya-mcp-json');
    if (!jsonInput || !jsonInput.value.trim()) {
      showToast('请输入配置', 3000);
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput.value);
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
        showToast('配置格式错误，需要 mcpServers 对象', 3000);
        return;
      }

      // 校验每个 server 定义是否完整合法（发现错误立即中止，不删旧配置、不覆盖编辑框）
      for (const [name, def] of Object.entries(parsed.mcpServers)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) {
          showToast('配置错误：server "' + name + '" 的定义必须是对象', 4000);
          return;
        }
        const hasUrl = def.url !== undefined;
        const hasCommand = def.command !== undefined;
        if (hasUrl) {
          if (typeof def.url !== 'string' || !def.url.trim()) {
            showToast('配置错误：server "' + name + '" 的 url 必须是非空字符串', 4000);
            return;
          }
          if (hasCommand) {
            showToast('配置错误：server "' + name + '" 不能同时指定 url 和 command', 4000);
            return;
          }
        } else if (hasCommand) {
          if (typeof def.command !== 'string' || !def.command.trim()) {
            showToast('配置错误：server "' + name + '" 的 command 必须是非空字符串', 4000);
            return;
          }
        } else {
          showToast('配置错误：server "' + name + '" 缺少 command 或 url', 4000);
          return;
        }
        if (def.args !== undefined && !Array.isArray(def.args)) {
          showToast('配置错误：server "' + name + '" 的 args 必须是数组', 4000);
          return;
        }
        if (def.env !== undefined && (typeof def.env !== 'object' || def.env === null || Array.isArray(def.env))) {
          showToast('配置错误：server "' + name + '" 的 env 必须是对象', 4000);
          return;
        }
        if (def.headers !== undefined && (typeof def.headers !== 'object' || def.headers === null || Array.isArray(def.headers))) {
          showToast('配置错误：server "' + name + '" 的 headers 必须是对象', 4000);
          return;
        }
      }

      // 先删除 JSON 里不存在的旧 server
      const oldRes = await window.electronAPI.listMcpServers();
      const oldServers = (oldRes && oldRes.success && oldRes.servers) || [];
      const newNames = new Set(Object.keys(parsed.mcpServers));
      for (const old of oldServers) {
        if (!newNames.has(old.name)) {
          await window.electronAPI.removeMcpServer(old.name);
        }
      }

      // 逐个 upsert 新配置
      for (const [name, def] of Object.entries(parsed.mcpServers)) {
        const server = {
          name,
          type: def && def.url ? 'http' : 'stdio',
          command: def && def.command,
          args: def && def.args || [],
          url: def && def.url,
          headers: def && def.headers,
          env: def && def.env,
        };
        await window.electronAPI.upsertMcpServer(server);
      }
      showToast('配置已保存', 2200);
      await renderMcpList();
      await loadMcpConfigToJson();
      // 询问用户是否将 MCP 更新通知发给 AI（不自动发送）
      try {
        const confirmed = await showConfirmDialog(
          'MCP 配置已保存。\n\n是否告诉 AI 配置已更新？\n（请确保 AI 当前没有正在进行其他操作）',
          { okText: '发送', showCancel: true, cancelText: '取消' }
        );
        if (!confirmed) return;

        const res = await window.electronAPI.getMcpTools();
        const tools = res && res.success ? res.tools : [];
        const serverNames = Array.from(new Set(tools.map(t => t.server)));
        let msg = '【MCP 配置已更新】\n\n';
        if (serverNames.length === 0) {
          msg += '当前没有已连接的 MCP server。';
        } else {
          msg += '可用的 MCP server：' + serverNames.join('、') + '。\n';
          msg += '需要时用 mcpListServers() 查看概览，或用 mcpGetTools(serverName) 查看具体工具。';
        }
        sendToChat(msg, 'MCP信息', 300);
      } catch (err) {
        console.error('[LingYa] 发送 MCP 信息失败:', err);
      }
    } catch (err) {
      showToast('保存失败: ' + (err.message || err), 3000);
    }
  });



  // 浮动面板：新建窗口（不指定平台，让窗口显示平台选择页）
  const wmNewWindowBtn = document.getElementById('lingya-wm-new-window');
  wmNewWindowBtn?.addEventListener('click', async () => {
    try {
      await window.electronAPI.createProfileWindow();
      showToast('已打开平台选择', 2200);
      await renderWindowList();
    } catch (err) {
      showToast('创建新窗口失败: ' + (err.message || err), 3000);
    }
  });

  // 浮动面板：关闭
  const wmCloseBtn = document.getElementById('lingya-wm-close');
  wmCloseBtn?.addEventListener('click', closeWindowManager);

  // 浮动面板：刷新列表
  const wmRefreshBtn = document.getElementById('lingya-wm-refresh');
  wmRefreshBtn?.addEventListener('click', renderWindowList);

  // 生成项目说明文档按钮
  const genDocBtn = document.getElementById('lingya-btn-gen-doc');
  genDocBtn?.addEventListener('click', handleGenerateDoc);

  // 导出对话为 Markdown 按钮
  const exportMdBtn = document.getElementById('lingya-btn-export-md');
  exportMdBtn?.addEventListener('click', async () => {
    const log = require('../dom/conversation-log');
    const count = log.getCount();
    if (count === 0) {
      showToast('本窗口尚无对话记录（导出记录从窗口打开后开始累积）', 3500);
      return;
    }
    try {
      const markdown = log.exportMarkdown();
      // 文件名用会话标题：<标题>_<YYYYMMDD-HHmm>.md
      // 取不到标题时回退到 lingya-conversation-<时间戳>.md
      const { buildExportFilename } = require('../dom/export-filename');
      const name = buildExportFilename();
      if (!window.electronAPI || typeof window.electronAPI.conversationExportMd !== 'function') {
        showToast('导出 API 不可用，请重启应用', 3000);
        return;
      }
      const res = await window.electronAPI.conversationExportMd(markdown, name);
      if (res && res.success) {
        showToast('已导出 ' + count + ' 条对话 → ' + res.path, 4000);
      } else if (res && res.canceled) {
        // 用户取消，不提示
      } else {
        showToast('导出失败：' + ((res && res.error) || '未知错误'), 3500);
      }
    } catch (err) {
      showToast('导出失败：' + err.message, 3500);
    }
  });

  // 沉浸式交流按钮
  const immersiveBtn = document.getElementById('lingya-btn-immersive');
  immersiveBtn?.addEventListener('click', () => {
    const message = '现在你的任何疑问,或没有疑问的选择都需要和我确认 , 确认的方式是 你问一个问题我回答一个问题,然后你再问下一个问题, 最好给我选项, 也要给我个其他的选项, 谢谢 爱你哦';
    if (!sendToChat(message, '沉浸式交流', 300)) {
      showToast('未找到输入框，请确保已打开聊天界面', 3000);
    } else {
      showToast('已发送沉浸式交流提示', 2200);
    }
  });

  // 刷新会话列表按钮
  const refreshSessionsBtn = document.getElementById('lingya-btn-refresh-sessions');
  refreshSessionsBtn?.addEventListener('click', renderSessions);

  // AI 重命名按钮：让 AI 回顾完整上下文后用 nameConversation 重新命名本对话
  const aiRenameBtn = document.getElementById('lingya-btn-ai-rename');
  aiRenameBtn?.addEventListener('click', () => {
    const prompt = [
      '请回顾本次对话的**完整上下文**（包括所有历史消息与工具执行结果），提炼这次对话真正在做的核心工作，',
      '然后**只调用一次** nameConversation(title) 工具，给本次对话起一个准确的中文标题（≤20 字）。',
      '',
      '要求：',
      '1. 标题要体现对话的**实际核心内容**，不要用"你好""继续"这类开场词，也不要用最后一条消息的主题代替整体。',
      '2. 直接调用工具，不要输出计划、不要解释、不要做任何其他操作。',
      '3. 调用完只回复一句"已重命名为：<标题>"即可。',
    ].join('\n');
    if (!sendToChat(prompt, 'AI重命名', 300)) {
      showToast('未找到输入框，请确保已打开聊天界面', 3000);
    } else {
      showToast('已请求 AI 重新命名本对话', 2200);
    }
  });

  // 会话标题更新（AI 自动命名 / 手动改名）→ 实时刷新会话列表
  try {
    if (window.electronAPI && window.electronAPI.onSessionTitleUpdated) {
      window.electronAPI.onSessionTitleUpdated(() => { try { renderSessions(); } catch (_) {} });
    }
  } catch (_) { /* ignore */ }

  // 会话归档状态更新 → 实时刷新会话列表
  try {
    if (window.electronAPI && window.electronAPI.onSessionArchivedUpdated) {
      window.electronAPI.onSessionArchivedUpdated(() => { try { renderSessions(); } catch (_) {} });
    }
  } catch (_) { /* ignore */ }

  // 发送延迟配置已迁到侧边栏「设置 → AI 回复后的发送延迟」，覆盖层不再提供。

  // 悬浮球：可拖动 + 点击切换面板显隐
  const statusBadge = document.getElementById('lingya-status-badge');
  if (statusBadge) makeFabDraggable(statusBadge);
  // 悬浮球右键：停止当前任务
  statusBadge?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    stopTask(false);
  });
  statusBadge?.addEventListener('click', () => {
    const overlay = document.getElementById('lingya-overlay');
    if (!overlay) return;
    if (overlay.classList.contains('lingya-hidden')) {
      showOverlay();
    } else {
      hideOverlay();
    }
  });

  // 页签切换
  bindTabEvents();
  // 文件树侧栏已迁移到壳页面（src/ui/shell.html），覆盖层不再绑定
  // 注：src/preload/overlay/file-tree-panel.js 保留（含主题逻辑 initTheme），
  //     但其中侧栏 DOM 操作因元素不存在会自动跳过。
  try {
    const ftPanel = require('./file-tree-panel');
    if (typeof ftPanel.initThemeOnly === 'function') ftPanel.initThemeOnly();
  } catch (err) {
    console.error('[LingYa] 主题初始化失败:', err);
  }

  // 记忆面板事件
  bindMemoryPanelEvents();
  // 技能面板事件
  bindSkillPanelEvents();
  // 安全增强面板事件
  bindSecurityPanelEvents();
  // 通信中枢面板事件（飞书/微信/QQ 入口）
  bindCommPanelEvents();
  // 飞书同步面板事件
  bindFeishuPanelEvents();
  // 微信 iLink 面板事件
  bindWeixinPanelEvents();
  // QQ 面板事件
  bindQqPanelEvents();
  // 定时任务面板事件
  bindSchedulePanelEvents();
  // Agent 模式（Plan / Build）切换
  bindAgentPanelEvents();
  // 计划（todoWrite）面板
  bindPlanPanelEvents();
  // 跨窗口 Token 轮转配置页签
  bindRotationEvents();

  // 新会话自动注入开关：恢复状态 + 保存
  const autoInjectEl = document.getElementById('lingya-auto-inject');
  if (autoInjectEl) {
    autoInjectEl.checked = localStorage.getItem('lingya-auto-inject') === '1';
    autoInjectEl.addEventListener('change', saveAutoInjectSetting);
  }

  // 自动压缩：配置由侧边栏唯一管理，checkAutoCompact 每秒实时读 localStorage

  // 启动输入框 token 估算 + 自动压缩检查
  startTokenCounter();

  // 压缩后新页面加载：检查是否需自动初始化项目（用被压缩项目的目录）
  checkPendingInit();

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C 切换覆盖层显示
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      const overlay = document.getElementById('lingya-overlay');
      if (overlay) {
        if (overlay.classList.contains('lingya-hidden')) {
          showOverlay();
        } else {
          hideOverlay();
        }
      }
    }
    // Esc 隐藏覆盖层和窗口管理面板
    if (e.key === 'Escape') {
      hideOverlay();
      closeWindowManager();
      closeMcpManager();
      closeMemoryManager();
      closeSkillManager();
      closeSecurityManager();
      closeFeishuManager();
      closeWeixinManager();
      closeQqManager();
      closeCommManager();
      hideFirstTimeDialog();
    }
  });
}


// ========== 轮转配置页签 ==========

/** 页面上当前编辑中的窗口池（未保存的编辑状态） */
let rotPoolDraft = [];

/** 从主进程拉配置并回填表单 */
async function rotFillForm() {
  try {
    const r = await window.electronAPI.rotationGetConfig();
    if (!r || !r.success || !r.config) return;
    const c = r.config;
    const el = (id) => document.getElementById(id);
    if (el("lingya-rot-enabled")) el("lingya-rot-enabled").checked = c.enabled === true;
    if (el("lingya-rot-threshold")) el("lingya-rot-threshold").value = c.thresholdWan;
    if (el("lingya-rot-max-rotations")) el("lingya-rot-max-rotations").value = c.maxRotations;
    if (el("lingya-rot-max-hours")) el("lingya-rot-max-hours").value = c.maxSessionHours;
    if (el("lingya-rot-wait-ms")) el("lingya-rot-wait-ms").value = c.targetBusyWaitMs;
    if (el("lingya-rot-diff-account")) el("lingya-rot-diff-account").checked = c.preferDifferentAccount === true;
    rotPoolDraft = Array.isArray(c.pool) ? c.pool.map((x) => ({ ...x })) : [];
    // 同步缓存给 checkAutoCompact 同步读取（避免每秒 IPC）
    try {
      localStorage.setItem('lingya-rotation-enabled', c.enabled === true ? '1' : '0');
      localStorage.setItem('lingya-rotation-threshold', String(c.thresholdWan));
    } catch (_) {}
  } catch (err) {
    console.error("[LingYa 轮转] 读取配置失败:", err && err.message);
  }
}

/** 渲染窗口池列表：候选窗口 + 已选状态 + 账号标识 + 上下移 */
async function rotRenderPool() {
  const box = document.getElementById("lingya-rot-pool");
  if (!box) return;
  let candidates = [];
  try {
    const r = await window.electronAPI.rotationListCandidates();
    if (r && r.success) candidates = r.windows || [];
  } catch (err) {
    console.error("[LingYa 轮转] 拉候选窗口失败:", err && err.message);
  }

  // 已选中的（按 draft 顺序）先展示，再补上未选中的候选
  const byId = new Map(candidates.map((w) => [w.profileId, w]));
  const rows = [];
  for (const item of rotPoolDraft) {
    const cand = byId.get(item.profileId) || { profileId: item.profileId, name: item.profileId, exists: false, busy: false };
    rows.push({ ...cand, accountTag: item.accountTag || "", selected: true, enabled: item.enabled !== false });
  }
  for (const cand of candidates) {
    if (rotPoolDraft.some((x) => x.profileId === cand.profileId)) continue;
    rows.push({ ...cand, accountTag: "", selected: false, enabled: true });
  }

  if (rows.length === 0) {
    box.innerHTML = '<div class="lingya-rot-item"><span class="lingya-rot-item-name">暂无窗口</span></div>';
    return;
  }

  box.innerHTML = "";
  rows.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "lingya-rot-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = row.selected;
    cb.addEventListener("change", () => rotToggle(row.profileId, cb.checked));
    div.appendChild(cb);

    const name = document.createElement("span");
    name.className = "lingya-rot-item-name";
    let label = row.name || row.profileId;
    if (!row.exists) label += "（未打开）";
    if (row.busy) label += "（忙）";
    name.textContent = label;
    div.appendChild(name);

    const pid = document.createElement("span");
    pid.className = "lingya-rot-item-pid";
    pid.textContent = row.profileId;
    div.appendChild(pid);

    if (row.selected) {
      const acc = document.createElement("input");
      acc.className = "lingya-rot-acc";
      acc.placeholder = "账号标识";
      acc.value = row.accountTag;
      acc.addEventListener("input", () => {
        const it = rotPoolDraft.find((x) => x.profileId === row.profileId);
        if (it) it.accountTag = acc.value;
      });
      div.appendChild(acc);

      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "上移";
      up.addEventListener("click", () => rotMove(row.profileId, -1));
      div.appendChild(up);

      const down = document.createElement("button");
      down.textContent = "↓";
      down.title = "下移";
      down.addEventListener("click", () => rotMove(row.profileId, 1));
      div.appendChild(down);
    }

    box.appendChild(div);
  });
}

/** 勾选/取消某个窗口 */
function rotToggle(profileId, checked) {
  if (checked) {
    if (!rotPoolDraft.some((x) => x.profileId === profileId)) {
      rotPoolDraft.push({ profileId, accountTag: "", enabled: true });
    }
  } else {
    rotPoolDraft = rotPoolDraft.filter((x) => x.profileId !== profileId);
  }
  rotRenderPool();
}

/** 池内上下移动 */
function rotMove(profileId, delta) {
  const i = rotPoolDraft.findIndex((x) => x.profileId === profileId);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= rotPoolDraft.length) return;
  const t = rotPoolDraft[i];
  rotPoolDraft[i] = rotPoolDraft[j];
  rotPoolDraft[j] = t;
  rotRenderPool();
}

/** 收集表单并保存 */
async function rotSave() {
  const el = (id) => document.getElementById(id);
  const patch = {
    enabled: !!(el("lingya-rot-enabled") && el("lingya-rot-enabled").checked),
    thresholdWan: Number(el("lingya-rot-threshold") ? el("lingya-rot-threshold").value : 10),
    maxRotations: Number(el("lingya-rot-max-rotations") ? el("lingya-rot-max-rotations").value : 5),
    maxSessionHours: Number(el("lingya-rot-max-hours") ? el("lingya-rot-max-hours").value : 4),
    targetBusyWaitMs: Number(el("lingya-rot-wait-ms") ? el("lingya-rot-wait-ms").value : 60000),
    preferDifferentAccount: !!(el("lingya-rot-diff-account") && el("lingya-rot-diff-account").checked),
    pool: rotPoolDraft.map((x) => ({ profileId: x.profileId, accountTag: x.accountTag || "", enabled: x.enabled !== false })),
  };
  try {
    const r = await window.electronAPI.rotationSetConfig(patch);
    if (r && r.success) {
      // 立刻同步缓存，让 checkAutoCompact 下一次轮询就按新配置判定
      try {
        localStorage.setItem('lingya-rotation-enabled', patch.enabled ? '1' : '0');
        localStorage.setItem('lingya-rotation-threshold', String(patch.thresholdWan));
      } catch (_) {}
      showToast("轮转配置已保存", 3000);
      await rotFillForm();
      await rotRenderPool();
    } else {
      showToast("保存失败：" + ((r && r.error) || "未知错误"), 4000);
    }
  } catch (err) {
    showToast("保存失败：" + (err && err.message), 4000);
  }
}

/** 重置轮转运行状态（cursor 归零） */
async function rotReset() {
  try {
    const r = await window.electronAPI.rotationReset();
    if (r && r.success) {
      showToast("轮转状态已重置", 3000);
      await rotFillForm();
    }
  } catch (err) {
    showToast("重置失败：" + (err && err.message), 4000);
  }
}

/** 绑定轮转页签的全部事件 */
function bindRotationEvents() {
  const save = document.getElementById("lingya-rot-save");
  if (save) save.addEventListener("click", rotSave);
  const reset = document.getElementById("lingya-rot-reset");
  if (reset) reset.addEventListener("click", rotReset);
  const refresh = document.getElementById("lingya-rot-refresh");
  if (refresh) refresh.addEventListener("click", () => rotRenderPool());
  // 面板首次打开时回填（不阻塞）
  rotFillForm().then(() => rotRenderPool()).catch(() => {});
}

module.exports = bindEvents;
module.exports.stopTask = stopTask;
module.exports.clearStopped = clearStopped;
module.exports.runRotationMigration = runRotationMigration;
module.exports.runMigration = runMigration;
module.exports.checkAutoCompact = checkAutoCompact;
module.exports.bindRotationEvents = bindRotationEvents;
