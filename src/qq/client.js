/**
 * QQ 通道：客户端（官方 Bot API，WebSocket 长连接）
 *
 * 协议流程：
 *   1. POST https://bots.qq.com/app/getAppAccessToken  {appId, clientSecret}
 *      → { access_token, expires_in }（默认 7200 秒）
 *   2. GET  https://api.sgroup.qq.com/gateway  (Authorization: QQBot <token>)
 *      → { url }  WebSocket 网关地址
 *   3. WS 连接 → 收 op=10 HELLO（含 heartbeat_interval）→ 发 op=2 Identify
 *      → 收 op=0 DISPATCH，t=READY 表示连接成功
 *   4. 定时发 op=1 Heartbeat，收 op=11 HEARTBEAT_ACK
 *   5. 消息事件：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群@）
 *
 * 发送消息：
 *   被动回复（60 秒内有效，不限量）：带 msg_id + msg_seq
 *     POST /v2/users/{openid}/messages      （单聊）
 *     POST /v2/groups/{group_openid}/messages（群）
 *   主动推送：每月每用户上限 4 条，不带 msg_id
 *
 * 依赖：ws（Electron 33 基于 Node 20，无全局 WebSocket）
 */
const WebSocket = require('ws');
const { readConfig } = require('./config');

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** 订阅事件：群@消息 + C2C单聊 + 频道消息 */
const INTENTS = (1 << 25) | (1 << 30);

/** OpCode */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** 心跳 ACK 连续丢失多少次判定连接已死 */
const HEARTBEAT_ACK_TIMEOUT_FACTOR = 3;

/** 重连退避 */
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
/** 最大重连次数：超过后停止，等用户手动重连 */
const MAX_RECONNECT_ATTEMPTS = 20;

/** 消息去重窗口（毫秒）：只防止网络层的极短时间内重复推送，重连重发必须放行 */
const DEDUPE_TTL_MS = 10 * 1000;

let currentStatus = 'disconnected';
let statusDetail = '';
let callbacks = {};

/** 运行时状态 */
let accessToken = '';
let tokenExpiresAt = 0;
let ws = null;
let heartbeatTimer = null;
let lastHeartbeatAck = 0;
let heartbeatIntervalMs = 45000;
let sessionId = '';
let lastSeq = null;
let canResume = false;
let stopFlag = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

/** msg_id -> 消息来源，用于被动回复路由。5 分钟过期。 */
const msgSources = new Map();
/** msg_id -> 已用 msg_seq 计数 */
const msgSeqCounters = new Map();
/** 去重：已处理的 msg_id */
const seenMsgIds = new Map();

function setStatus(s, detail) {
  currentStatus = s;
  statusDetail = detail || '';
  try { if (callbacks.onStatusChange) callbacks.onStatusChange(s, statusDetail); } catch (_) {}
}

function getStatus() {
  return { status: currentStatus, detail: statusDetail };
}

function setCallbacks(cb) {
  callbacks = Object.assign({}, callbacks, cb || {});
}

// ================= Token 管理 =================

/**
 * 获取 access_token（带缓存与自动刷新）。
 * QQ 的 token 有效期 7200 秒，提前 60 秒刷新。
 */
async function getAccessToken(force) {
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) throw new Error('缺少 AppID / AppSecret');

  const now = Date.now();
  if (!force && accessToken && now < tokenExpiresAt) return accessToken;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('token 响应非 JSON (HTTP ' + res.status + '): ' + text.slice(0, 200));
    }
    // 凭证错误时 QQ 返回 HTTP 200 + 业务错误
    if (!data.access_token) {
      throw new Error('获取 token 失败: ' + (data.message || data.code || text.slice(0, 200)));
    }
    accessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 7200;
    tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
    console.log('[QQ] access_token 已刷新，有效期 ' + expiresIn + 's');
    return accessToken;
  } finally {
    clearTimeout(timer);
  }
}

/** 带鉴权的 API 请求头 */
async function authHeaders() {
  const token = await getAccessToken();
  return {
    'Authorization': 'QQBot ' + token,
    'Content-Type': 'application/json',
  };
}

/** 获取 WebSocket 网关地址（每次重连都要重新取） */
async function getGatewayUrl() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API_BASE + '/gateway', {
      headers: await authHeaders(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('获取网关失败 HTTP ' + res.status + ': ' + text.slice(0, 200));
    }
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('网关响应非 JSON: ' + text.slice(0, 200));
    }
    if (!data.url) throw new Error('网关响应缺少 url 字段');
    return data.url;
  } finally {
    clearTimeout(timer);
  }
}

// ================= WebSocket 连接 =================

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    console.error('[QQ] WS 发送失败:', err.message);
    return false;
  }
}

/** 发送 Identify（首次连接） */
async function sendIdentify() {
  try {
    const token = await getAccessToken();
    wsSend({
      op: OP_IDENTIFY,
      d: {
        token: 'QQBot ' + token,
        intents: INTENTS,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'lingya',
          $device: 'lingya',
        },
      },
    });
    console.log('[QQ] 已发送 Identify，intents=' + INTENTS);
  } catch (err) {
    console.error('[QQ] Identify 失败:', err.message);
    setStatus('error', '认证失败: ' + err.message);
  }
}

/** 发送 Resume（断线重连时续接会话） */
async function sendResume() {
  try {
    const token = await getAccessToken();
    wsSend({
      op: OP_RESUME,
      d: {
        token: 'QQBot ' + token,
        session_id: sessionId,
        seq: lastSeq,
      },
    });
    console.log('[QQ] 已发送 Resume，session=' + sessionId);
  } catch (err) {
    console.error('[QQ] Resume 失败:', err.message);
  }
}

/** 停心跳 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 启动心跳 */
function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatIntervalMs = intervalMs || 45000;
  lastHeartbeatAck = Date.now();
  const ackTimeout = heartbeatIntervalMs * HEARTBEAT_ACK_TIMEOUT_FACTOR;

  heartbeatTimer = setInterval(() => {
    // ACK 超时判定：连续多个周期没收到 ACK，说明连接已死
    if (Date.now() - lastHeartbeatAck > ackTimeout) {
      console.warn('[QQ] 心跳 ACK 超时，强制重连');
      try { ws && ws.close(); } catch (_) {}
      return;
    }
    wsSend({ op: OP_HEARTBEAT, d: lastSeq });
  }, heartbeatIntervalMs);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
  console.log('[QQ] 心跳已启动，间隔 ' + heartbeatIntervalMs + 'ms');
}

/** 清理去重缓存（超过 TTL 的删掉） */
function cleanupDedupe() {
  const now = Date.now();
  for (const [id, at] of seenMsgIds) {
    if (now - at > DEDUPE_TTL_MS) seenMsgIds.delete(id);
  }
  for (const [id, at] of msgSources) {
    if (now - at.at > DEDUPE_TTL_MS) msgSources.delete(id);
  }
}

/**
 * 处理 WS 消息。
 * 所有事件都走这里，按 op 分发。
 */
async function handleWsMessage(raw) {
  let data;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch (_) {
    return;
  }

  const op = data.op;
  const d = data.d;
  const t = data.t;
  const s = data.s;

  if (typeof s === 'number') lastSeq = s;

  if (op === OP_HELLO) {
    const interval = (d && d.heartbeat_interval) || 45000;
    heartbeatIntervalMs = interval;
    console.log('[QQ] 收到 HELLO，心跳间隔 ' + interval + 'ms');
    if (canResume && sessionId) {
      await sendResume();
    } else {
      await sendIdentify();
    }
    return;
  }

  if (op === OP_HEARTBEAT_ACK) {
    lastHeartbeatAck = Date.now();
    return;
  }

  if (op === OP_HEARTBEAT) {
    wsSend({ op: OP_HEARTBEAT, d: lastSeq });
    return;
  }

  if (op === OP_RECONNECT) {
    console.warn('[QQ] 服务端要求重连');
    try { ws && ws.close(); } catch (_) {}
    return;
  }

  if (op === OP_INVALID_SESSION) {
    console.warn('[QQ] 会话无效，重新 Identify');
    sessionId = '';
    canResume = false;
    await sendIdentify();
    return;
  }

  if (op !== OP_DISPATCH) return;

  // ---- DISPATCH 事件 ----
  if (t === 'READY') {
    sessionId = (d && d.session_id) || '';
    // 重连成功说明之前可能掉线了，清空去重缓存，允许腾讯重推掉线的消息
    seenMsgIds.clear();
    console.log('[QQ] 会话已就绪，已清空去重缓存');
    const botName = (d && d.user && d.user.username) || '';
    console.log('[QQ] ✅ 连接成功，bot=' + botName);
    canResume = false;
    reconnectAttempts = 0;
    setStatus('connected', botName ? 'bot: ' + botName : '已连接');
    startHeartbeat(heartbeatIntervalMs);
    return;
  }

  if (t === 'RESUMED') {
    console.log('[QQ] ✅ 会话已恢复');
    canResume = false;
    reconnectAttempts = 0;
    setStatus('connected');
    startHeartbeat(heartbeatIntervalMs);
    return;
  }

  if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE' ||
      t === 'AT_MESSAGE_CREATE' || t === 'DIRECT_MESSAGE_CREATE') {
    await handleMessageEvent(d, t);
    return;
  }
}

// ================= 消息事件处理 =================

/** 从事件里提取消息来源信息 */
function parseMessageEvent(d, eventType) {
  if (!d) return null;
  const msgId = d.id || '';
  if (!msgId) return null;

  // 去重
  if (seenMsgIds.has(msgId)) {
    console.log('[QQ] 重复消息，跳过:', msgId);
    return null;
  }
  seenMsgIds.set(msgId, Date.now());
  cleanupDedupe();

  const content = String(d.content || '').trim();
  const author = d.author || {};
  // QQ 附件：图片/视频/语音/文件都放在 attachments 数组里
  const attachments = Array.isArray(d.attachments) ? d.attachments : [];

  if (eventType === 'C2C_MESSAGE_CREATE') {
    const openid = author.user_openid || author.id || '';
    if (!openid) return null;
    return {
      msgId,
      eventType,
      kind: 'c2c',
      openid,
      content,
      attachments,
      replyUrl: API_BASE + '/v2/users/' + encodeURIComponent(openid) + '/messages',
    };
  }

  if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
    const groupOpenid = d.group_openid || '';
    if (!groupOpenid) return null;
    return {
      msgId,
      eventType,
      kind: 'group',
      openid: groupOpenid,
      senderOpenid: author.user_openid || author.id || '',
      content,
      attachments,
      replyUrl: API_BASE + '/v2/groups/' + encodeURIComponent(groupOpenid) + '/messages',
    };
  }

  // 频道消息暂不处理（需要额外权限）
  return null;
}

/** 处理一条消息事件 */
async function handleMessageEvent(d, eventType) {
  const info = parseMessageEvent(d, eventType);
  if (!info) return;

  // 记录来源，供后续回复路由（AI 回复时按这个找到目标）
  msgSources.set(info.msgId, {
    at: Date.now(),
    kind: info.kind,
    openid: info.openid,
    replyUrl: info.replyUrl,
  });

  // ---- 处理附件（图片/文件）----
  const notices = [];
  if (info.attachments.length > 0) {
    const qqMedia = require('./media');
    const inbox = require('../main/media/inbox');

    for (let i = 0; i < info.attachments.length; i++) {
      const att = info.attachments[i] || {};
      const ct = String(att.content_type || '').toLowerCase();
      // 只处理图片和普通文件；语音/视频暂跳过
      const isImage = ct.startsWith('image/');
      const isFile = ct === 'file' || (!isImage && !ct.startsWith('video/') && ct !== 'voice');
      if (!isImage && !isFile) {
        console.log('[QQ] 跳过不支持的附件类型:', ct || '(空)');
        continue;
      }
      const url = att.url || att.url_path || '';
      if (!url) continue;

      const kind = isImage ? 'image' : 'file';
      const rawName = att.filename || (kind + '-' + Date.now() + '-' + i + (isImage ? '.jpg' : '.bin'));

      try {
        // 传上限，让流式读取阶段就中断，而非先读进内存再拒绝
        const buf = await qqMedia.downloadAttachment(url, inbox.MAX_FILE_BYTES);
        const saved = inbox.save('qq', buf, rawName);
        if (!saved.success) {
          notices.push('【用户发来' + (kind === 'image' ? '图片' : '文件') + '，保存失败：' + saved.error + '】');
          continue;
        }
        const hint = kind === 'image' ? '可用 view_image 工具查看' : '可用 read 工具读取（文本）或 bash 处理';
        notices.push('【用户通过 QQ 发来' + (kind === 'image' ? '图片' : '文件') + '】本地路径：' + saved.path +
          '（' + (saved.size / 1024).toFixed(1) + ' KB）\n' + hint);
        console.log('[QQ] 收到附件 ' + kind + ', 已存 ' + saved.path);
      } catch (err) {
        console.error('[QQ] 附件下载失败:', err.message);
        notices.push('【用户发来' + (kind === 'image' ? '图片' : '文件') + '，下载失败：' + err.message + '】');
      }
    }
  }

  // 文本 + 附件提示合并转发
  const parts = [];
  if (info.content) parts.push(info.content);
  for (const n of notices) parts.push(n);
  const finalText = parts.join('\n\n');

  if (!finalText.trim()) {
    console.log('[QQ] 消息无文本也无可用附件，跳过');
    return;
  }

  console.log('[QQ] 收到消息 kind=' + info.kind + ' from=' + info.openid +
    ' 附件=' + info.attachments.length + ' 内容=' + JSON.stringify(finalText.slice(0, 60)));

  try {
    if (callbacks.onUserMessage) {
      callbacks.onUserMessage(finalText, info.openid, info.kind, info.msgId);
    }
  } catch (err) {
    console.error('[QQ] onUserMessage 回调异常:', err.message);
  }
}

// ================= 发送消息 =================

/** 取下一个 msg_seq（同一 msg_id 的多次回复需递增） */
function nextMsgSeq(msgId) {
  const cur = msgSeqCounters.get(msgId) || 1;
  msgSeqCounters.set(msgId, cur + 1);
  // 限制缓存大小
  if (msgSeqCounters.size > 500) {
    const first = msgSeqCounters.keys().next().value;
    msgSeqCounters.delete(first);
  }
  return cur;
}

/**
 * 被动回复：带 msg_id，60 秒内有效，不限量。
 * @param {string} msgId 触发回复的入站消息 id
 * @param {string} text 正文
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function replyText(msgId, text) {
  const src = msgSources.get(msgId);
  if (!src) {
    return { success: false, error: '找不到该消息的来源（可能已超过 5 分钟）' };
  }
  const body = String(text || '');
  if (!body.trim()) return { success: false, error: '内容为空' };

  // QQ 单条上限约 2000 字；同一 msg_id 最多被动回复 5 次（msg_seq 1~5）
  const CHUNK = 1800;
  const MAX_REPLIES = 5;
  const chunks = [];
  for (let i = 0; i < body.length; i += CHUNK) chunks.push(body.slice(i, i + CHUNK));

  // 超限截断：保留 5 段，最后一段加省略提示
  if (chunks.length > MAX_REPLIES) {
    console.warn('[QQ] 回复过长（' + chunks.length + ' 段），截断为 ' + MAX_REPLIES + ' 段');
    const kept = chunks.slice(0, MAX_REPLIES);
    kept[MAX_REPLIES - 1] = kept[MAX_REPLIES - 1].slice(0, CHUNK - 30) + '\n\n…（内容过长已截断，共 ' + body.length + ' 字）';
    chunks.length = 0;
    chunks.push.apply(chunks, kept);
  }

  for (const piece of chunks) {
    const payload = {
      content: piece,
      msg_type: 0,
      msg_id: msgId,
      msg_seq: nextMsgSeq(msgId),
    };
    try {
      const res = await fetch(src.replyUrl, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const t = await res.text();
        return { success: false, error: 'QQ 返回 ' + res.status + ': ' + t.slice(0, 200) };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: true };
}

/**
 * 主动推送：不带 msg_id。
 * ⚠️ QQ 限制：每个用户每月最多 4 条主动消息。超过会被拒绝。
 *
 * @param {string} openid 单聊用户 openid 或群 group_openid
 * @param {'c2c'|'group'} kind 类型
 * @param {string} text 正文
 */
async function activeSendText(openid, kind, text) {
  if (!openid) return { success: false, error: '缺少 openid' };
  const body = String(text || '');
  if (!body.trim()) return { success: false, error: '内容为空' };

  const url = kind === 'group'
    ? API_BASE + '/v2/groups/' + encodeURIComponent(openid) + '/messages'
    : API_BASE + '/v2/users/' + encodeURIComponent(openid) + '/messages';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ content: body, msg_type: 0 }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { success: false, error: 'QQ 返回 ' + res.status + ': ' + t.slice(0, 200) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================= 连接生命周期 =================

/** 调度重连（指数退避） */
function scheduleReconnect() {
  if (stopFlag) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error('[QQ] 重连次数已达上限（' + MAX_RECONNECT_ATTEMPTS + '），停止重连');
    setStatus('error', '重连失败 ' + MAX_RECONNECT_ATTEMPTS + ' 次，请检查网络后手动重连');
    stopFlag = true;
    return;
  }
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
  console.log('[QQ] ' + Math.round(delay / 1000) + 's 后重连（第 ' + reconnectAttempts + ' 次）');
  setStatus('connecting', '重连中（' + reconnectAttempts + '）');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!stopFlag) startConnection();
  }, delay);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

/** 建立一次 WS 连接 */
async function startConnection() {
  if (stopFlag) return;
  setStatus('connecting', '获取网关…');

  let url;
  try {
    url = await getGatewayUrl();
  } catch (err) {
    console.error('[QQ] 获取网关失败:', err.message);
    setStatus('error', err.message);
    scheduleReconnect();
    return;
  }

  if (stopFlag) return;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[QQ] 创建 WS 失败:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[QQ] WS 已连接，等待 HELLO');
    setStatus('connecting', '等待握手');
  });

  ws.on('message', (raw) => {
    handleWsMessage(raw).catch((err) => {
      console.error('[QQ] 消息处理异常:', err.message);
    });
  });

  ws.on('error', (err) => {
    console.error('[QQ] WS 错误:', err.message);
    setStatus('error', err.message);
  });

  ws.on('close', (code, reason) => {
    stopHeartbeat();
    if (stopFlag) {
      setStatus('disconnected');
      return;
    }
    const reasonStr = reason ? reason.toString() : '';
    console.warn('[QQ] WS 已关闭 code=' + code + (reasonStr ? ' reason=' + reasonStr : ''));

    // 4008/4009 可 resume，其余重新 identify
    if (code === 4008 || code === 4009) {
      canResume = true;
    } else if (code === 4004 || code === 4010 || code === 4011 || code === 4012 || code === 4013 || code === 4014) {
      // 认证失败类，不重连（避免死循环）
      console.error('[QQ] 认证/权限错误，停止重连（code=' + code + '）');
      setStatus('error', '认证失败或权限不足（code=' + code + '），请检查 AppID/Secret 与平台权限');
      stopFlag = true;
      return;
    } else {
      canResume = false;
      sessionId = '';
    }
    scheduleReconnect();
  });
}

/**
 * 启动连接（幂等）。
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function connect() {
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) {
    setStatus('error', '缺少 AppID / AppSecret');
    return { success: false, error: '缺少 AppID / AppSecret' };
  }

  // 先断开旧的
  disconnect(true);

  stopFlag = false;
  reconnectAttempts = 0;
  canResume = false;
  sessionId = '';
  lastSeq = null;

  // 先验一次 token，凭证错误立即返回（不用等 WS 阶段）
  try {
    await getAccessToken(true);
  } catch (err) {
    setStatus('error', err.message);
    return { success: false, error: err.message };
  }

  await startConnection();
  return { success: true };
}

/** 断开连接。@param {boolean} silent 不更新状态 */
function disconnect(silent) {
  stopFlag = true;
  stopHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  if (!silent) setStatus('disconnected');
}

/**
 * 供 IPC 调用：向指定用户/群发消息。
 * 优先走被动回复（用最近的 msgId），无可用 msgId 才走主动推送。
 *
 * @param {string} text 正文
 * @param {{kind?: 'c2c'|'group', openid?: string, msgId?: string}} options
 */
async function sendText(text, options) {
  const o = options || {};
  // 1) 有 msgId → 被动回复（推荐）
  if (o.msgId && msgSources.has(o.msgId)) {
    return await replyText(o.msgId, text);
  }
  // 2) 找该 openid 最近一条入站消息，用它回复
  if (o.openid) {
    let latest = null;
    for (const [msgId, src] of msgSources) {
      if (src.openid === o.openid && (!latest || src.at > latest.at)) {
        latest = { msgId, at: src.at };
      }
    }
    if (latest) {
      return await replyText(latest.msgId, text);
    }
  }
  // 3) 主动推送（每月 4 条限制）
  if (o.openid && o.kind) {
    console.warn('[QQ] 无可用 msgId，走主动推送（每月限 4 条）');
    return await activeSendText(o.openid, o.kind, text);
  }
  return { success: false, error: '没有可用的回复目标（需至少收到过一条消息）' };
}

/**
 * 供 media.js 使用的运行时上下文。
 * 暴露 token 获取与 msg_seq 分配，避免 media.js 重复实现。
 */
function getMediaContext() {
  return {
    getToken: () => getAccessToken(),
    nextMsgSeq: (msgId) => nextMsgSeq(msgId),
    getSource: (msgId) => msgSources.get(msgId) || null,
    /**
     * 取最近一条入站消息的来源。
     * QQ 发媒体必须被动回复（需 msg_id），而 send_media 工具拿不到 msg_id，
     * 所以由这里自动推断「最近跟谁在聊」，用它回复。
     */
    getRecentSource: () => {
      let latest = null;
      for (const src of msgSources.values()) {
        if (!latest || src.at > latest.at) latest = src;
      }
      return latest ? { msgId: latest.msgId, openid: latest.openid, kind: latest.kind } : null;
    },
  };
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  setCallbacks,
  sendText,
  replyText,
  activeSendText,
  getAccessToken,
  getMediaContext,
};
