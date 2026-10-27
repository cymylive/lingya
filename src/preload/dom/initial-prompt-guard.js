/**
 * initial-prompt 接收端守卫
 *
 * 【真实事故 2026-10-27】同一批 systemPrompt 的 4 个分段被完整发送了两遍，
 * 中间夹着用户真实提问。AI 上下文被彻底打乱，还在思考里写
 * 「我已经问了两次待确认，用户继续注入配置没有回答」——把重复注入当成用户在喂配置。
 *
 * 根因：chat-input.js 的 initial-prompt 监听器每收到事件就无条件重置
 *   state.initialPromptChunks / initialPromptChunkIndex / initialPromptSentChunks
 * 而 initialPromptSentChunks 正是「同一段绝不重复发送」幂等防护的载体。
 * 于是第二次事件一到，防护被清空，从第 1 段重头再发一遍。
 *
 * 这个模块只做决策，不改状态，便于单测。调用方拿到 accept 后再动状态。
 */

// 已处理批次 ID 上限。超出后丢弃最老的，防止长时间运行无限增长。
const MAX_HANDLED_BATCHES = 100;

// 跨事件保留的已处理批次集合（模块级，调用方通过 state 传入以便测试）
const handledBatchIds = new Set();

/** 清空已处理批次记录（测试与重新初始化时用） */
function resetInitialPromptGuard() {
  handledBatchIds.clear();
}

/** 把某个 batchId 记为已处理，超上限时淘汰最老的 */
function markBatchHandled(batchId) {
  if (!batchId) return;
  handledBatchIds.add(String(batchId));
  while (handledBatchIds.size > MAX_HANDLED_BATCHES) {
    const first = handledBatchIds.values().next().value;
    handledBatchIds.delete(first);
  }
}

/**
 * 判断是否接受这批 initial-prompt。
 *
 * @param {object} p
 * @param {string|null} p.batchId   主进程生成的批次 ID（旧版主进程不传）
 * @param {number} p.chunkCount     本批段数
 * @param {object} p.state          { chunks, chunkIndex, handledBatchIds }
 * @returns {{accept: boolean, reason?: string}}
 */
function decideInitialPromptAccept(p) {
  const opts = p || {};
  const state = opts.state || {};
  const batchId = opts.batchId ? String(opts.batchId) : null;
  const chunkCount = Number(opts.chunkCount) || 0;

  // 1) 空批次
  if (chunkCount <= 0) {
    return { accept: false, reason: '空批次（chunkCount=0），忽略' };
  }

  // 2) 批次去重
  const handled = state.handledBatchIds || handledBatchIds;
  if (batchId && handled.has(batchId)) {
    return { accept: false, reason: '该批次已处理过（batchId=' + batchId + '），拒绝重复发送' };
  }

  // 3) 进行中守卫
  //    chunks 非空且还没走到末段 → 上一批正在发，不接受新批次。
  //    走到末段（chunkIndex === length-1）时允许，因为最后一段发完会置 null，
  //    此时新批次到来属于正常续接（如用户手动再初始化一次）。
  const chunks = state.chunks;
  const idx = Number(state.chunkIndex) || 0;
  if (Array.isArray(chunks) && chunks.length > 0 && idx < chunks.length - 1) {
    return {
      accept: false,
      reason: '上一批初始化仍在进行中（第 ' + (idx + 1) + '/' + chunks.length + ' 段），拒绝新批次以免打断',
    };
  }

  return { accept: true };
}

module.exports = {
  decideInitialPromptAccept,
  markBatchHandled,
  resetInitialPromptGuard,
  MAX_HANDLED_BATCHES,
};
