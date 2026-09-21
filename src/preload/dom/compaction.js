/**
 * 手动压缩上下文：全自动流程（纯 API，不依赖 DOM 点击）
 *
 * 流程：
 *  1. 发送指令让 AI 输出摘要，等待回复完成
 *  2. 从 URL 获取 chat_session_id
 *  3. 从 IndexedDB 读取全量 message_ids
 *  4. 取尾部 20%
 *  5. 用缓存的真实请求头直接 fetch /api/v0/share/create
 *  6. 得到 share_id → 拼分享链接
 *  7. 跳转 → 新页面自动初始化项目
 *
 * 依赖：
 *  - hook 已把真实请求头缓存到 localStorage['lingya-ds-headers']
 *  - DeepSeek 把会话消息缓存在 IndexedDB 'deepseek-chat' 的 'history-message' store
 */
const { sendToChat } = require('./chat-input');
const { onInterceptedResponse } = require('./intercept-observer');
const { showToast } = require('../overlay/ui');
const state = require('./state');

const SUMMARY_INSTRUCTION =
  '请把以上对话总结成一份详细的摘要，尽可能完整地保留关键信息、背景上下文、' +
  '已完成的结论和未完成的事项，用中文，一次性输出全部内容，' +
  '直接输出摘要，不要输出其他解释。';

/** 日志前缀 */
function logStep(step, msg) {
  console.log('[LingYa Compact] [' + step + '] ' + msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待 AI 回复完成（拦截到完整回复） */
function waitForResponse(timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const off = onInterceptedResponse((text) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(text);
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      reject(new Error('等待 AI 回复超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/** 从当前 URL 获取 chat_session_id */
function getSessionIdFromUrl() {
  const m = String(location.href).match(/\/chat\/s\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** 从 localStorage 读取缓存的真实请求头 */
function getCachedHeaders() {
  try {
    const raw = localStorage.getItem('lingya-ds-headers');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 从 IndexedDB 读取指定会话的全量消息（含 role），按 message_id 升序
 * @param {string} sessionId
 * @returns {Promise<Array<{message_id:number, role:string}>>}
 */
function getMessagesFromIndexedDB(sessionId) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = () => reject(new Error('打开 IndexedDB 失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onsuccess = () => {
          db.close();
          const val = g.result;
          const msgs = val && val.data && val.data.chat_messages;
          if (!Array.isArray(msgs)) { reject(new Error('IndexedDB 无该会话消息')); return; }
          const list = msgs
            .filter((m) => typeof m.message_id === 'number')
            .map((m) => ({ message_id: m.message_id, role: m.role || '', parent_id: m.parent_id }))
            .sort((a, b) => a.message_id - b.message_id);
          resolve(list);
        };
        g.onerror = () => { db.close(); reject(new Error('读取消息失败')); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}

/**
 * 读取某会话在 IndexedDB 中的最大 message_id（无则返回 0）
 */
async function getMaxMessageId(sessionId) {
  try {
    const msgs = await getMessagesFromIndexedDB(sessionId);
    if (!msgs.length) return 0;
    return msgs[msgs.length - 1].message_id;
  } catch (_) {
    return 0;
  }
}

/**
 * 从消息列表中取最近 ratio 比例的消息，保证成对（USER + ASSISTANT）
 * DeepSeek 要求 share/create 的 message_ids 必须成对出现，否则报
 * MESSAGES_MUST_APPEAR_IN_PAIRS。
 * @param {Array<{message_id:number, role:string}>} msgs 升序消息
 * @param {number} ratio
 * @returns {number[]}
 */
function pickRecentPairedIds(msgs, ratio) {
  const total = msgs.length;
  if (total === 0) return [];
  // 目标条数（至少 2 条 = 1 组）
  let keep = Math.max(2, Math.round(total * ratio));
  let start = Math.max(0, total - keep);
  // 起点调整到 USER 消息（保证从一组开头开始）
  while (start > 0 && msgs[start].role !== 'USER') start--;
  // 终点调整：末尾必须是 ASSISTANT（保证组完整）
  let end = total;
  while (end > start + 1 && msgs[end - 1].role !== 'ASSISTANT') end--;
  const picked = msgs.slice(start, end);
  // DeepSeek 要求 message_ids 降序（最新在前），否则报 MESSAGES_MUST_APPEAR_IN_PAIRS
  return picked.map((m) => m.message_id).sort((a, b) => b - a);
}

/**
 * 调用 share/create 创建分享
 * @param {string} sessionId
 * @param {number[]} messageIds
 * @param {object} headers
 * @returns {Promise<string>} share_id
 */
async function createShare(sessionId, messageIds, headers) {
  const h = Object.assign({}, headers);
  h['content-type'] = 'application/json';
  const resp = await fetch('/api/v0/share/create', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ chat_session_id: sessionId, message_ids: messageIds }),
  });
  const txt = await resp.text();
  console.log('[LingYa Compact] [api] share/create HTTP ' + resp.status + ' 响应: ' + txt.slice(0, 600));
  let json = null;
  try { json = JSON.parse(txt); } catch (_) {}
  if (!json || json.code !== 0) {
    throw new Error('创建分享失败: ' + (json ? json.msg : txt.slice(0, 200)));
  }
  const shareId = json.data && json.data.biz_data && json.data.biz_data.share_id;
  if (!shareId) throw new Error('响应无 share_id（完整响应见日志）');
  return shareId;
}

/**
 * 主流程
 */
async function runCompaction() {
  const btn = document.getElementById('lingya-btn-compact');
  if (btn) { btn.disabled = true; btn.textContent = '压缩中...'; }

  try {
    // 步骤 0：先取 session_id 和发送前的 maxId
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');
    logStep('api', 'chat_session_id = ' + sessionId);
    const maxIdBefore = await getMaxMessageId(sessionId);
    logStep('summary', '发送前 maxMessageId=' + maxIdBefore);

    // 步骤 1：让 AI 写摘要
    state.lastResponseMsgIds = null; // 清空，避免拿到上一条
    logStep('summary', '发送摘要指令');
    const waitReply = waitForResponse(120000);
    sendToChat(SUMMARY_INSTRUCTION, '压缩-摘要', 300);
    const summaryText = await waitReply;
    logStep('summary', '收到摘要回复，长度=' + (summaryText || '').length);

    // 摘要回复的 id（来自 SSE 流，最准确）
    const summaryIds = state.lastResponseMsgIds;
    const summaryRespId = summaryIds && summaryIds.responseMessageId;
    const summaryReqId = summaryIds && summaryIds.requestMessageId;
    logStep('summary', '摘要消息 id: response=' + (summaryRespId || '?') + ' request=' + ((summaryIds && summaryIds.requestMessageId) || '?'));

    // 步骤 1.5：不再等 IndexedDB（写入时机不确定，常白等超时）
    // 摘要 id 来自 SSE，稍后直接补入分享列表
    await sleep(500);

    // 步骤 3：取请求头
    const headers = getCachedHeaders();
    if (!headers || !headers['authorization']) {
      throw new Error('未获取到认证请求头（请刷新页面后重试）');
    }
    logStep('api', '已获取缓存的请求头');

    // 步骤 4：读 IndexedDB 拿全量消息（含 role），取最近 20% 且保证成对
    const allMsgs = await getMessagesFromIndexedDB(sessionId);
    if (allMsgs.length === 0) throw new Error('未读取到消息列表');
    let tailIds = pickRecentPairedIds(allMsgs, 0.2);
    if (tailIds.length === 0) throw new Error('裁剪后无有效消息');

    // 补入摘要消息：IndexedDB 可能未及时写入摘要，但 SSE 已给出其精确 id
    if (typeof summaryRespId === 'number') {
      const idSet = new Set(tailIds);
      const extra = [];
      if (!idSet.has(summaryRespId)) extra.push(summaryRespId);
      if (typeof summaryReqId === 'number' && !idSet.has(summaryReqId)) extra.push(summaryReqId);
      if (extra.length) {
        tailIds = tailIds.concat(extra).sort((a, b) => b - a);
        logStep('api', '补入摘要消息 id: ' + JSON.stringify(extra));
      }
    }

    logStep('api', '全量消息 ' + allMsgs.length + ' 条，保留最近 ' + tailIds.length + ' 条（成对）');

    // 步骤 5：直接调 share/create
    const shareId = await createShare(sessionId, tailIds, headers);
    const link = 'https://chat.deepseek.com/share/' + shareId;
    logStep('api', '分享链接: ' + link);

    // 步骤 6：跳转（存标记 + 项目目录）
    showToast('压缩完成，正在打开新会话...', 3000);
    try {
      localStorage.setItem('lingya-compact-pending-init', String(Date.now()));
      if (state.currentProjectDir) {
        localStorage.setItem('lingya-compact-project-dir', state.currentProjectDir);
      }
    } catch (_) {}
    window.location.href = link;

  } catch (err) {
    console.error('[LingYa Compact] 压缩失败:', err);
    showToast('压缩失败: ' + err.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '压缩'; }
  }
}

/**
 * 页面加载后检查是否有待执行的"压缩后初始化"
 * 若有，读取被压缩项目的目录，自动初始化项目（不弹目录选择框）
 */
function checkPendingInit() {
  let pending = null;
  let projectDir = null;
  try {
    pending = localStorage.getItem('lingya-compact-pending-init');
    projectDir = localStorage.getItem('lingya-compact-project-dir');
  } catch (_) {}
  if (!pending) return;
  try {
    localStorage.removeItem('lingya-compact-pending-init');
    localStorage.removeItem('lingya-compact-project-dir');
  } catch (_) {}
  console.log('[LingYa Compact] 检测到压缩后待初始化，3 秒后执行；项目目录=' + (projectDir || '(无)'));
  setTimeout(() => {
    try {
      window.electronAPI.initProject(projectDir || null, true);
    } catch (err) {
      console.error('[LingYa Compact] 压缩后初始化失败:', err);
    }
  }, 3000);
}

module.exports = { runCompaction, checkPendingInit };
