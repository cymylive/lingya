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
var BOTTOM_THRESHOLD = 20;

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
var isUserScrolling = false; // 用户是否正在主动滑动（用于阻断流式拽回）
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

var LS_HISTORY = 'lingya-remote-history';
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch (_) { return []; }
}
function addHistory(addr, token) {
  if (!addr || !token) return;
  var h = getHistory();
  h = h.filter(function(item) { return item.addr !== addr || item.token !== token; });
  h.unshift({ addr: addr, token: token, ts: Date.now() });
  localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(0, 5)));
}
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
  // 1. 先转字符串，去掉首尾空格
  var s = String(raw || '').trim();
  if (!s) return '';
  
  // 2. 移除所有中间的空格（防止 https:// xxx 这种）
  s = s.replace(/\s+/g, '');
  
  // 3. 如果末尾多复制了 http: 或 https:，强行切掉
  s = s.replace(/https?:?$/i, '');
  
  // 4. 如果没带协议，默认加上 https://（尝试连接隧道）
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  
  try {
    // 用 URL 解析一次，自动去掉多余的路径和后缀
    var u = new URL(s);
    return u.protocol + '//' + u.host;
  } catch (_) {
    // 如果 URL 解析失败，直接返回清洗后的字符串，让 fetch 去报错
    return s;
  }
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
  // 过滤可能导致 XSS 的伪协议
  var text = String(raw).replace(/javascript:/gi, '');
  text = escapeHtml(text);
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
  if (!force && (!stickToBottom || isUserScrolling)) return; // 双重拦截
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
    isUserScrolling = false; // 回到底部了，解除用户滑动锁
  } else {
    elScrollBtn.hidden = false;
  }
}
function clearEmpty() {
  if (elEmpty && elEmpty.parentNode) elEmpty.parentNode.removeChild(elEmpty);
  elEmpty = null;
}
function addDownloadCard(filePath, fileName, size) {
  clearEmpty();
  var el = document.createElement('div');
  el.className = 'msg system';
  el.style.cssText = 'text-align:left;background:var(--bg-2);border:1px solid var(--accent);padding:12px;border-radius:8px;';
  var sizeStr = size ? (size/1024/1024).toFixed(2) + ' MB' : '';
  el.innerHTML = '<div style="font-weight:600;color:var(--accent);margin-bottom:8px;">📁 电脑发送了一个文件</div>' +
                 '<div style="font-size:13px;word-break:break-all;margin-bottom:12px;">' + escapeHtml(fileName) + ' <span style="color:var(--text-dim);">(' + sizeStr + ')</span></div>' +
                 '<a href="' + baseUrl() + '/api/download?file=' + encodeURIComponent(filePath) + '&token=' + getToken() + '" target="_blank" style="display:inline-block;padding:8px 16px;background:var(--accent);color:#052e2b;text-decoration:none;border-radius:4px;font-size:13px;font-weight:600;">点击下载</a>';
  elMessages.appendChild(el);
  if (stickToBottom) scrollToBottom(true);
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
  }
  // 彻底取消这里的自动滚动
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
  // 彻底移除强制滚动，不再抢夺用户视线
  scrollToBottom(false);
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
  // 移除强制滚动
  scrollToBottom(false);
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
  
  // 发送按钮永远显示
  elSend.hidden = false;
  elSend.style.opacity = generating ? '0.5' : '1';
  
  // 停止按钮：永远可点！不管什么状态，哪怕看着像空闲，点一下也能强行发中断
  elStop.classList.remove('disabled');
  elStop.disabled = false;
  
  if (!generating) {
    hideTool();
  }
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
  if (t === 'token-usage') {
    var tb = $('token-badge');
    var tt = $('token-text');
    if (tb && tt && msg.context > 0) {
      tb.hidden = false;
      // 如果超过 1000，就用 k 表示
      var num = msg.context;
      tt.textContent = (num > 1000 ? (num / 1000).toFixed(1) + 'k' : num) + ' tk';
    }
    return;
  }
  if (t === 'file-download') {
    addDownloadCard(msg.filePath, msg.fileName, msg.size);
    return;
  }
  if (t === 'todo-update') {
    renderTodoPanel(msg.todos || []);
    return;
  }
  if (t === 'task-state') {
    if (msg.text) {
      elExec.hidden = false;
      elExecText.textContent = msg.text;
    }
    return;
  }
  if (t === 'ai-stream') return onAiStream(msg);
  if (t === 'ai-reply') return onAiReply(msg);
  if (t === 'ai-stop') return onAiStop(msg);
  if (t === 'ai-error') return onAiError(msg);
  if (t === 'tool') return onTool(msg);
  if (t === 'sys') return onSys(msg);
  if (t === 'pong') return;
  if (t === 'sessions-data') return onSessionsData(msg);
}

var currentDrawerTab = 'workspace';

function onSessionsData(msg) {
  var list = $('session-list');
  if (!list) return;
  var sessions = msg.sessions || [];
  var archivedProjects = msg.archivedProjects || [];
  
  var isProjArchived = {};
  archivedProjects.forEach(function(dir) { isProjArchived[dir] = true; });

  var projects = {};
  sessions.forEach(function(s) {
    var pDir = s.projectDir || '未分类项目';
    if (!projects[pDir]) projects[pDir] = { dir: pDir, sessions: [] };
    projects[pDir].sessions.push(s);
  });

  var html = '';
  var pKeys = Object.keys(projects).sort();
  
  pKeys.forEach(function(pDir) {
    var proj = projects[pDir];
    var projArchived = isProjArchived[pDir] === true;

    if (currentDrawerTab === 'workspace' && projArchived) return;
    if (currentDrawerTab === 'archived' && !projArchived) return;

    var pName = pDir.split(/[\\/]/).pop();
    var isOpen = proj.sessions.some(function(s) { return s.sessionId === currentProfileId; });
    var openCls = isOpen ? 'open' : '';

    var activeSessions = proj.sessions.filter(function(s) { return !s.archived; });
    var archSessions = proj.sessions.filter(function(s) { return !!s.archived; });

    html += '<div class="project-group ' + openCls + '">';
    html += '<div class="project-header">' +
            '<div class="project-title">📁 ' + escapeHtml(pName) + '</div>' +
            '<div class="project-actions" data-pdir="' + escapeHtml(pDir) + '" data-arch="' + projArchived + '">⋮</div>' +
            '<div class="project-add-session" data-pdir="' + escapeHtml(pDir) + '" title="在该项目下新建会话">+</div>' +
            '<div class="todo-chevron" style="margin-left:8px;">▾</div>' +
            '</div>';
    
    html += '<div class="project-sessions">';
    activeSessions.forEach(function(s) { html += renderItem(s); });

    if (archSessions.length > 0) {
      html += '<div class="archived-group">' +
              '<div class="archived-header">▶ 已归档 ' + archSessions.length + ' 对话</div>' +
              '<div class="archived-sessions">';
      archSessions.forEach(function(s) { html += renderItem(s); });
      html += '</div></div>';
    }
    html += '</div></div>';
  });

  if (!html) html = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px;">暂无会话</div>';
  list.innerHTML = html;

  list.querySelectorAll('.project-header').forEach(function(h) {
    h.addEventListener('click', function(e) {
      if (e.target.classList.contains('project-actions')) return;
      h.parentNode.classList.toggle('open');
    });
  });

  list.querySelectorAll('.archived-header').forEach(function(h) {
    h.addEventListener('click', function(e) {
      e.stopPropagation();
      h.parentNode.classList.toggle('open');
    });
  });



  list.querySelectorAll('.project-actions').forEach(function(el) {
    el.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var pDir = el.getAttribute('data-pdir');
      var isArch = el.getAttribute('data-arch') === 'true';
      var action = prompt('输入操作：1=归档项目, 2=取消归档项目');
      if (action === '1' && !isArch) {
        send({ type: 'action-archive-project', profileId: currentProfileId, projectDir: pDir, archived: true });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      } else if (action === '2' && isArch) {
        send({ type: 'action-archive-project', profileId: currentProfileId, projectDir: pDir, archived: false });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      }
    });
  });

  list.querySelectorAll('.session-item').forEach(bindSessionItem);

  // 统一使用事件委托处理 + 号点击，避免动态插入导致绑定失效
  list.onclick = function(e) {
    var target = e.target;
    if (target.classList.contains('project-add-session')) {
      e.stopPropagation();
      var pDir = target.getAttribute('data-pdir');
      if (!pDir) return;
      
      // 直接执行，不弹 confirm，因为新建会话不是破坏性操作
      send({ type: 'action-new-session-in-project', profileId: currentProfileId, projectDir: pDir });
      var d = $('sidebar-drawer'); if(d) d.classList.remove('open');
      var o = $('drawer-overlay'); if(o) { o.classList.remove('open'); setTimeout(function(){o.hidden=true;},200); }
      elMessages.innerHTML = '';
      if (!elEmpty) {
        elEmpty = document.createElement('div');
        elEmpty.className = 'empty-state';
        elEmpty.innerHTML = '<p style="color:var(--text-dim)">正在新建项目会话...</p>';
        elMessages.appendChild(elEmpty);
      }
    }
  };
}

function renderItem(s) {
  var title = s.title || s.sessionId || '未命名会话';
  var activeCls = (s.sessionId === currentProfileId) ? ' active' : '';
  return '<div class="session-item ' + activeCls + '" data-sid="' + escapeHtml(s.sessionId) + '">' +
         '<div class="s-title" style="padding-right:20px;">' + escapeHtml(title) + '</div>' +
         '<div class="session-more-btn" data-sid="' + escapeHtml(s.sessionId) + '">⋮</div>' +
         '</div>';
}

function bindSessionItem(el) {
  var moreBtn = el.querySelector('.session-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var sid = el.getAttribute('data-sid');
      var action = prompt('输入操作：1=重命名, 2=导入历史, 3=删除, 4=归档/取消归档');
      if (action === '4') {
        send({ type: 'action-archive-session', profileId: currentProfileId, sessionId: sid, archived: !el.closest('.archived-sessions') });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      } else if (action === '3') {
        if (confirm('确定要删除这个会话吗？此操作不可恢复！')) {
          send({ type: 'action-delete-session', profileId: currentProfileId, sessionId: sid });
        }
      } else if (action === '1') {
        var newName = prompt('输入新的会话名称：');
        if (newName) {
          send({ type: 'action-rename', profileId: currentProfileId, sessionId: sid, title: newName });
          setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
        }
      } else if (action === '2') {
        send({ type: 'action-import', profileId: currentProfileId, sourceSessionId: sid });
        alert('历史导入指令已发送，请查看当前对话。');
        var d = $('sidebar-drawer'); if(d) d.classList.remove('open');
        var o = $('drawer-overlay'); if(o) { o.classList.remove('open'); setTimeout(function(){o.hidden=true;},200); }
      }
    });
  }

  el.addEventListener('click', function() {
    var sid = el.getAttribute('data-sid');
    send({ type: 'action-switch-session', profileId: currentProfileId, session: { sessionId: sid } });
    var d = $('sidebar-drawer'); if(d) d.classList.remove('open');
    var o = $('drawer-overlay'); if(o) { o.classList.remove('open'); setTimeout(function(){o.hidden=true;},200); }
    elMessages.innerHTML = '';
    if (!elEmpty) {
      elEmpty = document.createElement('div');
      elEmpty.className = 'empty-state';
      elEmpty.innerHTML = '<p style="color:var(--text-dim)">正在同步对话...</p>';
      elMessages.appendChild(elEmpty);
    }
    setTimeout(function() { send({ type: 'refresh-history' }); }, 1500);
  });
}

function renderTodoPanel(todos) {
  var panel = $('todo-panel');
  var list = $('todo-list');
  var prog = $('todo-progress');
  if (!panel || !list || !prog) return;

  // 如果没有计划，隐藏
  if (!todos || todos.length === 0) {
    panel.hidden = true;
    return;
  }

  var done = 0;
  var html = '';
  for (var i = 0; i < todos.length; i++) {
    var t = todos[i] || {};
    var status = t.status || 'pending';
    if (status === 'completed') done++;
    
    var icon = '○';
    var cls = '';
    if (status === 'completed') { icon = '✅'; cls = 'done'; }
    else if (status === 'in_progress') { icon = '⏳'; cls = 'in-progress'; }
    
    html += '<div class="todo-item ' + cls + '">' +
            '<span class="todo-icon">' + icon + '</span>' +
            '<span>' + escapeHtml(t.content || '') + '</span>' +
            '</div>';
  }
  
  list.innerHTML = html;
  prog.textContent = done + '/' + todos.length;
  panel.hidden = false;
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
  elExec.hidden = false;
  elExecText.textContent = 'AI 正在思考…';
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
  // 用户自己发消息时，强制滚到底部让他看到
  stickToBottom = true;
  isUserScrolling = false;
  scrollToBottom(true);
  
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
  // 加上一点余量（比如 2px）防止部分安卓 WebView 的 scrollHeight 计算偏小导致文字被切
  var newHeight = elInput.scrollHeight + 2;
  elInput.style.height = Math.min(newHeight, 140) + 'px';
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
  // 保存历史记录
  addHistory(addr || location.origin, tok);
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

  var elHistoryBtn = $('login-history-btn');
  var elHistoryMenu = $('login-history');

  if (elHistoryBtn) {
    elHistoryBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!elHistoryMenu) return;
      elHistoryMenu.hidden = !elHistoryMenu.hidden;
      if (!elHistoryMenu.hidden) renderHistoryMenu();
    });
  }

  document.addEventListener('click', function (e) {
    if (elHistoryMenu && !elHistoryMenu.hidden) {
      if (!elHistoryMenu.contains(e.target) && e.target !== elHistoryBtn && !elHistoryBtn.contains(e.target)) {
        elHistoryMenu.hidden = true;
      }
    }
  });

  function renderHistoryMenu() {
    if (!elHistoryMenu) return;
    var h = getHistory();
    var html = '<div class="login-history-item" id="login-paste-item">' +
               '<div class="h-addr"><svg class="ico" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:4px;"><use href="#i-plus"/></svg>从剪贴板粘贴</div>' +
               '</div>';
    for (var i = 0; i < h.length; i++) {
      var item = h[i];
      html += '<div class="login-history-item" data-idx="' + i + '">' +
              '<div class="h-addr">' + escapeHtml(item.addr) + '</div>' +
              '<div class="h-token">' + escapeHtml(item.token.slice(0, 8)) + '...</div>' +
              '</div>';
    }
    if (h.length === 0) {
      html += '<div style="padding:10px 12px;font-size:12px;color:var(--text-dim);text-align:center;">暂无历史记录</div>';
    }
    elHistoryMenu.innerHTML = html;

    var pasteItem = $('login-paste-item');
    if (pasteItem) {
      pasteItem.onclick = async function() {
        try {
          var t = await navigator.clipboard.readText();
          if (t) { elToken.value = t.trim(); elToken.focus(); }
        } catch (_) {
          showLoginError('无法读取剪贴板，请长按粘贴');
        }
        elHistoryMenu.hidden = true;
      };
    }

    var items = elHistoryMenu.querySelectorAll('.login-history-item[data-idx]');
    for (var j = 0; j < items.length; j++) {
      (function(el) {
        el.onclick = function() {
          var idx = parseInt(el.getAttribute('data-idx'), 10);
          var item = h[idx];
          if (item) {
            elAddr.value = item.addr;
            elToken.value = item.token;
            showLoginError('');
            elHistoryMenu.hidden = true;
            doConnect();
          }
        };
      })(items[j]);
    }
  }

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

  // === 抽屉交互 ===
  var elMenu = $('btn-menu');
  var elDrawer = $('sidebar-drawer');
  var elDrawerOverlay = $('drawer-overlay');
  var tabs = document.querySelectorAll('.drawer-tab');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentDrawerTab = tab.getAttribute('data-tab');
      send({ type: 'req-sessions', profileId: currentProfileId });
    });
  });

  var elNewProject = $('btn-new-project');
  var elSessionList = $('session-list');

  function toggleDrawer(open) {
    if (open) {
      elDrawer.classList.add('open');
      elDrawerOverlay.hidden = false;
      requestAnimationFrame(function() { elDrawerOverlay.classList.add('open'); });
      send({ type: 'req-sessions', profileId: currentProfileId });
    } else {
      elDrawer.classList.remove('open');
      elDrawerOverlay.classList.remove('open');
      setTimeout(function() { elDrawerOverlay.hidden = true; }, 200);
    }
  }

  if (elMenu) elMenu.addEventListener('click', function() { toggleDrawer(true); });
  if (elDrawerOverlay) elDrawerOverlay.addEventListener('click', function() { toggleDrawer(false); });

  // 重复声明已移除
  var elModalOverlay = $('modal-overlay');
  var elModalTitle = $('modal-title');
  var elModalInput = $('modal-input');
  var elModalCancel = $('modal-cancel');
  var elModalConfirm = $('modal-confirm');
  var modalCallback = null;

  function showModal(title, placeholder, cb) {
    elModalTitle.textContent = title;
    elModalInput.value = '';
    elModalInput.placeholder = placeholder || '请输入...';
    elModalOverlay.hidden = false;
    modalCallback = cb;
    setTimeout(function() { elModalInput.focus(); }, 100);
  }
  function hideModal() { elModalOverlay.hidden = true; modalCallback = null; }

  if (elModalCancel) elModalCancel.addEventListener('click', hideModal);
  if (elModalConfirm) {
    elModalConfirm.addEventListener('click', function() {
      var val = elModalInput.value.trim();
      if (val && modalCallback) modalCallback(val);
      hideModal();
    });
  }
  if (elModalInput) {
    elModalInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') elModalConfirm.click();
    });
  }

  if (elNewProject) {
    elNewProject.addEventListener('click', function() {
      showModal('新建项目', '输入项目名称（将在桌面创建）', function(name) {
        send({ type: 'action-init-project', profileId: currentProfileId, projectName: name });
        toggleDrawer(false);
        setTimeout(function() { send({ type: 'refresh-history' }); }, 2000);
      });
    });
  }

  // === AI 计划面板折叠交互 ===
  var elTodoPanel = $('todo-panel');
  var elTodoHeader = $('todo-header');
  if (elTodoHeader) {
    elTodoHeader.addEventListener('click', function() {
      if (elTodoPanel) {
        elTodoPanel.classList.toggle('collapsed');
      }
    });
  }

  elTheme.addEventListener('click', toggleTheme);
  elDisconnect.addEventListener('click', function () {
    if (confirm('确定断开连接？')) disconnect();
  });

  var elAttach = $('btn-attach');
  var elFileUpload = $('file-upload');
  if (elAttach && elFileUpload) {
    elAttach.addEventListener('click', function() { elFileUpload.click(); });
    elFileUpload.addEventListener('change', async function() {
      if (!this.files || this.files.length === 0) return;
      var files = Array.from(this.files);
      this.value = ''; // 清空允许重复上传
      
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        addSystem('⏳ 正在上传: ' + file.name + ' (' + (file.size/1024/1024).toFixed(2) + ' MB)');
        
        try {
          var base = baseUrl().replace(/\/+$/, '');
          var res = await fetch(base + '/api/upload', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + getToken(),
              'X-File-Name': encodeURIComponent(file.name)
            },
            body: file
          });
          if (res.ok) {
            var json = await res.json();
            addSystem('✅ 上传成功: ' + file.name);
            // 通知电脑端将文件插入输入框
            send({ type: 'file-uploaded-notify', filePath: json.filePath, fileName: json.fileName });
          } else {
            addError('上传失败: ' + file.name);
          }
        } catch (err) {
          addError('上传异常: ' + err.message);
        }
      }
    });
  }

  elSend.addEventListener('click', sendText);
  elStop.addEventListener('click', function() {
    // 强行中断，不管前端的 generating 状态是什么，直接向电脑端发送 stop
    send({ type: 'stop' });
    // 本地先乐观地恢复状态
    setGenerating(false);
    finalizeStream(null);
    addSystem('已发送停止指令');
  });
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
    var isAtBottom = nearBottom();
    // 只有真正滑到底部，才允许重置 stickToBottom
    if (isAtBottom) {
      stickToBottom = true;
      isUserScrolling = false; // 到底了，解除锁定
    } else if (isUserScrolling) {
      stickToBottom = false;
    }
    updateScrollBtn();
  });

  // 只要手指触碰或滚动滚轮，立刻上锁，禁止任何流式拽回
  elMessages.addEventListener('touchstart', function () {
    isUserScrolling = true;
    stickToBottom = false;
    updateScrollBtn();
  }, { passive: true });
  
  // 只要手指碰了屏幕，立刻把底部强制跟随关掉，哪怕还没滑动
  elMessages.addEventListener('mousedown', function () {
    isUserScrolling = true;
    stickToBottom = false;
    updateScrollBtn();
  });
  
  elMessages.addEventListener('wheel', function () {
    isUserScrolling = true;
    stickToBottom = false;
    updateScrollBtn();
  }, { passive: true });

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
