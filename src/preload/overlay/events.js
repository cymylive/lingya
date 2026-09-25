/**
 * 覆盖层按钮事件绑定
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const state = require('../dom/state');
const { hideOverlay, showOverlay, renderHistory, commandHistory, showToast, showConfirmDialog, hideFirstTimeDialog, setStopped } = require('./ui');
const { handleInitProject, renderSessions } = require('../dom/session-list');
const { sendToChat } = require('../dom/chat-input');
const { runCompaction, checkPendingInit } = require('../dom/compaction');
const { bindMemoryPanelEvents, closeMemoryManager } = require('./memory-panel');
const { bindSkillPanelEvents, closeSkillManager } = require('./skill-panel');
const { bindSecurityPanelEvents, closeSecurityManager } = require('./security-panel');
const { bindAgentPanelEvents } = require('./agent-panel');

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
  if (!silent) showToast('已停止。发送任意消息即可恢复自动执行', 3000);
}

/**
 * 清除停止状态（用户下次发消息时调用）
 */
async function clearStopped() {
  if (!state.stopped) return;
  state.stopped = false;
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
function updateConversationTokenDisplay() {
  const countEl = document.getElementById('lingya-conv-token-count');
  if (!countEl) return;

  const server = state.serverTokenUsage;
  if (server && typeof server.accumulatedTokens === 'number') {
    countEl.textContent = formatTokenCount(server.accumulatedTokens);
  } else {
    countEl.textContent = '0';
  }
}

// ========== 自动压缩上下文 ==========
// 配置：是否启用 + 阈值（单位：万 token）
let autoCompactEnabled = false;
let autoCompactThresholdWan = 80;
// 防止压缩过程中重复触发
let autoCompactTriggering = false;

/** 从 localStorage 读取自动压缩配置并同步到 UI */
function loadAutoCompactConfig() {
  try {
    const en = localStorage.getItem('lingya-auto-compact-enabled');
    const th = localStorage.getItem('lingya-auto-compact-threshold');
    autoCompactEnabled = en === '1';
    autoCompactThresholdWan = th ? (parseFloat(th) || 80) : 80;
  } catch (_) {}
  const enEl = document.getElementById('lingya-auto-compact-enabled');
  const thEl = document.getElementById('lingya-auto-compact-threshold');
  if (enEl) enEl.checked = autoCompactEnabled;
  if (thEl) thEl.value = autoCompactThresholdWan;
}

/** 保存自动压缩配置 */
function saveAutoCompactConfig() {
  const enEl = document.getElementById('lingya-auto-compact-enabled');
  const thEl = document.getElementById('lingya-auto-compact-threshold');
  const enabled = !!(enEl && enEl.checked);
  let th = thEl ? parseFloat(thEl.value) : 80;
  if (!Number.isFinite(th) || th <= 0) {
    showToast('阈值需为正数（万）', 3000);
    return;
  }
  autoCompactEnabled = enabled;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('lingya-auto-compact-enabled', enabled ? '1' : '0');
    localStorage.setItem('lingya-auto-compact-threshold', String(th));
  } catch (_) {}
  showToast('自动压缩设置已保存：' + (enabled ? '开启，阈值 ' + th + ' 万' : '关闭'), 2500);
}

/**
 * 检查是否触发自动压缩
 * 数据源：state.serverTokenUsage.accumulatedTokens
 */
function checkAutoCompact() {
  if (!autoCompactEnabled || autoCompactTriggering) return;
  const server = state.serverTokenUsage;
  if (!server || typeof server.accumulatedTokens !== 'number') return;
  const thresholdTokens = autoCompactThresholdWan * 10000;
  if (server.accumulatedTokens < thresholdTokens) return;
  // 触发
  autoCompactTriggering = true;
  console.log('[LingYa Compact] 自动触发：当前 ' + server.accumulatedTokens + ' >= 阈值 ' + thresholdTokens);
  showToast('Token 超阈值（' + autoCompactThresholdWan + '万），自动压缩中...', 4000);
  runCompaction().finally(() => {
    // 压缩会跳转页面；若未跳转（失败），重置标志允许下次重试
    autoCompactTriggering = false;
  });
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

  // 从 localStorage 恢复延迟配置
  try {
    const savedMin = localStorage.getItem('lingya-send-delay-min');
    const savedMax = localStorage.getItem('lingya-send-delay-max');
    if (savedMin) state.sendDelayMin = parseInt(savedMin, 10) || 2000;
    if (savedMax) state.sendDelayMax = parseInt(savedMax, 10) || 4000;
    // 同步到输入框
    const minInput = document.getElementById('lingya-delay-min');
    const maxInput = document.getElementById('lingya-delay-max');
    if (minInput) minInput.value = state.sendDelayMin;
    if (maxInput) maxInput.value = state.sendDelayMax;
  } catch (e) {}

  const minimizeBtn = document.getElementById('lingya-btn-minimize');
  const initBtn = document.getElementById('lingya-btn-init');
  const clearBtn = document.getElementById('lingya-btn-clear');

  minimizeBtn?.addEventListener('click', hideOverlay);
  initBtn?.addEventListener('click', handleInitProject);

  // 压缩上下文按钮
  const compactBtn = document.getElementById('lingya-btn-compact');
  compactBtn?.addEventListener('click', runCompaction);

  // 首次使用提示浮窗：初始化按钮（与右侧初始化项目逻辑一致）
  const firstInitBtn = document.getElementById('lingya-btn-first-init');
  firstInitBtn?.addEventListener('click', handleInitProject);

  // 首次使用提示浮窗：关闭按钮
  const firstCloseBtn = document.getElementById('lingya-btn-first-close');
  firstCloseBtn?.addEventListener('click', hideFirstTimeDialog);
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

  // 保存延迟设置按钮
  const saveDelayBtn = document.getElementById('lingya-btn-save-delay');
  const delayMinInput = document.getElementById('lingya-delay-min');
  const delayMaxInput = document.getElementById('lingya-delay-max');
  saveDelayBtn?.addEventListener('click', () => {
    const min = parseInt(delayMinInput?.value, 10);
    const max = parseInt(delayMaxInput?.value, 10);
    if (Number.isNaN(min) || min < 0) { showToast('最小延迟必须是非负整数', 3000); return; }
    if (Number.isNaN(max) || max < min) { showToast('最大延迟不能小于最小延迟', 3000); return; }
    if (max > 10000) { showToast('最大延迟不能超过 10000ms', 3000); return; }
    state.sendDelayMin = min;
    state.sendDelayMax = max;
    // 保存到 localStorage
    try {
      localStorage.setItem('lingya-send-delay-min', String(min));
      localStorage.setItem('lingya-send-delay-max', String(max));
    } catch (e) {}
    showToast('延迟设置已保存：' + min + ' - ' + max + ' ms', 3000);
  });

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

  // 记忆面板事件
  bindMemoryPanelEvents();
  // 技能面板事件
  bindSkillPanelEvents();
  // 安全增强面板事件
  bindSecurityPanelEvents();
  // Agent 模式（Plan / Build）切换
  bindAgentPanelEvents();

  // 新会话自动注入开关：恢复状态 + 保存
  const autoInjectEl = document.getElementById('lingya-auto-inject');
  if (autoInjectEl) {
    autoInjectEl.checked = localStorage.getItem('lingya-auto-inject') === '1';
    autoInjectEl.addEventListener('change', saveAutoInjectSetting);
  }

  // 自动压缩：加载配置 + 绑定保存按钮
  loadAutoCompactConfig();
  const autoSaveBtn = document.getElementById('lingya-auto-compact-save');
  autoSaveBtn?.addEventListener('click', saveAutoCompactConfig);

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
      hideFirstTimeDialog();
    }
  });
}

module.exports = bindEvents;
module.exports.stopTask = stopTask;
module.exports.clearStopped = clearStopped;
