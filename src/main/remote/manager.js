/**
 * 手机远程控制：粘合层
 *
 * 职责：
 *   1. 手机消息 → 目标窗口 AI 页面
 *   2. AI 页面事件 → 手机（流式/工具/停止/回复）
 *   3. 流式节流（30ms）+ reset 语义（前缀不匹配时发全文）
 *   4. 忙态双保险（本地乐观 + generation-state 心跳）
 *   5. 卡"生成中" watchdog（防终态丢失导致永久 busy）
 *   6. 新客户端连入补历史 + 活跃流
 *
 * 与 Cuckoo manager.ts 对齐，差异：
 *   - 无 harness/子代理 → 历史走 conversation-log（T4 接入），当前降级为空
 *   - 无 stopGeneration → 用 lingya-stop-task 通道（既有）
 */
const windowState = require('../window');
const generationState = require('../generation-state');
const profileManager = require('../profile-manager');
const { createConversationArchive } = require('../conversation-archive');

/** 历史补发：最近多少条（对齐 Cuckoo） */
const HISTORY_LIMIT = 40;
/** 带这些 tag 的条目视为系统消息（不当作正文展示） */
const SYSTEM_TAG_HINT = /^(拒绝|XML|脱敏|导入历史|附件|飞书|QQ|微信|手机)/;

const BUSY_TTL_MS = 10000;
const STREAM_THROTTLE_MS = 30;
const BUSY_WATCHDOG_MS = 3000;
const BUSY_STALE_MS = 8000;
const BUSY_TOOL_STALE_MS = 300000;

let remoteServer = null;
let started = false;
let busyWatchdogTimer = null;
let targetProfileId = '';

const busyMarks = new Map();
const streamStates = new Map();

function getStreamState(pid) {
  let s = streamStates.get(pid);
  if (!s) {
    s = { text: '', sent: '', think: '', thinkSent: '', timer: null, active: false, toolCount: 0, lastAt: 0, toolLastAt: 0 };
    streamStates.set(pid, s);
  }
  return s;
}

function markBusy(wcId) {
  if (wcId != null) busyMarks.set(wcId, Date.now());
}

function clearBusy(wcId) {
  if (wcId != null) busyMarks.delete(wcId);
}

function isBusy(wcId) {
  if (wcId == null) return false;
  const t = busyMarks.get(wcId);
  if (t != null) {
    if (Date.now() - t > BUSY_TTL_MS) busyMarks.delete(wcId);
    else return true;
  }
  try {
    const g = generationState.get(wcId);
    return !!(g && g.generating);
  } catch (_) { return false; }
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
    for (const c of ctxs) if (c.view && !c.view.webContents.isDestroyed()) return c;
    return null;
  }
  for (const c of ctxs) {
    if (String(c.profileId || '') === String(profileId) && c.view && !c.view.webContents.isDestroyed()) return c;
  }
  return null;
}

function getTargetContext() {
  if (targetProfileId) {
    const ctx = findContextByProfileId(targetProfileId);
    if (ctx) return ctx;
    targetProfileId = '';
    broadcastProfiles();
  }
  try {
    const c = windowState.getMainContext();
    if (c && c.view && !c.view.webContents.isDestroyed()) return c;
  } catch (_) {}
  let ctxs = [];
  try { ctxs = windowState.getAllContexts(); } catch (_) { return null; }
  for (const c of ctxs) if (c.view && !c.view.webContents.isDestroyed()) return c;
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

function broadcastProfiles() {
  try {
    broadcast({ type: 'profiles', profiles: listProfilesForRemote(), currentProfileId: targetProfileId || '' });
  } catch (_) {}
}

function flushStream(pid) {
  const s = streamStates.get(pid);
  if (!s) return;
  s.timer = null;
  if (!s.text && !s.think) return;
  const textOk = s.text.startsWith(s.sent);
  const thinkOk = s.think.startsWith(s.thinkSent);
  const reset = !textOk || !thinkOk;
  const textDelta = reset ? s.text : s.text.slice(s.sent.length);
  const thinkDelta = reset ? s.think : s.think.slice(s.thinkSent.length);
  s.sent = s.text;
  s.thinkSent = s.think;
  if (!textDelta && !thinkDelta && !reset) return;
  broadcast({ type: 'ai-stream', profileId: pid, thinkDelta, textDelta, reset });
}

function stopStreamForProfile(pid, reason) {
  const s = getStreamState(pid);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if ((s.text && s.text !== s.sent) || (s.think && s.think !== s.thinkSent)) flushStream(pid);
  s.text = ''; s.sent = ''; s.think = ''; s.thinkSent = '';
  s.active = false; s.toolCount = 0;
  broadcast({ type: 'ai-stop', profileId: pid, reason: reason || 'user' });
}

function broadcastAiEvent(webContentsId, kind, data) {
  const ctx = findContextByWcId(webContentsId);
  const pid = ctx ? String(ctx.profileId || '') : '';
  const p = data || {};

  if (kind === 'stream' || kind === 'delta') {
    const s = getStreamState(pid);
    if (!s.active) {
      s.active = true; s.sent = ''; s.think = ''; s.thinkSent = ''; s.toolCount = 0;
      broadcast({ type: 'ai-start', profileId: pid });
    }
    // 支持两种输入：p.full（全量快照，覆盖）/ p.text（增量，追加）
    if (typeof p.full === 'string') s.text = p.full;
    else if (typeof p.text === 'string') s.text = (s.text || '') + p.text;
    if (typeof p.think === 'string') s.think = p.think;
    s.lastAt = Date.now();
    if (!s.timer) s.timer = setTimeout(() => flushStream(pid), STREAM_THROTTLE_MS);
    return;
  }
  if (kind === 'ai-start') {
    markBusy(webContentsId);
    const s = getStreamState(pid);
    if (!s.active) {
      s.active = true; s.sent = ''; s.think = ''; s.thinkSent = ''; s.toolCount = 0;
      broadcast({ type: 'ai-start', profileId: pid });
    }
    return;
  }
  if (kind === 'tool-start' || kind === 'tool') {
    markBusy(webContentsId);
    const s = getStreamState(pid);
    s.toolCount++;
    s.toolLastAt = Date.now();
    broadcast({ type: 'tool', profileId: pid, name: p.name || '', at: Date.now() });
    return;
  }
  if (kind === 'tool-end') {
    const s = getStreamState(pid);
    if (s.toolCount > 0) s.toolCount--;
    s.toolLastAt = Date.now();
    broadcast({ type: 'tool', profileId: pid, name: p.name || '', ended: true });
    return;
  }
  if (kind === 'ai-reply' || kind === 'ai-response') {
    clearBusy(webContentsId);
    const s = getStreamState(pid);
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if ((s.text && s.text !== s.sent) || (s.think && s.think !== s.thinkSent)) flushStream(pid);
    s.text = ''; s.sent = ''; s.think = ''; s.thinkSent = '';
    s.active = false; s.toolCount = 0;
    broadcast({ type: 'ai-reply', profileId: pid, text: String(p.text || '') });
    return;
  }
  if (kind === 'ai-stop') {
    clearBusy(webContentsId);
    stopStreamForProfile(pid, 'user');
    return;
  }
  if (kind === 'error') {
    clearBusy(webContentsId);
    const s = getStreamState(pid);
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if ((s.text && s.text !== s.sent) || (s.think && s.think !== s.thinkSent)) flushStream(pid);
    s.text = ''; s.sent = ''; s.think = ''; s.thinkSent = '';
    s.active = false; s.toolCount = 0;
    broadcast({ type: 'ai-error', profileId: pid, text: String(p.text || '') });
    return;
  }
}

function onUserMessage(text, profileId) {
  const ctx = profileId ? findContextByProfileId(profileId) : getTargetContext();
  if (!ctx) {
    broadcast({ type: 'sys', text: '目标窗口不可用' });
    return;
  }
  const wcId = ctx.view.webContents.id;
  const pid = String(ctx.profileId || '');
  if (isBusy(wcId)) {
    broadcast({ type: 'sys', profileId: pid, keepBusy: true, text: 'AI 正在执行任务，请等本轮结束后再发消息' });
    return;
  }
  markBusy(wcId);
  try {
    ctx.view.webContents.send('remote-user-message', { text });
    broadcast({ type: 'sys', profileId: pid, text: '已发送' });
  } catch (err) {
    clearBusy(wcId);
    broadcast({ type: 'error', profileId: pid, text: '发送失败: ' + ((err && err.message) || '') });
  }
}

function onStop(profileId) {
  const ctx = profileId ? findContextByProfileId(profileId) : getTargetContext();
  if (!ctx) {
    broadcast({ type: 'sys', text: '目标窗口不可用' });
    return;
  }
  const pid = String(ctx.profileId || '');
  const wcId = ctx.view.webContents.id;
  try {
    ctx.view.webContents.send('lingya-stop-task', {});
    clearBusy(wcId);
    stopStreamForProfile(pid, 'user');
  } catch (_) {}
}

function onSelectProfile(profileId, ws) {
  targetProfileId = String(profileId || '');
  const list = listProfilesForRemote();
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'profiles', profiles: list, currentProfileId: targetProfileId })); } catch (_) {}
  }
}

function onNewClient(ws) {
  // 顺序关键：先历史，后活跃流（防历史到达时被"已有消息"判据拦下）
  pushHistoryToNewClient(ws).then(() => pushActiveStreamsToNewClient(ws), () => pushActiveStreamsToNewClient(ws));
}

/**
 * 读目标窗口当前会话的历史（供手机端补发）。
 * 数据源：<userDataDir>/conversations/<profileId>/<sessionId>.jsonl（conversation-archive）
 * 映射：{role:'user'|'assistant', text, tag} → {t:'user'|'assistant'|'system', text}
 * 任何异常（无 ctx / 无 sessionStore / 无 sessionId / 读盘失败）→ 返回空数组，不抛。
 * @param {object} ctx 目标窗口上下文（含 profileId / sessionStore）
 * @param {number} limit 最多返回条数（默认 HISTORY_LIMIT）
 * @returns {Array<{t:string, text:string}>}
 */
function readHistoryForContext(ctx, limit) {
  if (!ctx) return [];
  const max = Number(limit) > 0 ? Number(limit) : HISTORY_LIMIT;
  try {
    const pid = String(ctx.profileId || '');
    if (!pid) return [];
    let sid = '';
    try {
      if (ctx.sessionStore && ctx.sessionStore.state) {
        sid = String(ctx.sessionStore.state.currentSessionId || '');
      }
    } catch (_) {}
    if (!sid) return [];
    let userDataDir = '';
    try {
      const dd = require('../data-dir');
      if (dd && typeof dd.resolveDataDir === 'function') userDataDir = dd.resolveDataDir();
    } catch (_) {}
    if (!userDataDir) return [];
    const archive = createConversationArchive(pid, userDataDir);
    const r = archive.readEntries(sid);
    if (!r || !r.success || !Array.isArray(r.entries)) return [];
    const mapped = [];
    for (const e of r.entries) {
      if (!e || typeof e !== 'object') continue;
      const text = String(e.text || '').trim();
      if (!text) continue;
      const tag = String(e.tag || '');
      let t;
      if (e.role === 'user' || e.role === 'assistant') {
        if (tag && SYSTEM_TAG_HINT.test(tag)) t = 'system';
        else t = e.role;
      } else {
        t = 'system';
      }
      mapped.push({ t, text });
    }
    if (!mapped.length) return [];
    return mapped.length > max ? mapped.slice(-max) : mapped;
  } catch (_) {
    return [];
  }
}

function pushHistoryToNewClient(ws) {
  return new Promise((resolve) => {
    try {
      const ctx = getTargetContext();
      const pid = ctx ? String(ctx.profileId || '') : '';
      let history = [];
      try { history = readHistoryForContext(ctx); } catch (_) { history = []; }
      try { ws.send(JSON.stringify({ type: 'history', profileId: pid, history })); } catch (_) {}
      resolve();
    } catch (_) { resolve(); }
  });
}

function pushActiveStreamsToNewClient(ws) {
  if (!remoteServer) return;
  try {
    for (const [pid, s] of streamStates) {
      if (!s.active) continue;
      try {
        ws.send(JSON.stringify({ type: 'ai-stream', profileId: pid, thinkDelta: s.think, textDelta: s.text, reset: true }));
        s.sent = s.text;
        s.thinkSent = s.think;
      } catch (_) {}
    }
  } catch (_) {}
}

function busyWatchdogTick() {
  if (!remoteServer) return;
  const now = Date.now();
  for (const [pid, s] of streamStates) {
    if (!s.active) continue;
    const ctx = findContextByProfileId(pid);
    if (!ctx) continue;
    const wcId = ctx.view.webContents.id;
    if (isBusy(wcId)) {
      if (s.toolCount > 0 && now - s.toolLastAt >= BUSY_TOOL_STALE_MS) {
        console.log('[Remote] watchdog: tool-end 疑似丢失，强制收尾 ' + pid);
        clearBusy(wcId);
        stopStreamForProfile(pid, 'watchdog');
      }
      continue;
    }
    if (s.toolCount > 0) {
      if (now - s.toolLastAt < BUSY_TOOL_STALE_MS) continue;
      console.log('[Remote] watchdog: tool 阶段超时，强制收尾 ' + pid);
    } else {
      if (now - s.lastAt < BUSY_STALE_MS) continue;
      console.log('[Remote] watchdog: 已停止但未收尾，主动收尾 ' + pid);
    }
    clearBusy(wcId);
    stopStreamForProfile(pid, 'watchdog');
  }
}

function cleanupStreamState(profileId) {
  const s = streamStates.get(profileId);
  if (s && s.timer) clearTimeout(s.timer);
  streamStates.delete(profileId);
  const ctx = findContextByProfileId(profileId);
  if (ctx) clearBusy(ctx.view.webContents.id);
}

function initRemote(opts) {
  remoteServer = opts && opts.server ? opts.server : null;
  started = true;
  if (!busyWatchdogTimer) {
    busyWatchdogTimer = setInterval(busyWatchdogTick, BUSY_WATCHDOG_MS);
    if (busyWatchdogTimer.unref) busyWatchdogTimer.unref();
  }
}

function stopRemote() {
  started = false;
  if (busyWatchdogTimer) { clearInterval(busyWatchdogTimer); busyWatchdogTimer = null; }
  for (const s of streamStates.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  streamStates.clear();
  busyMarks.clear();
  remoteServer = null;
  targetProfileId = '';
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
  onNewClient,
  findContextByWcId,
  findContextByProfileId,
  markBusy,
  clearBusy,
  isBusy,
  cleanupStreamState,
  readHistoryForContext,
};
