/**
 * 工具调用抢占
 *
 * 场景：上一条回复里的工具还在跑（典型 bashOutput({wait:120000})），
 * 用户等不及又发了新消息。旧实现用 Promise 链串行排队，新回复只能干等，
 * 面板显示「已收到回复，排队等待处理…」——实际一行代码都没执行。
 *
 * 现在：新回复若**含工具调用**，先中止同会话上一轮的前台进程，
 * 旧调用拿到失败结果后丢弃，新调用立刻开始执行。
 *
 * 三条边界（用户确认）：
 *  1. 被抢占方返回 { success:false, error: PREEMPT_ERROR }，不是静默丢弃
 *  2. 只有含工具调用的回复才抢占，纯聊天不打断正在跑的任务
 *  3. 后台任务（bashBackground）不受影响，由 AI 自己 bashKill 收尾
 */
const { extractJsToolBlocks } = require('./js-detector');

/**
 * 这条回复是否应当抢占上一轮执行。
 * @param {string} text AI 回复全文
 * @returns {boolean}
 */
function shouldPreempt(text) {
  if (!text || typeof text !== 'string') return false;
  return extractJsToolBlocks(text).length > 0;
}

/**
 * 中止上一轮的前台工具执行（后台任务保留）。
 * @param {string|null} profileId 窗口标识
 * @param {string|null} sessionId 会话标识
 * @returns {Promise<{killed:number}>}
 */
async function preemptPreviousRun(profileId, sessionId) {
  try {
    const api = (typeof window !== 'undefined') && window.electronAPI;
    if (!api || typeof api.preemptExecution !== 'function') return { killed: 0 };
    const r = await api.preemptExecution({ profileId, sessionId });
    return { killed: (r && r.killed) || 0 };
  } catch (_) {
    // 抢占失败不能阻断正常流程：最坏情况退化成「不抢占」，与旧行为一致
    return { killed: 0 };
  }
}

module.exports = { shouldPreempt, preemptPreviousRun };
