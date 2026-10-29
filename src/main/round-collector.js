/**
 * 轮次收集器：聚合一轮任务里的 AI 回复与工具调用流水。
 *
 * 【为什么需要】推送通道原先每种事件各推一条独立消息：
 *   🧠 AI 正在生成… / 🔧 正在调用工具：bash / ✅ 工具调用完成 / 🤖 AI：xxx
 * 一条任务下来七八条碎片，用户要在里面拼凑「AI 到底做了什么」。
 * 而且工具执行细节（调了哪些、按什么顺序）完全没有留存。
 *
 * 【本模块职责】按 profile 维护一轮的状态：
 *   - 收 user-message → 开启新一轮
 *   - 收 ai-reply    → 追加一条 AI 发言
 *   - 收 tool-start  → 追加一条工具记录（未完成）
 *   - 收 tool-end    → 标记上一条工具记录完成
 *   - 收 task-done   → 收尾，返回整轮汇总供推送
 *
 * 纯内存、无副作用、不涉及 IPC 与网络，便于单测。
 */

// profileId -> round
// round = { startedAt, userText, replies: [string], tools: [{name, at, done}], aiStartNotified }
const rounds = new Map();

function getRound(profileId) {
  let r = rounds.get(profileId);
  if (!r) {
    r = { startedAt: Date.now(), userText: '', replies: [], thinkings: [], tools: [], aiStartNotified: false };
    rounds.set(profileId, r);
  }
  return r;
}

/**
 * 收到用户消息：开启新一轮（旧轮若有内容，说明上一轮没收尾，直接丢弃避免串轮）。
 */
function onUserMessage(profileId, text) {
  const r = { startedAt: Date.now(), userText: String(text || ''), replies: [], thinkings: [], tools: [], aiStartNotified: false };
  rounds.set(profileId, r);
  return r;
}

/**
 * 收到 AI 回复：追加一条发言。
 * @returns {{ isFirstReplyOfRound: boolean }}
 */
function onAiReply(profileId, text, hasTool, thinking) {
  const r = getRound(profileId);
  const t = String(text || '').trim();
  if (t) r.replies.push(t);
  // 深度思考内容单独保存，与正文一一对应（同一次回复的 thinking + text）
  const th = String(thinking || '').trim();
  if (th) r.thinkings.push(th);
  r.hasTool = !!hasTool;
  return { isFirstReplyOfRound: r.replies.length === 1 };
}

/**
 * 收到 AI 开始生成：标记，用于主进程决定是否推「正在生成」轻提示（每轮只推一次）。
 * @returns {{ shouldNotify: boolean }}
 */
function onAiStart(profileId) {
  const r = getRound(profileId);
  if (r.aiStartNotified) return { shouldNotify: false };
  r.aiStartNotified = true;
  return { shouldNotify: true };
}

/**
 * 收到工具开始：追加一条工具记录。
 */
function onToolStart(profileId, toolName) {
  const r = getRound(profileId);
  // 上一条若还挂着未完成（tool-end 丢失），视为已完成，避免脏数据累积
  const last = r.tools[r.tools.length - 1];
  if (last && !last.done) last.done = true;
  r.tools.push({ name: String(toolName || '未知工具'), at: Date.now(), done: false });
  return r.tools[r.tools.length - 1];
}

/**
 * 收到工具结束：标记最近一条未完成的工具记录为完成。
 */
function onToolEnd(profileId) {
  const r = getRound(profileId);
  for (let i = r.tools.length - 1; i >= 0; i--) {
    if (!r.tools[i].done) { r.tools[i].done = true; break; }
  }
}

/**
 * 任务收尾：返回本轮汇总并清空。
 * @returns {null | { userText, replies, tools, durationMs }}
 */
function finish(profileId) {
  const r = rounds.get(profileId);
  if (!r) return null;
  rounds.delete(profileId);
  // 兜底：结束前把所有未完成的工具标记完成
  for (const t of r.tools) t.done = true;
  return {
    userText: r.userText,
    replies: r.replies.slice(),
    thinkings: r.thinkings.slice(),
    tools: r.tools.slice(),
    durationMs: Date.now() - r.startedAt,
  };
}

/**
 * 窥视当前轮状态（不改动）。测试用。
 */
function peek(profileId) {
  const r = rounds.get(profileId);
  if (!r) return null;
  return {
    userText: r.userText,
    replies: r.replies.slice(),
    thinkings: r.thinkings.slice(),
    tools: r.tools.slice(),
    hasTool: !!r.hasTool,
    aiStartNotified: r.aiStartNotified,
  };
}

/** 清空全部状态。测试用。 */
function resetAll() {
  rounds.clear();
}

/**
 * 生成工具链摘要，供纯文本通道（QQ/微信）使用。
 * 例：bash → read → write
 */
function buildToolChainSummary(tools) {
  if (!tools || tools.length === 0) return '';
  return tools.map((t) => t.name).join(' → ');
}

/**
 * 生成工具执行流水（带时间），供飞书卡片折叠区使用。
 */
function buildToolTimeline(tools, startedAt) {
  if (!tools || tools.length === 0) return '';
  const lines = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const rel = Math.max(0, Math.round((t.at - startedAt) / 100) / 10);
    lines.push((i + 1) + '. +' + rel + 's  `' + t.name + '`');
  }
  return lines.join('\n');
}

module.exports = {
  onUserMessage,
  onAiReply,
  onAiStart,
  onToolStart,
  onToolEnd,
  finish,
  peek,
  resetAll,
  buildToolChainSummary,
  buildToolTimeline,
};
