/**
 * 手机远程控制：粘合层
 * 手机消息 <-> 目标窗口，AI 事件 -> 手机。
 */
const windowState = require('../window');
const generationState = require('../generation-state');
const profileManager = require('../profile-manager');
const BUSY_TTL_MS = 10000;
const STREAM_THROTTLE_MS = 30;

let remoteServer = null;
let started = false;
const busyMarks = new Map();
const streamBuf = new Map();
let streamTimer = null;
function markBusy(wcId) {
  if (wcId != null) busyMarks.set(wcId, Date.now());
}

function clearBusy(wcId) {
  if (wcId != null) busyMarks.delete(wcId);
}
function isBusy(wcId) {
  if (wcId == null) return false;
  const t = busyMarks.get(wcId);
  if (t == null) {
    try {
      const g = generationState.get(wcId);
      return !!(g && g.generating);
    } catch (_) { return false; }
  }
  if (Date.now() - t > BUSY_TTL_MS) {
    busyMarks.delete(wcId);
    return false;
  }
  return true;
}
function findContextByWcId(wcId) {
  if (wcId == null) return null;
  try {
    for (const c of windowState.getAllContexts()) {
      if (c.view && c.view.webContents && c.view.webContents.id === wcId) return c;
      if (c.win && c.win.webContents && c.win.webContents.id === wcId) return c;
    }
  } catch (_) {}
  return null;
}
function findContextByProfileId(profileId) {
  let ctxs = [];
  try { ctxs = windowState.getAllContexts(); } catch (_) { return null; }
  if (!profileId) {
    for (const c of ctxs) {
      if (c.view && !c.view.webContents.isDestroyed()) return c;
    }
    return null;
  }
  for (const c of ctxs) {
    if (String(c.profileId || '') === String(profileId) && c.view && !c.view.webContents.isDestroyed()) return c;
  }
  return null;
}
function listProfilesForRemote() {
  const out = [];
  let ctxs = [];
  try { ctxs = windowState.getAllContexts(); } catch (_) { return out; }
  for (const c of ctxs) {
    if (!c.view || c.view.webContents.isDestroyed()) continue;
    let name = '';
    try {
      const p = profileManager.getProfileById(c.profileId);
      if (p && p.name) name = p.name;
    } catch (_) {}
    out.push({ id: String(c.profileId || ''), name: name || ('窗口 ' + (out.length + 1)), busy: isBusy(c.view.webContents.id) });
  }
  return out;
}
function broadcast(msg) {
  if (!remoteServer) return;
  try { remoteServer.broadcast(msg); } catch (_) {}
}

function flushStream() {
  streamTimer = null;
  if (!streamBuf.size) return;
  const entries = Array.from(streamBuf.entries());
  streamBuf.clear();
  for (const [pid, text] of entries) broadcast({ type: 'stream', profileId: pid, text });
}
function broadcastAiEvent(webContentsId, kind, data) {
  const ctx = findContextByWcId(webContentsId);
  const profileId = ctx ? String(ctx.profileId || '') : '';
  const p = data || {};

  if (kind === 'stream' || kind === 'delta') {
    const prev = streamBuf.get(profileId) || '';
    streamBuf.set(profileId, prev + String(p.text || p.delta || ''));
    if (!streamTimer) streamTimer = setTimeout(flushStream, STREAM_THROTTLE_MS);
    return;
  }
  if (kind === 'ai-start') {
    markBusy(webContentsId);
    broadcast({ type: 'sys', profileId, text: 'AI 正在生成…' });
    return;
  }
  if (kind === 'tool-start' || kind === 'tool') {
    markBusy(webContentsId);
    broadcast({ type: 'tool', profileId, name: p.name || '', at: Date.now() });
    return;
  }
  if (kind === 'tool-end') {
    broadcast({ type: 'tool', profileId, name: p.name || '', ended: true });
    return;
  }
  if (kind === 'ai-reply' || kind === 'ai-response') {
    clearBusy(webContentsId);
    broadcast({ type: 'ai-reply', profileId, text: String(p.text || '') });
    return;
  }
  if (kind === 'error') {
    clearBusy(webContentsId);
    broadcast({ type: 'error', profileId, text: String(p.text || '') });
  }
}
function onUserMessage(text, profileId) {
  const ctx = findContextByProfileId(profileId);
  if (!ctx) {
    broadcast({ type: 'sys', text: '目标窗口不可用' });
    return;
  }
  const wcId = ctx.view.webContents.id;
  if (isBusy(wcId)) {
    broadcast({ type: 'sys', text: '目标窗口正在生成，请稍候' });
    return;
  }
  markBusy(wcId);
  try {
    ctx.view.webContents.send('qq-user-message', { text });
    broadcast({ type: 'sys', text: '已发送' });
  } catch (err) {
    clearBusy(wcId);
    broadcast({ type: 'error', text: '发送失败: ' + ((err && err.message) || '') });
  }
}
function onStop(profileId) {
  const ctx = findContextByProfileId(profileId);
  if (!ctx) {
    broadcast({ type: 'sys', text: '目标窗口不可用' });
    return;
  }
  try {
    ctx.view.webContents.send('lingya-stop-task', {});
    clearBusy(ctx.view.webContents.id);
  } catch (_) {}
}
function onSelectProfile(profileId, ws) {
  const list = listProfilesForRemote();
  const target = list.find((p) => p.id === String(profileId || ''));
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'profiles', profiles: list, current: target ? target.id : '' })); } catch (_) {}
  }
}
function initRemote(opts) {
  remoteServer = opts && opts.server ? opts.server : null;
  started = true;
}

function stopRemote() {
  started = false;
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  streamBuf.clear();
  busyMarks.clear();
  remoteServer = null;
}

function isStarted() { return started; }
module.exports = {
  initRemote,
  stopRemote,
  isStarted,
  broadcastAiEvent,
  listProfilesForRemote,
  onUserMessage,
  onStop,
  onSelectProfile,
  findContextByWcId,
  findContextByProfileId,
  markBusy,
  clearBusy,
  isBusy,
};
