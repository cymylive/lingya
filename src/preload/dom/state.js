/**
 * preload 全局共享状态
 * 由原 preload.js 中的模块级变量拆分而来，各模块通过同一对象共享。
 */
module.exports = {
  initialPromptContent: '',
  // 是否有待发送的初始提示
  pendingInitialPrompt: false,
  // 待执行的工具调用
  pendingToolCall: null,
  // 首条消息兜底延迟（毫秒）：尚无思考历史时使用
  initialSendDelay: 1000,
  // ===== AI 思考耗时自适应延迟 =====
  // 思路：AI 思考越久说明负载越重，下一条消息就等越久再发，从根源避开频率风控。
  // 延迟 = max(兜底延迟, min(上次思考耗时 × thinkRatio, thinkMaxDelay))。
  // 上次思考耗时（毫秒）：本轮所有 AI 回复中最长的一次（不含工具回传后的快速回复）
  lastThinkMs: 0,
  // 上次请求发出时刻（毫秒时间戳）；0 表示无进行中的请求
  lastRequestStartAt: 0,
  // 延迟比例：思考 10 秒 → 等 2 秒 = 0.2
  thinkRatio: 0.2,
  // 延迟上限（毫秒）：防止思考很久时等得过长
  thinkMaxDelay: 60000,
  // ===== 双策略延迟 =====
  // 快请求（往返 ≤ adaptiveThreshold）用固定延迟 globalSendDelay
  // 慢请求（往返 > adaptiveThreshold）用思考耗时自适应（× thinkRatio，封顶 thinkMaxDelay）
  globalSendDelay: 3000,
  adaptiveThreshold: 20000,
  // 当前项目目录（null 表示未初始化）
  currentProjectDir: null,
  // 服务端返回的权威 token 统计（{ accumulatedTokens, insertedAt, updatedAt, modelType }）
  serverTokenUsage: null,
  // 最近一次 AI 回复的消息 id（{ requestMessageId, responseMessageId }）
  lastResponseMsgIds: null,
  // 用户是否点击了「停止」：为 true 时丢弃后续 AI 回复与工具结果，不再自动继续
  stopped: false,
  // 是否正在等待"用当前对话改写拒绝"的回复：为 true 时，下一条 AI 回复当作改写结果发出去
  awaitingRefusalRewrite: false,
  // 最近一次"活动"时间戳（AI 响应/工具执行/发送消息都会更新）。
  // 供停滞监督者判断"任务是否卡住"。
  lastActivityAt: Date.now(),
  // 本会话是否执行过工具（任务型会话标记），供监督者判断是否该催
  sessionHadToolExecution: false,
  // AI 最近一条回复是否在向用户提问/等决策。
  // 为 true 时：球在用户那边，自动续跑/监督者都应暂停催促（催也白催）。
  awaitingUserInput: false,
  // AI 是否已明确声明「任务已完成」。
  // 为 true 时：监督者不再催促（哪怕 todo 里还有未完成项 —— 那是 AI 判断不需要做的）。
  // 关键区别：todo 是 AI 自己写的计划，声明完成是 AI 对「工作是否结束」的最终判断，
  // 后者优先级更高。下次 AI 调用工具（markToolExecuted）时自动复位。
  taskDeclaredDone: false,
  // awaitingUserInput 置位的时刻。监督者用它在「等太久且计划未完成」时判定为误判，强制催。
  awaitingUserInputAt: 0,

  /** 打一次活动点（AI 响应、工具执行、发送消息时调用） */
  touch() { this.lastActivityAt = Date.now(); },
  /** 标记本会话执行过工具 + 打活动点。有新工具执行 = 任务又开始了，清掉「已声明完成」 */
  markToolExecuted() {
    this.sessionHadToolExecution = true;
    this.taskDeclaredDone = false;   // 新一轮工作开始，之前的「完成」声明失效
    this.lastActivityAt = Date.now();
  },
  /** 会话切换/重置时清空任务型标记 */
  resetTaskFlags() { this.sessionHadToolExecution = false; this.lastActivityAt = Date.now(); },
};
