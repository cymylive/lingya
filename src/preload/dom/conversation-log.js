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
  '自动续写', '拒绝改写请求', '拒绝改写回传', '拒绝拦截', 'XML工具调用提示',
  'CTF注入', '飞书', '监督续跑', '压缩-摘要', '定时任务', 'MCP信息',
  '插入记忆', '插入全部记忆', '插入技能', '生成文档', '沉浸式交流', '手动解析',
];

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

/** 追加一条记录（幂等去重：连续相同 + 跨来源用户消息去重） */
function addEntry(role, text, tag) {
  if (!text) return;
  const t = String(text).trim();
  if (!t) return;
  // 连续相同内容去重
  const last = entries[entries.length - 1];
  if (last && last.role === role && last.text === t) return;
  // 用户消息：跨来源去重（② 与 ③ 可能同时上报同一条）
  if (role === 'user') {
    if (isDuplicateUserMessage(t)) return;
    rememberUserMessage(t);
  }
  entries.push({ role: role, text: t, ts: Date.now(), tag: tag || '' });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
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
    onUserMessageSent(function (text, tag) {
      if (shouldSkipTag(tag)) return;
      addEntry('user', text, tag);
    });
  } catch (e) { console.error('[LingYa][对话记录] 订阅用户消息失败:', e && e.message); }

  // 3. 用户手动发送的消息（主世界 hook 从请求体提取后派发）
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('lingya-user-message', function (ev) {
        const d = ev && ev.detail;
        if (!d || !d.text) return;
        addEntry('user', d.text, '手动输入');
      });
    }
  } catch (e) { console.error('[LingYa][对话记录] 订阅手动消息失败:', e && e.message); }

  console.log('[LingYa][对话记录] 已启动');
}

module.exports = {
  // 纯函数（测试用）
  buildMarkdown, stripToolBlocks, shouldSkipTag, formatTime,
  SYSTEM_TAGS, SYSTEM_TAG_PREFIXES, MAX_ENTRIES, DEDUP_WINDOW_MS,
  isDuplicateUserMessage,
  // 运行时
  initConversationLog, addEntry, getEntries, clearEntries, getCount, exportMarkdown,
};