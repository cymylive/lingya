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

/** 从事件中提取纯文本（只处理文本消息） */
function extractText(event) {
  try {
    const msg = event && event.message;
    if (!msg) return '';
    if (msg.message_type !== 'text') return '';
    const content = JSON.parse(msg.content || '{}');
    return typeof content.text === 'string' ? content.text : '';
  } catch (_) {
    return '';
  }
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
          const text = extractText(data);
          const chatId = extractChatId(data);
          if (text) {
            console.log('[Feishu] 收到消息, 长度=' + text.length + (chatId ? ' 群=' + chatId : ' 单聊'));
            try { if (callbacks.onUserMessage) callbacks.onUserMessage(text, chatId); } catch (_) {}
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

module.exports = { connect, disconnect, sendText, getStatus, listChats, readConfig };
