/**
 * 催促决策闸门（纯函数，无副作用）
 *
 * 【为什么需要】
 * 改造前「要不要催」这个问题有三条路径各自作答，判断条件各不相同：
 *   1. supervisor.js 定时检查     —— 8 道闸门，最完备
 *   2. continueIfPlanUnfinished   —— 4 道，不看等用户、不看格式错误
 *   3. continueOnInterruptFallback—— 3 道，几乎无条件
 * 结果是 AI 在向用户提问时被抢答、输出格式错误时被催「接着做」而不是被纠错。
 *
 * 现在三条路径统一调本函数，条件不一致的问题从根上消失。今后新增场景
 * 只需在这里加一条，不用再担心漏改某条路径。
 *
 * 【返回】
 *   { action: 'nudge',   reason } —— 可以发催促
 *   { action: 'correct', reason } —— 不发催促，改发格式纠错提示
 *   { action: 'skip',    reason } —— 本轮什么都不发
 *
 * 【闸门顺序（命中即返回，顺序即优先级）】
 *   1. stopped                 用户点了停止
 *   2. awaitingNextInitialChunk 正在分批发初始提示
 *   3. 会话未激活               本会话没建过 todo 计划
 *   4. awaitingUserInput        AI 在等用户回答（强/弱一视同仁）
 *   5. xmlDetected              本轮是 XML/DSML 格式错误 → correct
 *   6. taskDeclaredDone         AI 已声明任务完成
 *   7. enabled === false        监督开关关闭
 *   8. count >= max             已催次数达上限（降频由调用方处理）
 *
 * 【为什么 awaitingUserInput 优先于 xmlDetected】
 * AI 一边问「要 A 还是 B」一边格式错了，此时用户要的是回答问题的机会，
 * 不是被塞一条格式提示打断。等用户回完，格式问题下一轮再纠。
 *
 * 【bypassGates】
 * 中断兜底（continueOnInterruptFallback）按用户要求保留无条件触发语义：
 * 服务端把生成截断时，哪怕会话没激活也要救一次，否则真卡死没人管。
 * 传 bypassGates: true 可跳过第 3、6、7、8 道闸门（停止/分批/等用户/格式仍然生效，
 * 因为这四种情况下发催促本身就是错的）。
 */

/**
 * @param {object} ctx
 * @param {boolean} [ctx.stopped]
 * @param {boolean} [ctx.awaitingNextInitialChunk]
 * @param {string|null} [ctx.sessionId]
 * @param {Set<string>} [ctx.activatedSessions]
 * @param {boolean} [ctx.awaitingUserInput]
 * @param {boolean} [ctx.taskDeclaredDone]
 * @param {boolean} [ctx.xmlDetected]
 * @param {boolean} [ctx.enabled]   默认视为开启（只有明确 false 才关）
 * @param {number} [ctx.count]      本窗口已催次数
 * @param {number} [ctx.max]        催促上限，<=0 视为无上限
 * @param {boolean} [ctx.bypassGates] 跳过激活/完成/开关/上限检查
 * @returns {{action: 'nudge'|'correct'|'skip', reason: string}}
 */
function decide(ctx) {
  const c = ctx || {};
  const bypass = c.bypassGates === true;

  // 1. 用户点了停止：什么都不做
  if (c.stopped) {
    return { action: 'skip', reason: '用户已停止' };
  }

  // 2. 正在分批发送初始提示：等回复是正常流程，不是停滞
  if (c.awaitingNextInitialChunk) {
    return { action: 'skip', reason: '正在分批发送初始提示' };
  }

  // 3. 会话未激活：本会话没建过 todo 计划，监督者不该介入
  if (!bypass) {
    const sid = c.sessionId || null;
    const activated = c.activatedSessions;
    const hasSession = !!(sid && activated && typeof activated.has === 'function' && activated.has(sid));
    if (!hasSession) {
      return { action: 'skip', reason: '本会话监督机制未激活' };
    }
  }

  // 4. AI 在等用户回答：球在用户那边，强/弱等待一律不催。
  //    （改造前弱等待有 3 分钟超时，用户选择取消该超时 —— 见 2026-10-25 决策）
  if (c.awaitingUserInput) {
    return { action: 'skip', reason: 'AI 正在等用户回答' };
  }

  // 5. 格式错误：发纠错提示，不发催促。放在催促判断之前，
  //    因为格式错误的根因没解决，催它「接着做」只会让它继续用错格式。
  if (c.xmlDetected) {
    return { action: 'correct', reason: '本轮为 XML/DSML 格式错误，改发纠错提示' };
  }

  // 6. AI 已声明完成：todo 可能没同步，但 AI 的判断优先
  if (!bypass && c.taskDeclaredDone) {
    return { action: 'skip', reason: 'AI 已声明任务完成' };
  }

  // 7. 监督开关关闭
  if (!bypass && c.enabled === false) {
    return { action: 'skip', reason: '监督机制已关闭' };
  }

  // 8. 催促次数达上限（降频策略由调用方决定，这里只判定）
  if (!bypass) {
    const count = Number(c.count) || 0;
    const max = Number(c.max);
    if (Number.isFinite(max) && max > 0 && count >= max) {
      return { action: 'skip', reason: '已达催促上限 ' + max + ' 次' };
    }
  }

  return { action: 'nudge', reason: '满足全部催促条件' };
}

module.exports = { decide };
