(function () {
'use strict';

var LS_TOKEN = 'lingya-remote-token';
var LS_ADDR = 'lingya-remote-addr';
var LS_DRAFT = 'lingya-remote-draft';

var ws = null;
var connected = false;
var reconnectDelay = 500;
var reconnectTimer = null;
var manualClose = false;
var currentProfile = '';
var outbox = [];
var clients = {};
function $(id) { return document.getElementById(id); }

function baseUrl() {
  var a = localStorage.getItem(LS_ADDR);
  if (a) return a.replace(/\/+$/, '');
  if (window.Capacitor) return '';
  return location.origin;
}

function wsUrl() {
  var b = baseUrl();
  if (!b) return '';
  return b.replace(/^http/, 'ws') + '/ws';
}
function token() { return localStorage.getItem(LS_TOKEN) || ''; }

function setConn(ok, text) {
  var el = $('conn');
  el.textContent = text || (ok ? '已连接' : '未连接');
  el.className = 'conn' + (ok ? '' : ' bad');
}

function showOffline(v) { $('offline').hidden = !v; }
function addMsg(kind, text) {
  var el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  $('stream').appendChild(el);
  $('stream').scrollTop = $('stream').scrollHeight;
  return el;
}

function clearMsgs() { $('stream').innerHTML = ''; }
function petState(s){try{if(window.LingyaPet)window.LingyaPet.setState(s);}catch(_){}}
function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }
  return false;
}

function queueMsg(text) {
  if (outbox.length >= 50) outbox.shift();
  outbox.push(text);
}

function flushOutbox() {
  while (outbox.length) {
    var t = outbox.shift();
    if (!send({ type: 'user-message', text: t })) { outbox.unshift(t); break; }
  }
}
function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

function sendText(text) {
  if (!text) return;
  addMsg('user', text);
  petState('thinking');
  if (!send({ type: 'user-message', text: text, profileId: currentProfile })) {
    queueMsg(text);
    showOffline(true);
  }
}
function renderProfiles(list, current) {
  var sel = $('profileSel');
  sel.innerHTML = '';
  (list || []).forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + (p.busy ? ' · 生成中' : '');
    sel.appendChild(o);
  });
  if (current) { sel.value = current; currentProfile = current; }
  else if (sel.value) currentProfile = sel.value;
}
var curAiEl = null;
var curAiProfile = '';
var toolTimer = null;
var toolStart = 0;

function startTool(name) {
  toolStart = Date.now();
  var chip = $('toolChip');
  chip.hidden = false;
  chip.textContent = '工具运行 ' + (name || '') + ' 0s';
  if (toolTimer) clearInterval(toolTimer);
  toolTimer = setInterval(function () {
    var s = Math.floor((Date.now() - toolStart) / 1000);
    chip.textContent = '工具运行 ' + (name || '') + ' ' + s + 's';
  }, 500);
}

function stopTool() {
  if (toolTimer) { clearInterval(toolTimer); toolTimer = null; }
  $('toolChip').hidden = true;
}
function onMessage(ev) {
  var m;
  try { m = JSON.parse(ev.data); } catch (_) { return; }
  if (!m || !m.type) return;

  if (m.type === 'profiles') { renderProfiles(m.profiles, m.current); return; }
  if (m.type === 'pong') return;
  if (m.type === 'sys') { addMsg('sys', m.text || ''); petState('thinking'); return; }
  if (m.type === 'error') { addMsg('err', m.text || ''); stopTool(); petState('error'); return; }
  if (m.type === 'stream') {
    if (m.profileId && currentProfile && m.profileId !== currentProfile) return;
    if (!curAiEl || curAiProfile !== (m.profileId || '')) {
      curAiEl = addMsg('ai', '');
      curAiProfile = m.profileId || '';
    }
    curAiEl.textContent = m.text || '';
    $('stream').scrollTop = $('stream').scrollHeight;
    return;
  }
  if (m.type === 'tool') {
    if (m.profileId && currentProfile && m.profileId !== currentProfile) return;
    if (m.ended) { stopTool(); petState('working'); } else { startTool(m.name); petState('working'); }
    return;
  }
  if (m.type === 'ai-reply') {
    if (m.profileId && currentProfile && m.profileId !== currentProfile) return;
    curAiEl = null; curAiProfile = '';
    stopTool(); petState('done');
    if (m.text) addMsg('ai', m.text);
    return;
  }
}
function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  var url = wsUrl();
  var tok = token();
  if (!url || !tok) { showOffline(true); return; }

  try {
    ws = new WebSocket(url, ['lingya.' + tok]);
  } catch (e) {
    setConn(false, '连接失败');
    scheduleReconnect();
    return;
  }
  ws.onopen = function () {
    connected = true;
    reconnectDelay = 500;
    setConn(true, '已连接');
    showOffline(false);
    send({ type: 'auth', clientId: getClientId() });
    send({ type: 'ping' });
    flushOutbox();
  };

  ws.onmessage = onMessage;
  ws.onclose = function () {
    connected = false;
    setConn(false, '已断开');
    showOffline(true);
    stopTool(); petState('idle');
    if (!manualClose) scheduleReconnect();
  };

  ws.onerror = function () {
    try { ws.close(); } catch (_) {}
  };
}
function getClientId() {
  var k = 'lingya-remote-cid';
  var v = localStorage.getItem(k);
  if (!v) {
    v = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(k, v);
  }
  return v;
}
function doLogin() {
  var t = $('token').value.trim();
  var a = $('addr').value.trim();
  if (!t) { $('loginErr').textContent = '请输入令牌'; return; }
  localStorage.setItem(LS_TOKEN, t);
  if (a) localStorage.setItem(LS_ADDR, a);
  $('loginErr').textContent = '正在连接…';
  var url = baseUrl() + '/api/ping';
  fetch(url, { headers: { Authorization: 'Bearer ' + t } })
    .then(function (r) {
      if (!r.ok) throw new Error('令牌错误或服务不可达');
      $('login').hidden = true;
      $('app').hidden = false;
      $('loginErr').textContent = '';
      manualClose = false;
      connect();
    })
    .catch(function (e) { $('loginErr').textContent = e.message; });
}
function init() {
  if (token()) { $('token').value = token(); }
  var a = localStorage.getItem(LS_ADDR);
  if (a) $('addr').value = a;
  var d = localStorage.getItem(LS_DRAFT);
  if (d) $('input').value = d;
  if (token()) doLogin();
}
$('loginBtn').addEventListener('click', doLogin);
$('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

$('sendBtn').addEventListener('click', function () {
  var el = $('input');
  var t = el.value.trim();
  if (!t) return;
  el.value = '';
  localStorage.removeItem(LS_DRAFT);
  sendText(t);
});
$('input').addEventListener('input', function () {
  localStorage.setItem(LS_DRAFT, $('input').value);
});

$('input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('sendBtn').click(); }
});
$('stopBtn').addEventListener('click', function () {
  send({ type: 'stop', profileId: currentProfile });
  stopTool();
});

$('profileSel').addEventListener('change', function () {
  currentProfile = $('profileSel').value;
  clearMsgs();
  curAiEl = null;
  curAiProfile = '';
  send({ type: 'select-profile', profileId: currentProfile });
});
setInterval(function () {
  if (connected) send({ type: 'ping' });
}, 25000);

document.addEventListener('visibilitychange', function () {
  if (!document.hidden) {
    if (!connected) connect();
    else send({ type: 'ping' });
  }
});

window.addEventListener('online', function () { if (!connected) connect(); });

init();
})();
