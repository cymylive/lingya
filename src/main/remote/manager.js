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

function sendFileToPhone(filePath) {
  if (!remoteServer) return { ok: false, error: '远程服务未启动' };
  try {
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    broadcast({ 
      type: 'file-download', 
      filePath: filePath, 
      fileName: fileName, 
      size: stat.size 
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

function broadcastTodoUpdate(profileId, todos) {
  if (!remoteServer) return;
  broadcast({ type: 'todo-update', profileId: profileId, todos: todos || [] });
}

function broadcastTokenUsage(profileId, payload) {
  if (!remoteServer) return;
  const p = payload || {};
  // 灵鸦传来的 payload 包含 { context, cumulative, windowCumulative, todayCumulative, daily }
  broadcast({ 
    type: 'token-usage', 
    profileId: profileId, 
    context: p.context || 0,
    cumulative: p.cumulative || 0
  });
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
  if (kind === 'task-state') {
    const s = getStreamState(pid);
    if (p.visible) {
      markBusy(webContentsId);
      if (!s.active) {
        s.active = true; s.sent = ''; s.think = ''; s.thinkSent = ''; s.toolCount = 0;
        broadcast({ type: 'ai-start', profileId: pid });
      }
      
      // ui.js 里：kind = 'executing' 代表工具，'busy' 代表思考/生成
      if (p.kind === 'executing') {
        s.toolCount = 1; // 保持工具状态
        s.toolLastAt = Date.now();
        broadcast({ type: 'tool', profileId: pid, name: p.text || '执行中', at: Date.now() });
      } else if (p.kind === 'busy') {
        s.toolCount = 0;
        broadcast({ type: 'task-state', profileId: pid, text: p.text || 'AI 正在思考…' });
      }
    } else {
      clearBusy(webContentsId);
      if (s.active) {
        s.active = false;
        s.toolCount = 0;
        broadcast({ type: 'ai-stop', profileId: pid, reason: 'user' });
      }
    }
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
    // 切换窗口后，自动拉取该窗口历史
    pushHistoryToNewClient(ws).catch(() => {});
  }
}

function refreshHistory(ws) {
  if (!ws || ws.readyState !== 1) return;
  pushHistoryToNewClient(ws).catch(() => {});
}

function onNewClient(ws) {
  // 1. 新客户端连上，立刻把当前电脑上打开的窗口列表推给它
  try {
    const list = listProfilesForRemote();
    ws.send(JSON.stringify({ type: 'profiles', profiles: list, currentProfileId: targetProfileId || '' }));
  } catch (_) {}

  // 2. 顺序关键：先历史，后活跃流（防历史到达时被"已有消息"判据拦下）
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
    // 方案一：直接从当前网页的 URL 中提取 sessionId（最准确）
    try {
      const url = ctx.view && ctx.view.webContents ? ctx.view.webContents.getURL() : '';
      if (url) {
        const { getProviderByUrl } = require('../../providers');
        const p = getProviderByUrl(url);
        if (p && typeof p.extractSessionId === 'function') {
          sid = p.extractSessionId(url) || '';
        }
      }
    } catch (_) {}

    // 方案二：如果 URL 没提取到，尝试从 sessionStore 获取（兜底）
    if (!sid && ctx.sessionStore && ctx.sessionStore.state) {
      sid = String(ctx.sessionStore.state.currentSessionId || '');
    }
    
    if (!sid) {
      console.log('[Remote] readHistoryForContext: 没有找到当前 sessionId');
      return [];
    }
    
    let userDataDir = '';
    try {
      // 最稳妥的方式是直接通过 Electron 拿到当前实例的 userData 路径
      const { app } = require('electron');
      userDataDir = app ? app.getPath('userData') : '';
    } catch (_) {}
    
    if (!userDataDir) {
      console.log('[Remote] readHistoryForContext: 没有找到 userData 路径');
      return [];
    }
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

function getSessionsForContext(ctx) {
  if (!ctx) return { sessions: [], archivedProjects: [] };
  try {
    const { app } = require('electron');
    const { aggregateWorkspaces } = require('../workspace-aggregator');
    const profileManager = require('../profile-manager');
    const profiles = profileManager.readProfiles();
    const agg = aggregateWorkspaces(app.getPath('userData'), ctx.profileId, profiles);
    return {
      sessions: agg.sessions || [],
      archivedProjects: agg.archivedProjects || []
    };
  } catch (e) {
    console.error('[Remote] getSessionsForContext error:', e);
    return { sessions: [], archivedProjects: [] };
  }
} catch (e) {
    console.error('[Remote] getSessionsForContext error:', e);
    return [];
  }
}

function onActionInitProject(profileId, projectName) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx) return { success: false, error: '目标窗口不存在' };
  
  const path = require('path');
  const fs = require('fs');
  const { app } = require('electron');
  
  // 安全过滤：去掉非法字符
  const safeName = String(projectName).replace(/[<>:"/\\|?*]/g, '');
  if (!safeName) return { success: false, error: '项目名包含非法字符' };
  
  // 默认建在电脑桌面
  const targetDir = path.join(app.getPath('desktop'), safeName);
  
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  } catch (err) {
    return { success: false, error: '创建文件夹失败: ' + err.message };
  }
  
  const wc = ctx.view.webContents;
  if (!wc || wc.isDestroyed()) return { success: false, error: 'AI 视图不可用' };

  let homeUrl = null;
  try { 
    const { getProviderByUrl } = require('../../providers'); 
    const p = getProviderByUrl(wc.getURL()); 
    if (p && p.homeUrl) homeUrl = p.homeUrl; 
  } catch (_) {}

  const doInit = () => {
    try {
      const { initProject } = require('../project-context');
      // skipPrompt: false 意味着它会正常发送初始提示词
      initProject(false, ctx, targetDir, false).catch((e) => {
        console.error('[Remote] initProject failed:', e);
      });
    } catch (err) {
      console.error('[Remote] require initProject failed:', err);
    }
  };

  // 核心修复：先跳回首页新建会话，等页面加载完后再绑定项目
  if (homeUrl) {
    wc.once('did-finish-load', () => {
      // 延时 3s 等前端框架完全就绪，降低输入框未挂载导致的失败率
      setTimeout(doInit, 3000);
    });
    wc.loadURL(homeUrl).catch(() => {});
  } else {
    // 找不到首页 URL 时的兜底
    doInit();
  }

  return { success: true, dir: targetDir };
}

function onActionRename(profileId, sessionId, title) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx || !ctx.sessionStore) return;
  try {
    if (typeof ctx.sessionStore.setSessionTitleById === 'function') {
      ctx.sessionStore.setSessionTitleById(sessionId, title);
    }
  } catch (_) {}
}

function onActionImport(profileId, sourceSessionId, targetSessionId) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx) return;
  
  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  
  const archivePath = path.join(app.getPath('userData'), 'conversations', String(ctx.profileId), String(sourceSessionId).replace(/[^a-zA-Z0-9_.-]/g, '_') + '.jsonl');
  
  try {
    if (!fs.existsSync(archivePath)) return { success: false, error: '找不到源历史记录' };
    const lines = fs.readFileSync(archivePath, 'utf-8').split('\n');
    let text = '以下是历史对话上下文：\n\n';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.role === 'user') text += '[用户] ' + obj.text + '\n';
        else if (obj.role === 'assistant') text += '[AI] ' + obj.text + '\n';
      } catch (_) {}
    }
    
    // 发送给当前 AI 页面
    const wc = ctx.view.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send('remote-user-message', { text: text });
      return { success: true };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function onActionNewChat(profileId) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx || !ctx.view) return;
  const wc = ctx.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  let homeUrl = null;
  try { 
    const { getProviderByUrl } = require('../../providers'); 
    const p = getProviderByUrl(wc.getURL()); 
    if (p && p.homeUrl) homeUrl = p.homeUrl; 
  } catch (_) {}
  if (homeUrl) wc.loadURL(homeUrl).catch(() => {});
}

function onActionArchiveSession(profileId, sessionId, archived) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (ctx && ctx.sessionStore && typeof ctx.sessionStore.setSessionArchived === 'function') {
    ctx.sessionStore.setSessionArchived(sessionId, archived);
  }
}

function onActionArchiveProject(profileId, projectDir, archived) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (ctx && ctx.sessionStore && typeof ctx.sessionStore.setProjectArchived === 'function') {
    ctx.sessionStore.setProjectArchived(projectDir, archived);
  }
}

function onActionDeleteSession(profileId, sessionId, ws) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx) return;

  try {
    // 1. 删电脑端会话记录
    if (ctx.sessionStore && typeof ctx.sessionStore.deleteSession === 'function') {
      ctx.sessionStore.deleteSession(sessionId);
    }

    // 2. 删本地存档文件
    try {
      const { app } = require('electron');
      const { createConversationArchive } = require('../conversation-archive');
      const archive = createConversationArchive(String(ctx.profileId || ''), app.getPath('userData'));
      archive.deleteArchive(sessionId);
    } catch (_) {}

    // 3. 如果删除的是当前正在进行的对话，让电脑端退回首页
    if (ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.currentSessionId === sessionId) {
      onActionNewChat(profileId);
    }

    // 4. 推送最新的会话列表给手机
    const list = getSessionsForContext(ctx);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'sessions-data', sessions: list }));
    }
    return { success: true };
  } catch (err) {
    console.error('[Remote] 删除会话失败:', err);
    return { success: false, error: err.message };
  }
}

function onActionSwitchSession(profileId, session) {
  const ctx = findContextByProfileId(profileId) || getTargetContext();
  if (!ctx || !ctx.view) return;
  const wc = ctx.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  
  let url = session.url;
  if (!url && session.sessionId) {
    try {
      const { getProviderByUrl } = require('../../providers');
      const p = getProviderByUrl(wc.getURL());
      if (p && p.sessionUrlBase) {
        url = p.sessionUrlBase + session.sessionId;
      }
    } catch (_) {}
  }
  
  if (url) {
    wc.loadURL(url).catch(() => {});
    // 切换后重新同步历史
    setTimeout(() => {
      // 给页面一点时间加载，然后前端去刷新
    }, 1000);
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
  refreshHistory,
  getSessionsForContext,
  onActionNewChat,
  onActionSwitchSession,
  onActionInitProject,
  onActionRename,
  onActionImport,
  onActionDeleteSession,
  onActionArchiveSession,
  onActionArchiveProject,
  sendFileToPhone,
  findContextByWcId,
  findContextByProfileId,
  markBusy,
  clearBusy,
  isBusy,
  cleanupStreamState,
  readHistoryForContext,
  broadcastTokenUsage,
  broadcastTodoUpdate,
};
