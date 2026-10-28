/**
 * 微信 iLink 通道：客户端（扫码登录 + HTTP 长轮询 + 发消息）
 *
 * 协议：腾讯官方 iLink Bot API（微信 ClawBot 功能）
 *   BASE: https://ilinkai.weixin.qq.com
 *   CDN:  https://novac2c.cdn.weixin.qq.com/c2c
 *
 * 流程：
 *   1. GET  /ilink/bot/get_bot_qrcode?bot_type=3      拿二维码
 *   2. GET  /ilink/bot/get_qrcode_status?qrcode=xxx   轮询扫码状态
 *   3. POST /ilink/bot/getupdates                     长轮询收消息（挂起 ~35s）
 *   4. POST /ilink/bot/sendmessage                    发消息
 *
 * 关键概念 context_token：
 *   每条入站消息带 context_token，出站 sendmessage 必须原样回传，
 *   否则消息路由不到正确会话。按 from_user_id 缓存最新 token。
 *
 * 会话过期：任何 API 返回 errcode -14 → 需要重新扫码。
 *
 * 纯 Node 模块，不依赖 electron。
 */
const { readConfig, writeConfig } = require('./config');

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '2.0.0';

/** 长轮询单次请求超时（服务端挂起 ~35s，留余量） */
const POLL_TIMEOUT_MS = 50000;
/** 会话过期错误码 */
const ERR_SESSION_EXPIRED = -14;
/** 连续失败阈值：超过则进入退避 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 退避时长 */
const BACKOFF_DELAY_MS = 30000;

let currentStatus = 'disconnected';
let statusDetail = '';
let callbacks = {};

/** 运行态 */
let stopFlag = false;
let pollLoopPromise = null;
let getUpdatesBuf = '';
/** from_user_id -> 最新 context_token */
const contextTokens = new Map();

function setStatus(s, detail) {
  currentStatus = s;
  statusDetail = detail || '';
  try { if (callbacks.onStatusChange) callbacks.onStatusChange(s, statusDetail); } catch (_) {}
}

function getStatus() {
  return { status: currentStatus, detail: statusDetail };
}

/** iLink 特殊请求头 X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64 */
function makeWechatUin() {
  const n = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
  return Buffer.from(String(n), 'utf-8').toString('base64');
}

function getBaseUrl() {
  const cfg = readConfig();
  return (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

/** 构造通用请求头（token 可空） */
function buildHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': makeWechatUin(),
  };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/** 当前进行中的请求控制器，供 stopPolling 强制中断 */
let currentAbortCtrl = null;

/** 带超时的 fetch JSON */
async function fetchJson(url, options, timeoutMs) {
  const ctrl = new AbortController();
  currentAbortCtrl = ctrl;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('响应非 JSON（HTTP ' + res.status + '）: ' + text.slice(0, 200));
    }
    return data;
  } finally {
    clearTimeout(timer);
    if (currentAbortCtrl === ctrl) currentAbortCtrl = null;
  }
}

/** POST 业务请求（自动带 base_info 与 token） */
async function apiPost(pathName, body, token) {
  const url = getBaseUrl() + pathName;
  const payload = Object.assign({ base_info: { channel_version: CHANNEL_VERSION } }, body || {});
  return fetchJson(url, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
  }, POLL_TIMEOUT_MS);
}

/** GET 请求 */
async function apiGet(pathName, timeoutMs) {
  const url = getBaseUrl() + pathName;
  return fetchJson(url, {
    method: 'GET',
    headers: buildHeaders(''),
  }, timeoutMs || 30000);
}

// ================= 扫码登录 =================

/**
 * 获取登录二维码。
 * @returns {Promise<{success: boolean, qrcode?: string, qrcodeUrl?: string, error?: string}>}
 */
async function getLoginQrcode() {
  try {
    const data = await apiGet('/ilink/bot/get_bot_qrcode?bot_type=3', 30000);
    if (!data || data.ret !== 0) {
      return { success: false, error: (data && data.errmsg) || '获取二维码失败' };
    }

    const qrcode = data.qrcode || '';
    const rawUrl = data.qrcode_img_content || data.qrcode_url || '';

    // 腾讯的 qrcode_img_content 直接就是扫码链接（如 https://liteapp.weixin.qq.com/...），
    // 直接用这个内容生成二维码。
    // 兼容极少数返回 api.qrserver.com 代理图的老版本情况。
    let scanContent = '';
    if (rawUrl) {
      const m = rawUrl.match(/[?&]data=([^&]+)/);
      if (rawUrl.includes('qrserver.com') && m) {
        try { scanContent = decodeURIComponent(m[1]); } catch (_) { scanContent = m[1]; }
      } else {
        scanContent = rawUrl;
      }
    }
    if (!scanContent && qrcode) {
      scanContent = 'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
    }

    // 本地生成 DataURL（断网也能显示）
    let dataUrl = '';
    if (scanContent) {
      try {
        const QRCode = require('qrcode');
        dataUrl = await QRCode.toDataURL(scanContent, { margin: 1, width: 320 });
      } catch (err) {
        console.warn('[Weixin] 本地生成二维码失败，回退原 URL:', err.message);
      }
    }

    return {
      success: true,
      qrcode,
      qrcodeUrl: dataUrl || rawUrl,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 查询扫码状态（单次）。
 * @param {string} qrcode 二维码 token
 * @returns {Promise<{status: string, credentials?: object, baseUrl?: string}>}
 *   status: wait | scaned | confirmed | expired
 */
async function checkQrcodeStatus(qrcode) {
  try {
    const data = await apiGet('/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), 40000);
    console.log('[Weixin] 轮询状态:', JSON.stringify(data));
    if (!data || data.ret !== 0) {
      return { status: 'error', error: (data && data.errmsg) || '查询失败' };
    }
    const out = { status: data.status || 'wait' };
    if (data.status === 'confirmed') {
      // 腾讯接口真实返回的 bot_token 是平铺在最外层的，兼容一下嵌套结构
      const bToken = data.bot_token || (data.credentials && data.credentials.bot_token);
      const bId = data.ilink_bot_id || (data.credentials && data.credentials.ilink_bot_id);
      const uId = data.ilink_user_id || (data.credentials && data.credentials.ilink_user_id);
      
      if (bToken) {
        out.credentials = {
          botToken: bToken,
          botId: bId || '',
          userId: uId || '',
        };
      }
      if (data.baseurl) out.baseUrl = data.baseurl;
    }
    return out;
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * 完整扫码登录：拿二维码 → 阻塞轮询直到 confirmed / expired / 超时。
 * @param {(info: object) => void} onQrcode 二维码就绪回调，参数 { qrcode, qrcodeUrl }
 * @param {number} timeoutMs 总超时
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function loginWithQr(onQrcode, timeoutMs) {
  const total = timeoutMs || 480000;
  const start = Date.now();

  const qr = await getLoginQrcode();
  if (!qr.success) {
    setStatus('error', qr.error);
    return { success: false, error: qr.error };
  }
  setStatus('connecting', '等待扫码');
  try { if (onQrcode) onQrcode({ qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl }); } catch (_) {}

  let lastStatus = '';
  while (Date.now() - start < total) {
    if (stopFlag) return { success: false, error: '已取消' };
    const st = await checkQrcodeStatus(qr.qrcode);

    if (st.status === 'confirmed' && st.credentials && st.credentials.botToken) {
      // 持久化凭证
      writeConfig({
        botToken: st.credentials.botToken,
        botId: st.credentials.botId,
        userId: st.credentials.userId,
        ...(st.baseUrl ? { baseUrl: st.baseUrl } : {}),
      });
      setStatus('connected', '已登录');
      console.log('[Weixin] 扫码登录成功 botId=' + st.credentials.botId);
      return { success: true };
    }

    if (st.status === 'expired') {
      setStatus('error', '二维码已过期');
      return { success: false, error: '二维码已过期，请重新获取' };
    }

    if (st.status !== lastStatus) {
      lastStatus = st.status;
      if (st.status === 'scaned') setStatus('connecting', '已扫码，等待手机确认');
      console.log('[Weixin] 扫码状态:', st.status);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  setStatus('error', '扫码超时');
  return { success: false, error: '扫码超时' };
}

/**
 * 退出登录：清除本地 token。
 */
function logout() {
  stopPolling();
  writeConfig({ botToken: '', botId: '', userId: '' });
  setStatus('disconnected');
  console.log('[Weixin] 已退出登录');
  return { success: true };
}

// ================= 消息收发 =================

/** 从 iLink 消息对象里提取纯文本（只处理文本类型） */
function extractText(msg) {
  try {
    const items = msg && msg.item_list;
    if (!Array.isArray(items) || items.length === 0) return '';
    for (const it of items) {
      if (it && it.type === 1 && it.text_item && typeof it.text_item.text === 'string') {
        return it.text_item.text.trim();
      }
    }
    return '';
  } catch (_) {
    return '';
  }
}

/**
 * 从 iLink 消息里提取媒体信息。
 * item 类型：2=图片 4=文件
 * @returns {{kind:'image'|'file', encryptQueryParam:string, aesKey:string, fileName:string}|null}
 */
function extractMediaInfo(msg) {
  try {
    const items = msg && msg.item_list;
    if (!Array.isArray(items) || items.length === 0) return null;
    for (const it of items) {
      if (!it) continue;
      if (it.type === 2 && it.image_item) {
        const media = it.image_item.media || {};
        if (!media.encrypt_query_param) continue;
        return {
          kind: 'image',
          encryptQueryParam: media.encrypt_query_param,
          aesKey: media.aes_key || '',
          fileName: 'image-' + Date.now() + '.jpg',
        };
      }
      if (it.type === 4 && it.file_item) {
        const media = it.file_item.media || {};
        if (!media.encrypt_query_param) continue;
        return {
          kind: 'file',
          encryptQueryParam: media.encrypt_query_param,
          aesKey: media.aes_key || '',
          fileName: it.file_item.file_name || ('file-' + Date.now() + '.bin'),
        };
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** 暴露运行时上下文给 media.js（baseUrl / token / contextToken / 默认 userId） */
function getMediaContext() {
  const cfg = readConfig();
  return {
    baseUrl: getBaseUrl(),
    token: cfg.botToken,
    defaultUserId: cfg.userId,
    getContextToken: (uid) => contextTokens.get(String(uid)) || '',
  };
}

/** 记录某用户的 context_token（每条入站消息都更新） */
function rememberContext(msg) {
  try {
    const from = msg && msg.from_user_id;
    const token = msg && msg.context_token;
    if (from && token) contextTokens.set(String(from), String(token));
  } catch (_) {}
}

/**
 * 长轮询主循环。收到消息后回调 onUserMessage(text, fromUserId)。
 * 会话过期（-14）时自动停止并置状态，等待用户重新扫码。
 */
async function pollLoop() {
  let consecutiveFailures = 0;
  setStatus('connected', '长轮询中');
  console.log('[Weixin] 长轮询已启动');

  while (!stopFlag) {
    const cfg = readConfig();
    const token = cfg.botToken;
    if (!token) {
      setStatus('error', '缺少 bot_token，请重新扫码登录');
      break;
    }

    try {
      const data = await apiPost('/ilink/bot/getupdates', {
        get_updates_buf: getUpdatesBuf,
      }, token);

      // 会话过期
      if (data && (data.ret === ERR_SESSION_EXPIRED || data.errcode === ERR_SESSION_EXPIRED)) {
        console.warn('[Weixin] 会话已过期（errcode -14），需要重新扫码');
        setStatus('error', '会话已过期，请重新扫码登录');
        writeConfig({ botToken: '' });
        break;
      }

      if (!data) {
        consecutiveFailures++;
        console.warn('[Weixin] getupdates 无响应 (' + consecutiveFailures + ')');
        // ... 原有失败处理逻辑
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn('[Weixin] 连续失败达阈值，退避 ' + (BACKOFF_DELAY_MS / 1000) + 's');
          setStatus('connecting', '网络异常，退避重试中');
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
          consecutiveFailures = 0;
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
        continue;
      }
      if (data.ret !== undefined && data.ret !== 0) {
        consecutiveFailures++;
        const msg = data.errmsg || '未知错误';
        console.warn('[Weixin] getupdates 失败 (' + consecutiveFailures + '): ' + msg + ' 完整响应: ' + JSON.stringify(data));
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn('[Weixin] 连续失败达阈值，退避 ' + (BACKOFF_DELAY_MS / 1000) + 's');
          setStatus('connecting', '网络异常，退避重试中');
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
          consecutiveFailures = 0;
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
        continue;
      }

      consecutiveFailures = 0;
      if (data.get_updates_buf) getUpdatesBuf = data.get_updates_buf;

      const msgs = Array.isArray(data.msgs) ? data.msgs : [];
      for (const msg of msgs) {
        if (stopFlag) break;
        // message_type: 1 = 用户发来的消息（2 = 机器人自己发的，跳过）
        if (!msg || msg.message_type !== 1) continue;
        rememberContext(msg);
        const from = msg.from_user_id ? String(msg.from_user_id) : '';

        // 媒体消息（图片/文件）：下载解密 → 落盘 → 把本地路径告知 AI
        const mediaInfo = extractMediaInfo(msg);
        if (mediaInfo) {
          try {
            const wmedia = require('./media');
            const buf = await wmedia.downloadMedia(mediaInfo.encryptQueryParam, mediaInfo.aesKey);
            const inbox = require('../main/media/inbox');
            const saved = inbox.save('weixin', buf, mediaInfo.fileName);
            if (!saved.success) {
              console.warn('[Weixin] 媒体落盘失败:', saved.error);
              try { if (callbacks.onUserMessage) callbacks.onUserMessage('【收到' + (mediaInfo.kind === 'image' ? '图片' : '文件') + '，但保存失败：' + saved.error + '】', from); } catch (_) {}
              continue;
            }
            const label = mediaInfo.kind === 'image' ? '图片' : '文件';
            const hint = mediaInfo.kind === 'image'
              ? '可用 view_image 工具查看'
              : '可用 read 工具读取（文本）或 bash 处理';
            const notice = '【用户通过微信发来' + label + '】本地路径：' + saved.path + '（' + (saved.size / 1024).toFixed(1) + ' KB）\n' + hint;
            console.log('[Weixin] 收到媒体 ' + mediaInfo.kind + ', 已存 ' + saved.path);
            try { if (callbacks.onUserMessage) callbacks.onUserMessage(notice, from); } catch (_) {}
          } catch (err) {
            console.error('[Weixin] 媒体下载失败:', err.message);
            try { if (callbacks.onUserMessage) callbacks.onUserMessage('【用户发来' + (mediaInfo.kind === 'image' ? '图片' : '文件') + '，但下载失败：' + err.message + '】', from); } catch (_) {}
          }
          continue;
        }

        const text = extractText(msg);
        if (!text) {
          console.log('[Weixin] 收到无法识别的消息 item，跳过');
          continue;
        }
        console.log('[Weixin] 收到消息 from=' + from + ' 内容=' + JSON.stringify(text.slice(0, 60)));
        try {
          if (callbacks.onUserMessage) callbacks.onUserMessage(text, from);
        } catch (err) {
          console.error('[Weixin] 回调 onUserMessage 异常:', err.message);
        }
      }
    } catch (err) {
      if (stopFlag) break;
      // AbortError 是正常的长轮询超时，不算失败
      if (err && err.name === 'AbortError') {
        continue;
      }
      consecutiveFailures++;
      console.warn('[Weixin] 轮询异常 (' + consecutiveFailures + '): ' + err.message);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        setStatus('connecting', '网络异常，退避重试中');
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        consecutiveFailures = 0;
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  console.log('[Weixin] 长轮询已结束');
  if (!stopFlag && currentStatus !== 'error') setStatus('disconnected');
}

/** 启动长轮询（幂等：先停旧的）。force=true 时打断旧循环重开 */
function startPolling(force) {
  if (pollLoopPromise) {
    if (!force) return { success: true, message: '已在运行' };
    stopPolling();
    pollLoopPromise = null;
  }
  const cfg = readConfig();
  if (!cfg.botToken) {
    setStatus('error', '缺少 bot_token，请先扫码登录');
    return { success: false, error: '缺少 bot_token，请先扫码登录' };
  }
  stopFlag = false;
  getUpdatesBuf = '';
  pollLoopPromise = pollLoop().catch((err) => {
    console.error('[Weixin] 轮询循环异常退出:', err.message);
    setStatus('error', err.message);
  }).finally(() => {
    pollLoopPromise = null;
  });
  return { success: true };
}

/** 停止长轮询 */
function stopPolling() {
  stopFlag = true;
  // 主动中断进行中的请求，避免死等 50s 超时
  if (currentAbortCtrl) {
    try { currentAbortCtrl.abort(); } catch (_) {}
    currentAbortCtrl = null;
  }
  if (currentStatus === 'connected') setStatus('disconnected');
}

/**
 * 发送文本消息。
 * @param {string} text 正文
 * @param {string} toUserId 目标用户 id（回复入站消息时用 msg.from_user_id）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendText(text, toUserId) {
  const cfg = readConfig();
  if (!cfg.botToken) return { success: false, error: '未登录（缺少 bot_token）' };
  const body = String(text == null ? '' : text);
  if (!body.trim()) return { success: false, error: '消息内容为空' };

  const target = toUserId || cfg.userId;
  if (!target) return { success: false, error: '缺少接收方 id' };

  const ctxToken = contextTokens.get(String(target));
  if (!ctxToken) {
    return { success: false, error: '缺少 context_token（该用户未发过消息，无法主动推送）' };
  }

  // iLink 单条文本有长度限制，超长分片
  const CHUNK = 4000;
  const chunks = [];
  for (let i = 0; i < body.length; i += CHUNK) chunks.push(body.slice(i, i + CHUNK));

  for (const piece of chunks) {
    try {
      const data = await apiPost('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: String(target),
          client_id: require('crypto').randomBytes(8).toString('hex'),
          message_type: 2,
          message_state: 2,
          context_token: ctxToken,
          item_list: [{ type: 1, text_item: { text: piece } }],
        },
      }, cfg.botToken);

      console.log('[Weixin] sendmessage 响应:', JSON.stringify(data));
      if (data && (data.ret === ERR_SESSION_EXPIRED || data.errcode === ERR_SESSION_EXPIRED)) {
        setStatus('error', '会话已过期，请重新扫码登录');
        writeConfig({ botToken: '' });
        return { success: false, error: '会话已过期' };
      }
      // 腾讯接口成功时不返回 ret 字段，不能简单用 !== 0 判断
      if (!data || (data.ret !== undefined && data.ret !== 0)) {
        return { success: false, error: (data && data.errmsg) || '发送失败' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: true };
}

/** 设置回调 */
function setCallbacks(cb) {
  callbacks = Object.assign({}, callbacks, cb || {});
}

module.exports = {
  getStatus,
  getMediaContext,
  setCallbacks,
  getLoginQrcode,
  checkQrcodeStatus,
  loginWithQr,
  logout,
  startPolling,
  stopPolling,
  sendText,
};
