/* 灵鸦远程 · 手机端主逻辑 */
(function () {
'use strict';

/* ========== 常量 ========== */
var LS_TOKEN = 'lingya-remote-token';
var LS_ADDR = 'lingya-remote-addr';
var LS_DRAFT = 'lingya-remote-draft';
var LS_THEME = 'lingya-remote-theme';
var LS_CLIENT = 'lingya-client-id';
var LS_PET_X = 'lingya-pet-x';

var RECONNECT_BASE = 500;
var RECONNECT_MAX = 8000;
var DISCONNECT_DEBOUNCE = 3000;
var STARTUP_WATCHDOG = 8000;
var HEARTBEAT_INTERVAL = 25000;
var OFFLINE_QUEUE_MAX = 50;
var BOTTOM_THRESHOLD = 60;

/* ========== DOM ========== */
function $(id) { return document.getElementById(id); }
var elLogin = $('login');
var elApp = $('app');
var elAddr = $('login-addr');
var elToken = $('login-token');
var elPaste = $('login-paste');
var elConnect = $('login-connect');
var elLoginErr = $('login-error');
var elConn = $('conn');
var elConnText = $('conn-text');
var elProfileSel = $('profile-select');
var elTheme = $('btn-theme');
var elDisconnect = $('btn-disconnect');
var elOffline = $('offline-banner');
var elMessages = $('messages');
var elEmpty = $('empty-state');
var elExec = $('exec-status');
var elExecText = $('exec-text');
var elScrollBtn = $('scroll-bottom-btn');
var elScrollBadge = $('scroll-new-badge');
var elInput = $('input');
var elSend = $('send');
var elStop = $('stop');

/* ========== 状态 ========== */
var ws = null;
var wsGen = 0;
var connected = false;
var reconnectDelay = RECONNECT_BASE;
var reconnectTimer = null;
var disconnectTimer = null;
var startupWatchdog = null;
var heartbeatTimer = null;
var manualClose = false;
var currentProfileId = '';
var profilesReady = false;
var profilesCache = [];
var offlineQueue = [];
var clientId = '';
var stickToBottom = true;
var hasNewWhileScrolled = false;

/* 流式状态（当前气泡） */
var streamEl = null;      // .msg.assistant 容器
var streamBodyEl = null;  // 正文容器
var streamThinkEl = null; // 思考容器（details）
var streamText = '';
var streamThink = '';

/* 工具计时 */
var toolChipEl = null;
var toolStartAt = 0;
var toolTickTimer = null;
var toolLastTickAt = 0;
var toolName = '';

/* 当前是否生成中 */
var generating = false;

/* ========== 工具函数 ========== */
function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
function getAddr() { return localStorage.getItem(LS_ADDR) || ''; }
function baseUrl() {
  var a = getAddr();
  if (a) return a.replace(/\/+$/, '');
  if (window.Capacitor) return '';
  return location.origin;
}
function wsUrl() {
  var b = baseUrl();
  if (!b) return '';
  return b.replace(/^http/, 'ws') + '/ws';
}
function normalizeAddr(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { var u = new URL(s); return u.protocol + '//' + u.host; } catch (_) { return ''; }
}
function ensureClientId() {
  var c = localStorage.getItem(LS_CLIENT);
  if (!c) {
    c = 'c_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
    localStorage.setItem(LS_CLIENT, c);
  }
  clientId = c;
}

/* ========== Markdown（最小实现，无外部依赖） ========== */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function renderMarkdown(raw) {
  if (!raw) return '';
  var text = escapeHtml(raw);
  var fences = [];
  // 抽取代码块
  text = text.replace(/\`\`\`([a-zA-Z0-9_-]*)\n([\s\S]*?)\`\`\`/g, function (_m, lang, code) {
    var idx = fences.length;
    fences.push({ lang: lang || '', code: code });
    return '\u0000FENCE' + idx + '\u0000';
  });
  // 行内代码
  text = text.replace(/\`([^\`\n]+)\`/g, '<code>$1</code>');
  // 粗体/斜体
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 链接
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // 换行
  text = text.replace(/\n/g, '<br>');
  // 还原代码块
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, function (_m, i) {
    var f = fences[Number(i)];
    if (!f) return '';
    var cls = f.lang ? ' class="lang-' + escapeHtml(f.lang) + '"' : '';
    return '<pre data-fence="1"><button class="copy-code-btn" type="button">复制</button><code' + cls + '>' + f.code + '</code></pre>';
  });
  return text;
}

/* ========== 消息渲染 ========== */
function scrollToBottom(force) {
  if (!force && !stickToBottom) return;
  requestAnimationFrame(function () {
    elMessages.scrollTop = elMessages.scrollHeight;
  });
}
function nearBottom() {
  var gap = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight;
  return gap <= BOTTOM_THRESHOLD;
}
function updateScrollBtn() {
  if (stickToBottom) {
    elScrollBtn.hidden = true;
    elScrollBadge.hidden = true;
    hasNewWhileScrolled = false;
  } else {
    elScrollBtn.hidden = false;
  }
}
function clearEmpty() {
  if (elEmpty && elEmpty.parentNode) elEmpty.parentNode.removeChild(elEmpty);
  elEmpty = null;
}
function addMessage(kind, text) {
  clearEmpty();
  var el = document.createElement('div');
  el.className = 'msg ' + kind;
  if (kind === 'assistant' && text) {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text || '';
  }
  elMessages.appendChild(el);
  if (!stickToBottom) {
    hasNewWhileScrolled = true;
    elScrollBadge.hidden = false;
  } else {
    scrollToBottom(true);
  }
  return el;
}
function addSystem(text) { return addMessage('system', text); }
function addError(text) { return addMessage('error', text); }
function addUser(text) { return addMessage('user', text); }

/* 流式气泡 */
function ensureStreamEl() {
  if (streamEl && streamEl.parentNode) return;
  clearEmpty();
  streamEl = document.createElement('div');
  streamEl.className = 'msg assistant';
  streamThinkEl = document.createElement('details');
  streamThinkEl.className = 'think-block';
  streamThinkEl.hidden = true;
  var sum = document.createElement('summary');
  sum.textContent = '思考过程';
  var tb = document.createElement('div');
  tb.className = 'think-body';
  streamThinkEl.appendChild(sum);
  streamThinkEl.appendChild(tb);
  streamThinkEl._body = tb;
  streamBodyEl = document.createElement('div');
  streamBodyEl.className = 'stream-body';
  streamEl.appendChild(streamThinkEl);
  streamEl.appendChild(streamBodyEl);
  elMessages.appendChild(streamEl);
  streamText = '';
  streamThink = '';
  scrollToBottom(true);
}
function updateStream(thinkDelta, textDelta, reset) {
  ensureStreamEl();
  if (reset) {
    streamText = '';
    streamThink = '';
  }
  if (thinkDelta) {
    streamThink += thinkDelta;
    streamThinkEl.hidden = false;
    streamThinkEl._body.textContent = streamThink;
  }
  if (textDelta) {
    streamText += textDelta;
    streamBodyEl.innerHTML = renderMarkdown(streamText);
    bindCopyButtons(streamBodyEl);
  }
  scrollToBottom(false);
}
function finalizeStream(finalText) {
  if (finalText != null && finalText !== '') {
    if (!streamEl) ensureStreamEl();
    streamText = finalText;
    streamBodyEl.innerHTML = renderMarkdown(streamText);
    bindCopyButtons(streamBodyEl);
  }
  if (streamEl) {
    if (!streamBodyEl.innerHTML && !streamText) {
      if (streamThink) {
        streamBodyEl.innerHTML = '<span style="color:var(--text-dim)">（无正文）</span>';
      } else {
        streamEl.parentNode && streamEl.parentNode.removeChild(streamEl);
      }
    }
  }
  streamEl = null;
  streamBodyEl = null;
  streamThinkEl = null;
  streamText = '';
  streamThink = '';
}
function bindCopyButtons(root) {
  var btns = root.querySelectorAll('.copy-code-btn');
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', function () {
        var pre = btn.parentNode;
        var code = pre && pre.querySelector('code');
        if (!code) return;
        var txt = code.textContent;
        try {
          navigator.clipboard.writeText(txt).then(function () {
            btn.textContent = '已复制';
            setTimeout(function () { btn.textContent = '复制'; }, 1500);
          });
        } catch (_) {}
      });
    })(btns[i]);
  }
}

/* 工具 chip */
function showTool(name) {
  toolName = name || '';
  generating = true;
  elExec.hidden = false;
  elExecText.textContent = '工具执行中' + (toolName ? '：' + toolName : '') + ' 0s';
  toolStartAt = Date.now();
  toolLastTickAt = Date.now();
  if (toolTickTimer) clearInterval(toolTickTimer);
  toolTickTimer = setInterval(function () {
    var now = Date.now();
    var gap = now - toolLastTickAt;
    if (gap > 2000) toolStartAt += gap; // 后台冻结补偿
    toolLastTickAt = now;
    var sec = Math.floor((now - toolStartAt) / 1000);
    elExecText.textContent = '工具执行中' + (toolName ? '：' + toolName : '') + ' ' + sec + 's';
  }, 1000);
  addToolCard(toolName, false);
}
function hideTool() {
  elExec.hidden = true;
  if (toolTickTimer) { clearInterval(toolTickTimer); toolTickTimer = null; }
  markLastToolDone();
}
function addToolCard(name, done) {
  clearEmpty();
  var el = document.createElement('div');
  el.className = 'msg tool' + (done ? ' done' : '');
  el.innerHTML = '<svg class="ico"><use href="#i-tool"/></svg><span>' + escapeHtml(name || '工具') + (done ? '（完成）' : '') + '</span>';
  elMessages.appendChild(el);
  scrollToBottom(true);
}
function markLastToolDone() {
  var cards = elMessages.querySelectorAll('.msg.tool:not(.done)');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.add('done');
    var sp = cards[i].querySelector('span');
    if (sp && sp.textContent.indexOf('完成') < 0) sp.textContent = sp.textContent + '（完成）';
  }
}


/* 生成态 */
function setGenerating(v) {
  generating = !!v;
  elSend.hidden = generating;
  elStop.hidden = !generating;
  if (!generating) hideTool();
}

/* ========== 连接 ========== */
function setConn(state, text) {
  elConn.className = 'conn-badge' + (state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : '');
  elConnText.textContent = text;
}
function showOffline(v) { elOffline.hidden = !v; }

function buildWsProtocols() {
  var tok = getToken();
  return tok ? ['lingya.' + tok] : [];
}

function connect() {
  if (manualClose) return;
  var url = wsUrl();
  if (!url) { addError('未配置电脑地址'); return; }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  var myGen = ++wsGen;
  try {
    ws = new WebSocket(url, buildWsProtocols());
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.onopen = function () {
    if (myGen !== wsGen) return;
    connected = true;
    reconnectDelay = RECONNECT_BASE;
    setConn('ok', '已连接');
    showOffline(false);
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    if (startupWatchdog) { clearTimeout(startupWatchdog); startupWatchdog = null; }
    setGenerating(false);
    send({ type: 'auth', clientId: clientId });
    flushOfflineQueue();
    startHeartbeat();
  };
  ws.onclose = function () {
    if (myGen !== wsGen) return;
    connected = false;
    stopHeartbeat();
    setConn('bad', '未连接');
    if (startupWatchdog) { clearTimeout(startupWatchdog); startupWatchdog = null; }
    if (!disconnectTimer) {
      disconnectTimer = setTimeout(function () {
        disconnectTimer = null;
        if (!connected) showOffline(true);
      }, DISCONNECT_DEBOUNCE);
    }
    if (!manualClose) scheduleReconnect();
  };
  ws.onerror = function () {};
  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleServerMessage(msg);
  };
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(function () {
    if (ws && ws.readyState === 1) {
      send({ type: 'ping' });
    }
  }, HEARTBEAT_INTERVAL);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }
  return false;
}

function flushOfflineQueue() {
  if (!offlineQueue.length) return;
  var arr = offlineQueue.slice();
  offlineQueue.length = 0;
  for (var i = 0; i < arr.length; i++) {
    if (!send({ type: 'user-message', text: arr[i] })) {
      offlineQueue.push(arr[i]);
      break;
    }
  }
  if (offlineQueue.length) {
    addSystem('已暂存 ' + offlineQueue.length + ' 条消息，网络恢复后自动发送');
  }
}

/* ========== 服务端消息处理 ========== */
function handleServerMessage(msg) {
  var t = msg.type;
  if (t === 'profiles') return onProfiles(msg);
  if (t === 'history') return onHistory(msg);
  if (t === 'ai-start') return onAiStart(msg);
  if (t === 'ai-stream') return onAiStream(msg);
  if (t === 'ai-reply') return onAiReply(msg);
  if (t === 'ai-stop') return onAiStop(msg);
  if (t === 'ai-error') return onAiError(msg);
  if (t === 'tool') return onTool(msg);
  if (t === 'sys') return onSys(msg);
  if (t === 'pong') return;
}

function onProfiles(msg) {
  profilesCache = Array.isArray(msg.profiles) ? msg.profiles : [];
  var cur = msg.currentProfileId || '';
  if (!profilesReady) profilesReady = true;
  var sel = elProfileSel;
  var html = '<option value="">选择窗口…</option>';
  for (var i = 0; i < profilesCache.length; i++) {
    var p = profilesCache[i];
    var label = (p.name || p.id || '窗口') + (p.busy ? ' · 生成中' : '');
    html += '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(label) + '</option>';
  }
  sel.innerHTML = html;
  if (cur) {
    sel.value = cur;
    currentProfileId = cur;
  } else if (profilesCache.length === 1) {
    sel.value = profilesCache[0].id;
    currentProfileId = profilesCache[0].id;
    send({ type: 'select-profile', profileId: currentProfileId });
  } else if (profilesCache.length > 1 && !currentProfileId) {
    // 多窗口且当前未选中：默认选第一个
    sel.value = profilesCache[0].id;
    currentProfileId = profilesCache[0].id;
    send({ type: 'select-profile', profileId: currentProfileId });
  }
}

function onHistory(msg) {
  var pid = msg.profileId || '';
  var list = Array.isArray(msg.history) ? msg.history : [];
  // 切换窗口后清屏
  var all = elMessages.querySelectorAll('.msg');
  for (var i = 0; i < all.length; i++) elMessages.removeChild(all[i]);
  if (!list.length) {
    if (!elEmpty) {
      elEmpty = document.createElement('div');
      elEmpty.className = 'empty-state';
      elEmpty.innerHTML = '<svg class="ico ico-48"><use href="#i-bird"/></svg><p>连接成功，发一条消息开始对话</p>';
      elMessages.appendChild(elEmpty);
    }
    return;
  }
  for (var j = 0; j < list.length; j++) {
    var e = list[j];
    if (!e || !e.text) continue;
    if (e.t === 'user') addUser(e.text);
    else if (e.t === 'assistant') addMessage('assistant', e.text);
    else addSystem(e.text);
  }
  scrollToBottom(true);
}

function onAiStart(_msg) {
  setGenerating(true);
  streamEl = null;
  streamText = '';
  streamThink = '';
  if (toolChipEl && toolChipEl.parentNode) toolChipEl.parentNode.removeChild(toolChipEl);
  toolChipEl = null;
}

function onAiStream(msg) {
  var pid = msg.profileId || '';
  if (pid && currentProfileId && pid !== currentProfileId) return;
  if (!generating) setGenerating(true);
  updateStream(msg.thinkDelta || '', msg.textDelta || '', !!msg.reset);
}

function onAiReply(msg) {
  var pid = msg.profileId || '';
  if (pid && currentProfileId && pid !== currentProfileId) return;
  finalizeStream(msg.text || '');
  setGenerating(false);
  hideTool(); // 强制清理
}

function onAiStop(msg) {
  finalizeStream(null);
  setGenerating(false);
  if (msg.reason !== 'watchdog') {
    addSystem('已停止生成');
  }
}

function onAiError(msg) {
  finalizeStream(null);
  setGenerating(false);
  addError('出错了：' + (msg.text || '未知错误'));
}

function onTool(msg) {
  var pid = msg.profileId || '';
  if (pid && currentProfileId && pid !== currentProfileId) return;
  if (msg.ended) {
    hideTool();
    return;
  }
  // 先收尾已有流式气泡，把工具卡片独立展示
  if (streamEl) finalizeStream(streamText);
  showTool(msg.name || '');
}

function onSys(msg) {
  if (msg.text) {
    if (msg.keepBusy) {
      // 忙态提示：不打断 UI，只 toast 式系统消息
      addSystem(msg.text);
    } else {
      addSystem(msg.text);
    }
  }
}

/* ========== 用户输入 ========== */
function sendText() {
  var text = elInput.value.trim();
  if (!text) return;
  elInput.value = '';
  autoResize();
  localStorage.removeItem(LS_DRAFT);
  addUser(text);
  if (!send({ type: 'user-message', text: text })) {
    if (offlineQueue.length >= OFFLINE_QUEUE_MAX) offlineQueue.shift();
    offlineQueue.push(text);
    addSystem('消息已暂存（' + offlineQueue.length + '），网络恢复后自动发送');
  }
}
function stopGeneration() {
  send({ type: 'stop' });
}

function autoResize() {
  elInput.style.height = 'auto';
  elInput.style.height = Math.min(elInput.scrollHeight, 140) + 'px';
}

/* ========== 登录 ========== */
function showLoginError(text) {
  elLoginErr.textContent = text;
  elLoginErr.hidden = !text;
}

async function doConnect() {
  showLoginError('');
  var addr = normalizeAddr(elAddr.value);
  var tok = elToken.value.trim();
  if (!addr && !window.Capacitor) {
    addr = location.origin;
  }
  if (addr && elAddr.value.trim()) {
    localStorage.setItem(LS_ADDR, addr);
  } else if (window.Capacitor && !addr) {
    showLoginError('请填写电脑地址（如 http://192.168.1.10:7799）');
    return;
  }
  if (!tok) { showLoginError('请填写访问令牌'); return; }
  localStorage.setItem(LS_TOKEN, tok);
  // 验证 /api/ping
  elConnect.disabled = true;
  elConnect.textContent = '连接中…';
  try {
    var base = addr || location.origin;
    var pingUrl = base.replace(/\/+$/, '') + '/api/ping';
    var res = await fetch(pingUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + tok },
    });
    if (res.status === 401) {
      showLoginError('令牌错误，请检查后重试');
      elConnect.disabled = false;
      elConnect.textContent = '连接';
      return;
    }
    if (!res.ok) {
      showLoginError('连接失败（HTTP ' + res.status + '），请检查地址');
      elConnect.disabled = false;
      elConnect.textContent = '连接';
      return;
    }
  } catch (err) {
    showLoginError('无法连接到 ' + (addr || '服务器') + '。如果是局域网，请确保同一 WiFi；如果使用隧道，地址可能已变化，请检查电脑端最新地址。');
    elConnect.disabled = false;
    elConnect.textContent = '连接';
    return;
  }
  elConnect.disabled = false;
  elConnect.textContent = '连接';
  // 进入应用
  enterApp();
}

function enterApp() {
  elLogin.hidden = true;
  elLogin.style.display = 'none';
  elApp.hidden = false;
  manualClose = false;
  setConn('', '连接中…');
  startupWatchdog = setTimeout(function () {
    startupWatchdog = null;
    if (!connected) {
      setConn('bad', '未连接');
      showOffline(true);
      addError('连接超时，正在重试…');
    }
  }, STARTUP_WATCHDOG);
  connect();
}

function disconnect() {
  manualClose = true;
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  connected = false;
  setConn('', '已断开');
  showOffline(false);
  elApp.hidden = true;
  elLogin.hidden = false;
  elLogin.style.display = '';
}

/* ========== 主题 ========== */
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
}
function toggleTheme() {
  var cur = localStorage.getItem(LS_THEME) || 'dark';
  var next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(LS_THEME, next);
  applyTheme(next);
}

/* ========== 事件绑定 ========== */
function bind() {
  elConnect.addEventListener('click', doConnect);

  elPaste.addEventListener('click', async function () {
    try {
      var t = await navigator.clipboard.readText();
      if (t) { elToken.value = t.trim(); elToken.focus(); }
    } catch (_) {
      showLoginError('无法读取剪贴板，请长按粘贴');
    }
  });

  elToken.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doConnect(); }
  });

  elProfileSel.addEventListener('change', function () {
    var pid = elProfileSel.value;
    currentProfileId = pid;
    if (pid) {
      // 切换窗口：清空界面并提示同步中
      elMessages.innerHTML = '';
      elEmpty = document.createElement('div');
      elEmpty.className = 'empty-state';
      elEmpty.innerHTML = '<p style="color:var(--text-dim)">正在同步对话...</p>';
      elMessages.appendChild(elEmpty);
      send({ type: 'select-profile', profileId: pid });
    }
  });

  var elRefresh = $('btn-refresh');
  if (elRefresh) {
    elRefresh.addEventListener('click', function () {
      elRefresh.style.opacity = '0.5';
      // 显示同步中状态
      if (elMessages.querySelectorAll('.msg').length === 0) {
        if (!elEmpty) {
          elEmpty = document.createElement('div');
          elEmpty.className = 'empty-state';
          elEmpty.innerHTML = '<p style="color:var(--text-dim)">正在同步对话...</p>';
          elMessages.appendChild(elEmpty);
        }
      }
      send({ type: 'refresh-history' });
      setTimeout(function() { elRefresh.style.opacity = '1'; }, 500);
    });
  }

  elTheme.addEventListener('click', toggleTheme);
  elDisconnect.addEventListener('click', function () {
    if (confirm('确定断开连接？')) disconnect();
  });

  elSend.addEventListener('click', sendText);
  elStop.addEventListener('click', stopGeneration);
  elInput.addEventListener('input', function () {
    autoResize();
    localStorage.setItem(LS_DRAFT, elInput.value);
  });
  elInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!generating) sendText();
    }
  });

  elMessages.addEventListener('scroll', function () {
    stickToBottom = nearBottom();
    updateScrollBtn();
  });

  elScrollBtn.addEventListener('click', function () {
    stickToBottom = true;
    scrollToBottom(true);
    updateScrollBtn();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!connected && !manualClose) {
        reconnectDelay = RECONNECT_BASE;
        connect();
      }
    }
  });
}

/* ========== 初始化 ========== */
function init() {
  ensureClientId();
  // 原生 APK 环境标记（用于处理状态栏安全区）
  if (window.Capacitor) {
    document.documentElement.classList.add('is-native');
    if (window.Capacitor.getPlatform() === 'android') {
      document.documentElement.classList.add('is-android');
    }
  }
  applyTheme(localStorage.getItem(LS_THEME) || 'dark');

  var savedTok = getToken();
  var savedAddr = getAddr();
  if (savedAddr) elAddr.value = savedAddr;
  if (savedTok) elToken.value = savedTok;

  var draft = localStorage.getItem(LS_DRAFT);
  if (draft) elInput.value = draft;

  bind();
  autoResize();

  // 自动连接：有保存的 token 且非 Capacitor（PWA 同源）
  if (savedTok && !window.Capacitor) {
    enterApp();
  } else if (savedTok && window.Capacitor && savedAddr) {
    enterApp();
  }

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
