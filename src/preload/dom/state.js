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
  // 发送延迟配置（毫秒）
  sendDelayMin: 2000,
  sendDelayMax: 4000,
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

  /** 打一次活动点（AI 响应、工具执行、发送消息时调用） */
  touch() { this.lastActivityAt = Date.now(); },
  /** 标记本会话执行过工具 + 打活动点 */
  markToolExecuted() { this.sessionHadToolExecution = true; this.lastActivityAt = Date.now(); },
  /** 会话切换/重置时清空任务型标记 */
  resetTaskFlags() { this.sessionHadToolExecution = false; this.lastActivityAt = Date.now(); },
};
