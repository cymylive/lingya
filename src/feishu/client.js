/**
 * 飞书同步：客户端（长连接 + 收发消息）
 *
 * 用飞书官方 SDK（@larksuiteoapi/node-sdk）：
 *  - WSClient：长连接接收事件（无需公网 IP）
 *  - Client：发消息
 *
 * 主进程内存态：连接实例 + 状态。配置变更时由外部调用 connect/disconnect。
 * 纯 Node 模块，不依赖 electron。
 *
 * 移植自 cuckoo-code src/feishu/client.ts（TS → CJS）。
 */
const { readConfig, writeConfig } = require('./config');
const fs2 = require('fs');
const path2 = require('path');

// SDK 是 CJS，惰性加载：未安装时不影响模块加载，仅在 connect 时报错
let lark = null;
try {
  lark = require('@larksuiteoapi/node-sdk');
} catch (err) {
  console.error('[Feishu] 加载 @larksuiteoapi/node-sdk 失败:', err.message);
}

/** 连接状态：disconnected | connecting | connected | error */
let currentStatus = 'disconnected';
let statusDetail = '';
let callbacks = {};

let wsClient = null;
let apiClient = null;

function setStatus(s, detail) {
  currentStatus = s;
  statusDetail = detail || '';
  try { if (callbacks.onStatusChange) callbacks.onStatusChange(s, statusDetail); } catch (_) {}
}

function getStatus() {
  return { status: currentStatus, detail: statusDetail };
}

/** 从消息事件中取 chat_id（群消息） */
function extractChatId(event) {
  try {
    const msg = event && event.message;
    if (!msg) return '';
    return typeof msg.chat_id === 'string' ? msg.chat_id : '';
  } catch (_) {
    return '';
  }
}

/** 从事件中取 chat_type：'p2p'（单聊）/ 'group'（群聊） */
function extractChatType(event) {
  try {
    const msg = event && event.message;
    if (!msg) return '';
    return typeof msg.chat_type === 'string' ? msg.chat_type : '';
  } catch (_) {
    return '';
  }
}

/** 剥离 @ 提及：群里 @ 机器人时文本含 @_user_N 占位或 @机器人名 */
function stripMentions(text, mentions) {
  let t = String(text || '');
  t = t.replace(/@_user_\d+/g, '');
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m && m.key) t = t.split(m.key).join('');
      if (m && m.name) t = t.split('@' + m.name).join('');
    }
  }
  return t.trim();
}

/** 从事件中提取纯文本（只处理文本消息），并剥离 @ 提及 */
function extractText(event) {
  try {
    const msg = event && event.message;
    if (!msg) return '';
    if (msg.message_type !== 'text') return '';
    const content = JSON.parse(msg.content || '{}');
    const raw = typeof content.text === 'string' ? content.text : '';
    const cleaned = stripMentions(raw, msg.mentions);
    if (cleaned !== raw) {
      console.log('[Feishu] 已剥离 @ 提及: ' + JSON.stringify(raw) + ' -> ' + JSON.stringify(cleaned));
    }
    return cleaned;
  } catch (_) {
    return '';
  }
}

/** 从事件里取 message_id（下载资源要用） */
function extractMessageId(event) {
  try {
    const msg = event && event.message;
    return msg && typeof msg.message_id === 'string' ? msg.message_id : '';
  } catch (_) {
    return '';
  }
}

/**
 * 从事件里提取媒体信息。
 * @returns {{kind:'image'|'file', fileKey:string, fileName:string, messageId:string}|null}
 */
function extractMediaInfo(event) {
  try {
    const msg = event && event.message;
    if (!msg) return null;
    const mt = msg.message_type;
    if (mt !== 'image' && mt !== 'file') return null;
    const content = JSON.parse(msg.content || '{}');
    const messageId = extractMessageId(event);
    if (mt === 'image') {
      const key = content.image_key || '';
      if (!key) return null;
      return { kind: 'image', fileKey: key, fileName: key + '.jpg', messageId };
    }
    const key = content.file_key || '';
    if (!key) return null;
    return { kind: 'file', fileKey: key, fileName: content.file_name || (key + '.bin'), messageId };
  } catch (_) {
    return null;
  }
}

/**
 * 下载飞书消息里的资源，返回 Buffer。
 * SDK 的 messageResource.get 返回 { writeFile, getReadableStream } 形态。
 */
async function downloadFeishuResource(messageId, fileKey, kind) {
  if (!apiClient) throw new Error('飞书未连接');
  const res = await apiClient.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: kind === 'image' ? 'image' : 'file' },
  });
  if (res && typeof res.getReadableStream === 'function') {
    const chunks = [];
    for await (const c of res.getReadableStream()) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  if (res && typeof res.writeFile === 'function') {
    const os = require('os');
    const tmp = path2.join(os.tmpdir(), 'feishu-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await res.writeFile(tmp);
    const buf = fs2.readFileSync(tmp);
    try { fs2.unlinkSync(tmp); } catch (_) {}
    return buf;
  }
  throw new Error('SDK 未提供可用的下载方法');
}

/** 确保 apiClient 已创建 */
function ensureApiClient() {
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) return null;
  if (!apiClient) apiClient = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
  return apiClient;
}

/** 查询机器人所在的群列表（分页取前 100） */
async function listChats() {
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置凭证' };
  if (!lark) return { success: false, error: '未安装 @larksuiteoapi/node-sdk' };
  ensureApiClient();
  try {
    const res = await apiClient.im.chat.list({ params: { page_size: 100 } });
    if (res && res.code !== 0 && res.code !== undefined) {
      return { success: false, error: res.msg || '查询群列表失败' };
    }
    const items = (res && res.data && res.data.items) || [];
    const chats = items.map((c) => ({ chatId: c.chat_id, name: c.name || '(未命名群)' }));
    return { success: true, chats };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 启动长连接（幂等：先断开旧的） */
function connect(cb) {
  if (cb) callbacks = cb;
  if (!lark) {
    setStatus('error', '未安装 @larksuiteoapi/node-sdk');
    return { success: false, error: '未安装 @larksuiteoapi/node-sdk' };
  }
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) {
    setStatus('error', '缺少 App ID / App Secret');
    return { success: false, error: '缺少 App ID / App Secret' };
  }
  disconnect(true);
  setStatus('connecting');

  try {
    apiClient = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        console.log('[Feishu] ★ 收到 im.message.receive_v1 事件');
        try {
          // 记录推送目标（用户首次发消息时）
          const sender = data && data.sender;
          const openId = sender && sender.sender_id && sender.sender_id.open_id;
          if (openId) {
            const cur = readConfig();
            if (cur.targetOpenId !== openId) {
              writeConfig({ targetOpenId: openId });
              console.log('[Feishu] 已记录推送目标 open_id:', openId);
            }
          }
          const chatId = extractChatId(data);
          const chatType = extractChatType(data);

          // 媒体消息（图片/文件）：下载到收件箱，把本地路径告知 AI
          const mediaInfo = extractMediaInfo(data);
          if (mediaInfo) {
            try {
              const buf = await downloadFeishuResource(mediaInfo.messageId, mediaInfo.fileKey, mediaInfo.kind);
              const inbox = require('../main/media/inbox');
              const saved = inbox.save('feishu', buf, mediaInfo.fileName);
              if (!saved.success) {
                console.warn('[Feishu] 媒体落盘失败:', saved.error);
                try { if (callbacks.onUserMessage) callbacks.onUserMessage('【收到' + (mediaInfo.kind === 'image' ? '图片' : '文件') + '，但保存失败：' + saved.error + '】', chatId, chatType); } catch (_) {}
                return;
              }
              const label = mediaInfo.kind === 'image' ? '图片' : '文件';
              const hint = mediaInfo.kind === 'image'
                ? '可用 view_image 工具查看'
                : '可用 read 工具读取（文本）或 bash 处理';
              const notice = '【用户通过飞书发来' + label + '】本地路径：' + saved.path + '（' + (saved.size / 1024).toFixed(1) + ' KB）\n' + hint;
              console.log('[Feishu] 收到媒体 ' + mediaInfo.kind + ', 已存 ' + saved.path);
              try { if (callbacks.onUserMessage) callbacks.onUserMessage(notice, chatId, chatType); } catch (_) {}
            } catch (err) {
              console.error('[Feishu] 媒体下载失败:', err.message);
              try { if (callbacks.onUserMessage) callbacks.onUserMessage('【用户发来' + (mediaInfo.kind === 'image' ? '图片' : '文件') + '，但下载失败：' + err.message + '】', chatId, chatType); } catch (_) {}
            }
            return;
          }

          const text = extractText(data);
          if (text) {
            console.log('[Feishu] 收到消息, 长度=' + text.length + ' 类型=' + (chatType || '未知') + (chatId ? ' chat=' + chatId : '') + ' 内容=' + JSON.stringify(text.slice(0, 60)));
            try { if (callbacks.onUserMessage) callbacks.onUserMessage(text, chatId, chatType); } catch (_) {}
          }
        } catch (err) {
          console.error('[Feishu] 处理消息失败:', err.message);
        }
      },
    });

    wsClient = new lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: lark.LoggerLevel ? lark.LoggerLevel.info : undefined,
      onReady: () => { console.log('[Feishu] 长连接就绪(onReady)'); setStatus('connected'); },
      onError: (err) => setStatus('error', (err && err.message) || String(err)),
      onReconnecting: () => setStatus('connecting', '重连中…'),
      onReconnected: () => setStatus('connected'),
    });
    wsClient.start({ eventDispatcher: dispatcher });
    return { success: true };
  } catch (err) {
    setStatus('error', err.message);
    return { success: false, error: err.message };
  }
}

/** 断开连接。@param silent 不更新状态（供内部切换用） */
function disconnect(silent) {
  try {
    if (wsClient && typeof wsClient.close === 'function') wsClient.close({});
  } catch (_) {}
  wsClient = null;
  apiClient = null;
  if (!silent) setStatus('disconnected');
}

/**
 * 发送文本消息。
 * @param {string} text
 * @param {string} [chatId] 群 chat_id；为空则回退单聊（发给已记录的 targetOpenId）
 */
async function sendText(text, chatId) {
  if (!lark) return { success: false, error: '未安装 @larksuiteoapi/node-sdk' };
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置' };
  ensureApiClient();
  // 群模式：优先发到 chatId
  if (chatId) {
    try {
      const res = await apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      });
      if (res && (res.code === 0 || res.code === undefined)) return { success: true };
      return { success: false, error: (res && res.msg) || '发送失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  // 单聊回退：发给已记录的 targetOpenId
  if (!cfg.targetOpenId) {
    return { success: false, error: '该窗口尚未绑定飞书群（请先在飞书页绑定群）' };
  }
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: cfg.targetOpenId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    if (res && (res.code === 0 || res.code === undefined)) return { success: true };
    return { success: false, error: (res && res.msg) || '发送失败' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 发送交互式卡片。
 *
 * 与 sendText 的区别：卡片支持 markdown、折叠面板（collapsible_panel）、
 * 分割线等富文本元素，是「思考过程默认收起、点击展开」的唯一实现方式。
 *
 * @param {object} card 飞书卡片 JSON（schema 2.0）
 * @param {string} [chatId] 群 chat_id；为空则回退单聊
 */
async function sendCard(card, chatId) {
  if (!lark) return { success: false, error: '未安装 @larksuiteoapi/node-sdk' };
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置' };
  ensureApiClient();
  const content = JSON.stringify(card);
  if (chatId) {
    try {
      const res = await apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
      if (res && (res.code === 0 || res.code === undefined)) return { success: true };
      return { success: false, error: (res && res.msg) || '发送失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  if (!cfg.targetOpenId) {
    return { success: false, error: '该窗口尚未绑定飞书群（请先在飞书页绑定群）' };
  }
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: cfg.targetOpenId, msg_type: 'interactive', content },
    });
    if (res && (res.code === 0 || res.code === undefined)) return { success: true };
    return { success: false, error: (res && res.msg) || '发送失败' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 供媒体适配器获取已创建的 apiClient。
 * 未连接时返回 null，调用方应处理。
 */
function getApiClient() {
  try {
    ensureApiClient();
    return apiClient || null;
  } catch (_) {
    return null;
  }
}

module.exports = { connect, disconnect, sendText, sendCard, getStatus, listChats, readConfig, getApiClient };
