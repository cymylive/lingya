/**
 * 会话对话记录 + 导出 Markdown
 *
 * 背景：LingYa 不持久化对话内容（session-store 只存「会话ID→项目目录」），
 * 网页 IndexedDB 也只有 message_id/role 元数据（实测无正文）。
 * 因此要导出对话，只能在运行时累积。
 *
 * 三个来源：
 *  1. AI 回复 —— onInterceptedResponse（拦截模式已能拿到全文）
 *  2. LingYa 发送的用户消息 —— onUserMessageSent（工具回传等系统消息会被过滤）
 *  3. 用户手动发送的消息 —— 主世界 hook 派发 'lingya-user-message'（从请求体提取）
 *
 * 设计约束：纯函数部分（buildMarkdown/stripToolBlocks/shouldSkipTag）必须可在 Node 下测试，
 * 集成部分（initConversationLog）的所有外部依赖用 try/catch 包裹。
 */

// 系统消息 tag —— 这些不是用户真实输入，导出时过滤
const SYSTEM_TAGS = [
  '拒绝改写请求', '拒绝改写回传', '拒绝拦截', 'XML工具调用提示',
  'CTF注入', '飞书', '压缩-摘要', '定时任务', 'MCP信息',
  '插入记忆', '插入全部记忆', '插入技能', '生成文档', '沉浸式交流', '手动解析',
];

// 附件消息的 tag 前缀：用户消息以 .md 附件形式发送时，tag 形如「附件:笔记-053800.md」
// 导出时据此渲染「（附件：xxx）」前缀，正文即附件全文。
const ATTACHMENT_TAG_PREFIX = '附件:';

/** 判断 tag 是否为附件消息 */
function isAttachmentTag(tag) {
  return typeof tag === 'string' && tag.indexOf(ATTACHMENT_TAG_PREFIX) === 0;
}

/** 从附件 tag 中取出文件名 */
function getAttachmentName(tag) {
  if (!isAttachmentTag(tag)) return '';
  return tag.slice(ATTACHMENT_TAG_PREFIX.length);
}

/**
 * 判断一段用户文本是否为「附件引导语」——即 upload-hint 生成的那句提示。
 * 引导语特征：短（<200 字符）、含 .md 文件名、不含换行。
 * 用于跨来源去重：附件全文已由来源2 记录，来源3 从请求体提取到的引导语应丢弃。
 */
function isUploadHintText(text) {
  if (!text) return false;
  const s = String(text);
  if (s.length > 200) return false;
  if (s.indexOf(String.fromCharCode(10)) !== -1) return false;
  return /.md\b/i.test(s);
}

/** 工具结果回传/JS 汇总类消息：tag 以这些前缀开头，同样过滤 */
const SYSTEM_TAG_PREFIXES = ['工具=', 'JS汇总', '工具结果'];

/** 移除工具代码块（lingya/js） */
function stripToolBlocks(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*?```/gi, '');
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*$/gi, '');
  return out.trim();
}

/** 是否为系统消息（不该出现在导出的对话里） */
function shouldSkipTag(tag) {
  if (!tag) return false;
  if (SYSTEM_TAGS.indexOf(tag) !== -1) return true;
  for (const p of SYSTEM_TAG_PREFIXES) {
    if (tag.indexOf(p) === 0) return true;
  }
  return false;
}

/** 把时间戳格式化为 YYYY-MM-DD HH:mm:ss */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 生成 Markdown（纯函数，可测）
 * @param {Array<{role:string,text:string,ts:number,tag?:string}>} entries
 * @param {{sessionUrl?:string, sessionId?:string, projectDir?:string, platform?:string, now?:number}} meta
 * @param {{includeToolBlocks?:boolean}} [opts]
 * @returns {string}
 */
function buildMarkdown(entries, meta, opts) {
  const m = meta || {};
  const o = opts || {};
  const list = Array.isArray(entries) ? entries : [];
  const lines = [];

  lines.push('# 会话导出');
  lines.push('');
  lines.push('- 导出时间：' + formatTime(m.now || Date.now()));
  if (m.platform) lines.push('- 平台：' + m.platform);
  if (m.sessionUrl) lines.push('- 会话链接：' + m.sessionUrl);
  if (m.sessionId) lines.push('- 会话 ID：' + m.sessionId);
  if (m.projectDir) lines.push('- 项目目录：' + m.projectDir);
  lines.push('- 消息数：' + list.length);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (list.length === 0) {
    lines.push('（本窗口打开后尚无对话记录）');
    lines.push('');
    return lines.join('\n');
  }

  for (const e of list) {
    const role = e.role === 'user' ? '用户' : 'AI';
    lines.push('## ' + role + (e.ts ? ' · ' + formatTime(e.ts) : ''));
    lines.push('');
    // 附件消息：在正文前加一行元信息，让导出能区分「输入框直接发」与「附件上传」
    const attName = e.attachmentName || getAttachmentName(e.tag);
    if (attName) {
      lines.push('> 附件：' + attName);
      lines.push('');
    }
    let text = e.text || '';
    if (!o.includeToolBlocks) text = stripToolBlocks(text);
    lines.push(text || '（空）');
    lines.push('');
  }

  return lines.join('\n');
}

// ========== 运行时状态 ==========
let entries = [];
let started = false;
const MAX_ENTRIES = 2000;   // 上限保护，避免超长会话撑爆内存

// 跨来源去重窗口：同一条用户消息可能同时来自
//   ② onUserMessageSent（LingYa 发送，含原始 msg）
//   ③ lingya-user-message（hook 从请求体提取的 prompt，可能被包装过）
// 两者内容可能不同（如加前缀），故不能只靠"完全相等"去重。
// 用「角色 + 时间窗 + 前缀/包含」三重判定。
const DEDUP_WINDOW_MS = 5000;
const recentUserMsgs = [];   // [{ text, at }]

// ===== 本地存档持久化状态 =====
let currentSessionId = null;
let persistTimer = null;
let pendingToPersist = [];   // [{ entry, retries }]
const PERSIST_DEBOUNCE_MS = 1000;
const PERSIST_MAX_RETRIES = 3;

function getCurrentSessionId() { return currentSessionId; }
function __testSetSessionId(sid) { currentSessionId = sid || null; }

/** 解析当前会话 ID：优先缓存值，其次从 URL 实时提取 */
function _resolveSessionId() {
  if (currentSessionId) return currentSessionId;
  try {
    const provider = require('../../providers').getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) {}
  return null;
}

/** 安排一次节流写盘（1s 内的多次 addEntry 合并成一批） */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(_flushPersist, PERSIST_DEBOUNCE_MS);
  if (persistTimer && typeof persistTimer.unref === 'function') persistTimer.unref();
}

/** 把 pending 队列写入存档；失败的条目最多重试 3 次。
 *  每条 pending 自带 sessionId（入队时快照），避免会话切换后串写。 */
async function _flushPersist() {
  persistTimer = null;
  if (pendingToPersist.length === 0) return;
  const batch = pendingToPersist;
  pendingToPersist = [];
  const retryQueue = [];
  for (const item of batch) {
    const sid = item.sessionId || _resolveSessionId();
    if (!sid) continue;   // 无会话 id 的条目丢弃（内存 entries 仍保留）
    let ok = false;
    try {
      if (typeof window !== 'undefined' && window.electronAPI
          && typeof window.electronAPI.conversationArchiveAppend === 'function') {
        const r = await window.electronAPI.conversationArchiveAppend(sid, item.entry);
        ok = !!(r && r.success);
      }
    } catch (_) { ok = false; }
    if (!ok && item.retries < PERSIST_MAX_RETRIES) {
      retryQueue.push({ entry: item.entry, retries: item.retries + 1, sessionId: sid });
    }
  }
  if (retryQueue.length > 0) {
    pendingToPersist = retryQueue.concat(pendingToPersist);
    schedulePersist();
  }
}

/**
 * 从本地存档加载某会话的历史，替换内存 entries。
 * @param {string} sessionId
 * @returns {Promise<{loaded:boolean, count:number}>}
 */
async function loadFromArchive(sessionId) {
  if (!sessionId) return { loaded: false, count: 0 };
  try {
    if (typeof window === 'undefined' || !window.electronAPI
        || typeof window.electronAPI.conversationArchiveRead !== 'function') {
      return { loaded: false, count: 0 };
    }
    const r = await window.electronAPI.conversationArchiveRead(sessionId);
    if (!r || !r.success || !Array.isArray(r.entries) || r.entries.length === 0) {
      return { loaded: false, count: 0 };
    }
    entries = r.entries.map(e => ({
      role: e.role || '', text: e.text || '', ts: e.ts || Date.now(), tag: e.tag || '',
      attachmentName: e.attachmentName || '',
    }));
    return { loaded: true, count: entries.length };
  } catch (_) {
    return { loaded: false, count: 0 };
  }
}

function isDuplicateUserMessage(t) {
  const now = Date.now();
  // 清理过期
  for (let i = recentUserMsgs.length - 1; i >= 0; i--) {
    if (now - recentUserMsgs[i].at > DEDUP_WINDOW_MS) recentUserMsgs.splice(i, 1);
  }
  for (const r of recentUserMsgs) {
    if (r.text === t) return true;
    // 单向包含：仅当「新消息是旧消息的包装版本」才算重复。
    // 例：旧="你好"、新="用户消息：你好" → 去重。
    // 反之（旧="帮我看看代码"、新="帮我看看代码里的 bug"）是新内容，绝不能去重。
    // 要求旧消息足够长，避免短文本（"好的"/"好了"）误判。
    if (r.text.length >= 8 && t.length > r.text.length && t.indexOf(r.text) !== -1) return true;
  }
  return false;
}

function rememberUserMessage(t) {
  recentUserMsgs.push({ text: t, at: Date.now() });
  if (recentUserMsgs.length > 20) recentUserMsgs.shift();
}

// 最近记录过的附件名：用于过滤来源3 从请求体提取到的引导语
const recentAttachments = [];

function rememberAttachment(name) {
  if (!name) return;
  recentAttachments.push({ name: name, at: Date.now() });
  if (recentAttachments.length > 20) recentAttachments.shift();
}

/**
 * 提前登记待上传附件名（2026-11-06 修复竞态 #1）。
 * 场景：来源3（请求体 hook）可能先于 onUserMessageSentCb 到达，
 * 若不提前登记，引导语会先被记录为一条 user 消息，随后来源2 的全文
 * 又记一条，导出时出现「引导语」+「全文」两条重复记录。
 * 调用方：chat-input.js 在上传成功后立即调用本函数。
 */
function notePendingAttachment(name) {
  rememberAttachment(name);
}

/**
 * 检查一段短文本是否为刚上传附件的引导语。
 * upload-hint 生成的引导语含文件名，且文件名在 recentAttachments 里。
 */
function matchesRecentAttachment(text) {
  if (!isUploadHintText(text)) return false;
  const now = Date.now();
  for (let i = recentAttachments.length - 1; i >= 0; i--) {
    if (now - recentAttachments[i].at > 60000) { recentAttachments.splice(i, 1); continue; }
    if (text.indexOf(recentAttachments[i].name) !== -1) return true;
  }
  return false;
}

/**
 * 追加一条记录（幂等去重：连续相同 + 跨来源用户消息去重）
 * @param {string} role
 * @param {string} text
 * @param {string} [tag]
 * @param {{attachment?:{name:string}}} [extra] 附件消息附加信息
 */
function addEntry(role, text, tag, extra) {
  if (!text) return;
  // 2026-11-05: 写入本地记录前还原占位符，让导出/存档/会话历史都是真词
  let __raw = text;
  try {
    const { unredactText } = require('./redaction-filter');
    if (unredactText) __raw = unredactText(text);
  } catch (_) {}
  const t = String(__raw).trim();
  if (!t) return;
  // 附件消息：tag 改为「附件:<name>」，并登记文件名供后续引导语过滤
  let finalTag = tag || '';
  let attachmentName = '';
  if (extra && extra.attachment && extra.attachment.name) {
    attachmentName = String(extra.attachment.name);
    finalTag = ATTACHMENT_TAG_PREFIX + attachmentName;
    rememberAttachment(attachmentName);
  }
  // 来源3 引导语过滤：短文本命中刚上传的附件名，说明全文已由来源2 记录过，丢弃
  if (role === 'user' && !attachmentName && matchesRecentAttachment(t)) {
    return;
  }
  // 连续相同内容去重
  const last = entries[entries.length - 1];
  if (last && last.role === role && last.text === t) return;
  // 用户消息：跨来源去重（② 与 ③ 可能同时上报同一条）
  if (role === 'user') {
    if (isDuplicateUserMessage(t)) return;
    rememberUserMessage(t);
  }
  const _entry = { role: role, text: t, ts: Date.now(), tag: finalTag };
  if (attachmentName) _entry.attachmentName = attachmentName;
  entries.push(_entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  // 追加到持久化队列（节流写盘）；记录入队时的 sessionId，防止切会话后串写
  pendingToPersist.push({ entry: _entry, retries: 0, sessionId: _resolveSessionId() });
  schedulePersist();
}

function getEntries() { return entries.slice(); }
function clearEntries() { entries = []; recentUserMsgs.length = 0; }
function getCount() { return entries.length; }

/** 导出 Markdown（含当前会话元信息） */
function exportMarkdown(opts) {
  let meta = { now: Date.now() };
  try {
    const provider = require('../../providers').getProviderByUrl(window.location.href);
    if (provider) {
      meta.platform = provider.name;
      if (typeof provider.extractSessionId === 'function') {
        meta.sessionId = provider.extractSessionId(window.location.href) || undefined;
      }
    }
  } catch (_) { /* ignore */ }
  try { meta.sessionUrl = window.location.href; } catch (_) {}
  try {
    const state = require('./state');
    if (state.currentProjectDir) meta.projectDir = state.currentProjectDir;
  } catch (_) {}
  return buildMarkdown(entries, meta, opts);
}

/** 启动对话记录（幂等） */
function initConversationLog() {
  if (started) return;
  started = true;

  // 1. AI 回复
  try {
    const { onInterceptedResponse } = require('./intercept-observer');
    onInterceptedResponse(function (text) { addEntry('assistant', text); });
  } catch (e) { console.error('[LingYa][对话记录] 订阅 AI 回复失败:', e && e.message); }

  // 2. LingYa 发送的用户消息（过滤系统消息）
  try {
    const { onUserMessageSent } = require('./chat-input');
    onUserMessageSent(function (text, tag, extra) {
      if (shouldSkipTag(tag)) return;
      addEntry('user', text, tag, extra);
    });
  } catch (e) { console.error('[LingYa][对话记录] 订阅用户消息失败:', e && e.message); }

  // 3. 用户手动发送的消息（主世界 hook 从请求体提取后派发）
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener(require('./evt-names').USER_MESSAGE, function (ev) {
        const d = ev && ev.detail;
        if (!d || !d.text) return;
        addEntry('user', d.text, '手动输入');
      });
    }
  } catch (e) { console.error('[LingYa][对话记录] 订阅手动消息失败:', e && e.message); }

  // 4. 会话切换监听：URL 的 sessionId 变化时，从本地存档加载该会话的历史
  try {
    let lastWatchedSid = _resolveSessionId();
    currentSessionId = lastWatchedSid;
    const watchTimer = setInterval(async function () {
      let sid = null;
      try {
        const provider = require('../../providers').getProviderByUrl(window.location.href);
        if (provider && typeof provider.extractSessionId === 'function') {
          sid = provider.extractSessionId(window.location.href) || null;
        }
      } catch (_) {}
      if (sid === lastWatchedSid) return;
      lastWatchedSid = sid;
      currentSessionId = sid;
      // 切会话：先落盘旧队列，再清内存，再从存档恢复新会话历史
      try { await _flushPersist(); } catch (_) {}
      entries = [];
      recentUserMsgs.length = 0;
      if (sid) {
        const r = await loadFromArchive(sid);
        if (r.loaded) console.log('[LingYa][对话记录] 从存档恢复 ' + r.count + ' 条历史, session=' + sid.slice(0, 8));
      }
    }, 1000);
    if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref();
  } catch (e) { console.error('[LingYa][对话记录] 会话切换监听启动失败:', e && e.message); }

  console.log('[LingYa][对话记录] 已启动');
}

module.exports = {
  // 纯函数（测试用）
  buildMarkdown, stripToolBlocks, shouldSkipTag, formatTime,
  SYSTEM_TAGS, SYSTEM_TAG_PREFIXES, MAX_ENTRIES, DEDUP_WINDOW_MS,
  isDuplicateUserMessage,
  ATTACHMENT_TAG_PREFIX, isAttachmentTag, getAttachmentName, isUploadHintText,
  // 运行时
  initConversationLog, addEntry, getEntries, clearEntries, getCount, exportMarkdown, notePendingAttachment,
  // 本地存档
  loadFromArchive, getCurrentSessionId, __testSetSessionId,
};