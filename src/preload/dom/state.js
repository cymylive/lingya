/**
 * preload 全局共享状态
 * 由原 preload.js 中的模块级变量拆分而来，各模块通过同一对象共享。
 */
module.exports = {
  initialPromptContent: '',
  // 是否有待发送的初始提示
  pendingInitialPrompt: false,
  // 分批发送初始提示：待发分段数组（null 表示不是分批模式）
  initialPromptChunks: null,
  // 当前正在发送第几段（0-based）
  initialPromptChunkIndex: 0,
  // 本批次已实际发出的段索引集合（Set<number>），用于幂等防护。
  // 曾出现「## 工具使用指导」段被发送两次：组装层确认只出现 1 次，
  // 是发送层重复 —— sendNextInitialPromptChunk 与 waitForInitialPromptAndSend
  // 的轮询可能同时拿到输入框、各自发起一次发送。用这个集合兜住。
  initialPromptSentChunks: null,
  // 分批模式下：已发完一段，正等本轮回复结束后发下一段。
  // 为 true 时暂停自动发送，否则会和分批发送抢着发消息。
  awaitingNextInitialChunk: false,
  // 分批暂缓计数：AI 连续回复都含工具调用时，「等它干完再发下一段」可能永远等不到。
  // 累计到阈值（次数或时长）就强制把剩余段合并发出，避免整条 Agent 循环被永久屏蔽。
  initialChunkDeferCount: 0,
  // 首次暂缓的时刻（毫秒时间戳），0 表示未暂缓
  initialChunkDeferAt: 0,
  // 待执行的工具调用
  pendingToolCall: null,
  // 最近一次用户发出的原始消息（用于本地规则改写 / 拒绝兜底）
  lastUserMessage: '',
  lastUserMessageAt: 0,
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
  // 快请求（往返 ≤ adaptiveThreshold）在 [globalSendDelayMin, globalSendDelayMax] 闭区间内随机
  // 慢请求（往返 > adaptiveThreshold）用思考耗时自适应（× thinkRatio，封顶 thinkMaxDelay）
  // 保留 globalSendDelay 供旧代码/旧配置兼容，快请求分支已不再直接读取它
  globalSendDelay: 3000,
  // 快请求延迟区间（双策略模式下使用）
  globalSendDelayMin: 4000,
  globalSendDelayMax: 10000,
  // 【2026-11-01 拆分】均匀随机模式的独立区间（与双策略的快请求区间分开存储，互不影响）
  uniformDelayMin: 4000,
  uniformDelayMax: 10000,
  // 【2026-11-01 恢复】延迟模式：'uniform'（均匀随机，默认）| 'dual'（双策略，原版）
  sendDelayMode: 'uniform',
  // 【2026-11-01 新增】长消息分流阈值：消息长度 > 此值 → 转 .md 附件上传；≤ 此值 → 直接输入框输入
  // 默认 200（约 100 个汉字），可在「设置 → 发送延迟」中自定义
  uploadThreshold: 200,
  // 【封号风险改造 2026-11-01】系统消息（工具回传/压缩/重命名/远程 IM）延迟区间。
  // 原实现大量调用方硬编码 fixedDelay=300，节拍完全固定 → 机器指纹。
  // 现统一改为 [systemMsgDelayMin, systemMsgDelayMax] 随机。
  systemMsgDelayMin: 1500,
  systemMsgDelayMax: 4000,
  // 【封号风险改造 2026-11-01】限流冷静期截止时间戳（毫秒）；0 表示不在冷静期。
  // 由 rate-limit-retry.js 在收到 lingya-ai-error(reason=rate_limit) 时设置，
  // doSendToChat 开头检查此字段，> now 时丢弃自动发送。
  rateLimitUntil: 0,
  adaptiveThreshold: 20000,
  // 当前项目目录（null 表示未初始化）
  currentProjectDir: null,
  // 服务端返回的权威 token 统计（{ accumulatedTokens, insertedAt, updatedAt, modelType }）
  // 语义：始终代表「当前会话」的值，供 events.js 直接读取，不需要感知会话。
  serverTokenUsage: null,
  // 【token 按会话隔离】按 sessionId 缓存每个会话最后一次的 token 统计。
  // 键：sessionId，首页/新会话用 '__home__'。写入见 intercept-observer 的 response 回调，
  // 会话切换时由 watchSessionForStateReset 的 check() 把当前会话的值搬回 serverTokenUsage。
  // 只在内存里（刷新后清空，各会话等下次响应恢复），不落 localStorage。
  serverTokenUsageBySession: {},
  // 【token 基线偏移】按 sessionId 记录「历史注入完成时的 token 数」，
  // 显示和阈值判定都用 Math.max(0, accumulated - baseline)，让新会话从 0 开始算。
  // 键：sessionId。持久化时与 serverTokenUsageBySession 一起存 TOKEN_CACHE_KEY。
  tokenBaselineBySession: {},
  // 最近一次 AI 回复的消息 id（{ requestMessageId, responseMessageId }）
  lastResponseMsgIds: null,
  // 【2026-10-30 拟人延迟】最近一次 AI 回复的字符数（正文 + 思考）。
  // 用于让「下一条消息的发送延迟」与「刚读过的内容量」正相关 —— 真人读得越久等得越久。
  // 由 intercept-observer 在收到回复时写入，chat-input 计算延迟时读取。
  lastResponseLen: 0,
  // humanizeDelay 已移除（因严重影响长文本发送体验）
  // 是否正在执行会话迁移（防爆锁）
  isMigrating: false,
  // 用户是否点击了「停止」：为 true 时丢弃后续 AI 回复与工具结果，不再自动继续
  stopped: false,
  // 点「停止」的时刻。用于判断「停止后收到的新回复」是否该自动恢复执行
  // （见 intercept-observer 的 processInterceptedResponse 兜底逻辑）
  stoppedAt: 0,
  // 是否正在等待"用当前对话改写拒绝"的回复：为 true 时，下一条 AI 回复当作改写结果发出去
  awaitingRefusalRewrite: false,
  // 最近一次"活动"时间戳（AI 响应/工具执行/发送消息都会更新）。
  lastActivityAt: Date.now(),
  // 本会话是否执行过工具（任务型会话标记）
  sessionHadToolExecution: false,
  // 当前正在执行的工具/JS 脚本数量（并发计数，> 0 表示有工具在跑）。
  // 工具执行期间 lastActivityAt 不再更新，插件据此判断「不是停滞，是在干活」。
  activeToolCount: 0,
  // AI 最近一条回复是否在向用户提问/等决策。
  awaitingUserInput: false,
  // AI 是否已明确声明「任务已完成」。下次 AI 调用工具（markToolExecuted）时自动复位。
  taskDeclaredDone: false,
  // awaitingUserInput 置位的时刻。
  awaitingUserInputAt: 0,
  // initializationDone：systemPrompt 全部分段已发送完毕
  initializationDone: false,
  // userTaskStarted：用户发过至少一条真实消息（非 auto 工具回传）。
  // 会话切换时重置（见 intercept-observer 的 watchSessionForStateReset）。
  userTaskStarted: false,
  // 当前会话 ID（由 intercept-observer 的会话切换监听更新）。
  // 为空表示还在首页（新对话尚未生成 URL）。
  currentSessionId: null,
  // 是否为「强等待」：AI 明确列出多个方案让用户挑（A./B. 列表、「你有两个选项」等）。
  awaitingUserInputStrong: false,
  // 最近一次实际使用的发送方式（用于界面显示，排查发送链路）：
  // 'provider-native' 站点原生 / 'trusted-click' 可信点击发送按钮 /
  // 'trusted-enter' 可信回车 / 'failed' 全部失败
  lastSendMethod: '',

  /** 打一次活动点（AI 响应、工具执行、发送消息时调用） */
  touch() { this.lastActivityAt = Date.now(); },
  /** 工具开始执行：计数 +1 并打活动点 */
  beginToolExec() {
    this.activeToolCount = (this.activeToolCount || 0) + 1;
    this.lastActivityAt = Date.now();
  },
  /** 工具执行结束：计数 -1（不落到负数）并打活动点 */
  endToolExec() {
    this.activeToolCount = Math.max(0, (this.activeToolCount || 0) - 1);
    this.lastActivityAt = Date.now();
  },
  /** 标记本会话执行过工具 + 打活动点。有新工具执行 = 任务又开始了，清掉「已声明完成」 */
  markToolExecuted() {
    this.sessionHadToolExecution = true;
    this.taskDeclaredDone = false;   // 新一轮工作开始，之前的「完成」声明失效
    this.lastActivityAt = Date.now();
  },
  /** 会话切换/重置时清空任务型标记 */
  resetTaskFlags() { this.sessionHadToolExecution = false; this.lastActivityAt = Date.now(); },
};
