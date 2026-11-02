/**
 * DeepSeek 拦截模式下的回复处理器（隔离世界）
 * 监听主世界注入的 'lingya-ai-response' 事件，收到完整回复后走与 DOM 模式
 * 相同的工具调用/JS 代码块处理流程。
 */
const { extractJsToolBlocks, BT } = require('./js-detector');
const { tryParseToolCall } = require('./tool-parser');
const { handleToolCall, handleJsToolScript } = require('./tool-executor');
const { sendToolResultToChat, sendCombinedJsResultsToChat, sendMessageToChat } = require('./chat-input');
const { setFabState, getFabState, setStopped, markTaskDone } = require('../overlay/ui');
const { hasTool, toolNamesList } = require('../tool-names');
const state = require('./state');
const taskState = require('./task-state');

// ===== token 按会话缓存的持久化（localStorage）=====
// 为什么需要：state.serverTokenUsageBySession 只在内存，关闭 LingYa 后丢失，
// 重新打开同一对话时悬浮球显示 0（用户实测反馈）。
// 为什么整体序列化成一个键：写入只在收到 AI 响应时发生（每轮一次），全量序列化开销可忽略；
// 集中一个键便于清理和排查，不用遍历 localStorage 找前缀。
const TOKEN_CACHE_KEY = 'lingya-token-by-session';

/** 从 localStorage 读取 token 缓存；脏数据一律丢弃。
 *  返回 { usage: {sid: tokenUsage}, baseline: {sid: number} }。
 *  兼容旧格式：旧版直接是 { sid: tokenUsage } 扁平对象，没有 usage 包装。 */
function loadTokenCache() {
  try {
    const raw = localStorage.getItem(TOKEN_CACHE_KEY);
    if (!raw) return { usage: {}, baseline: {} };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { usage: {}, baseline: {} };
    // 新版：有 usage / baseline 两个字段
    const hasNewShape = obj.usage && typeof obj.usage === 'object';
    const srcUsage = hasNewShape ? obj.usage : obj;   // 旧格式时整个 obj 就是 usage
    const usage = {};
    for (const k of Object.keys(srcUsage)) {
      const v = srcUsage[k];
      if (v && typeof v === 'object' && typeof v.accumulatedTokens === 'number') usage[k] = v;
    }
    const baseline = {};
    if (obj.baseline && typeof obj.baseline === 'object') {
      for (const k of Object.keys(obj.baseline)) {
        if (typeof obj.baseline[k] === 'number' && isFinite(obj.baseline[k])) baseline[k] = obj.baseline[k];
      }
    }
    return { usage, baseline };
  } catch (_) { return { usage: {}, baseline: {} }; }
}

/** 把 token 缓存写回 localStorage；配额不足/隐私模式时静默降级，绝不影响功能。
 *  保存 { usage, baseline } 两块。旧调用方只传 usage 时也能兼容（兜底读 state）。 */
function saveTokenCache(usageMap) {
  try {
    const usage = usageMap || state.serverTokenUsageBySession || {};
    const baseline = state.tokenBaselineBySession || {};
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ usage, baseline }));
  } catch (_) { /* QuotaExceeded / 禁用存储 → 仅内存生效 */ }
}
const { detectXmlFormat } = require('./xml-detect');
const { shouldPreempt, preemptPreviousRun } = require('./intercept-preempt');

const MAX_JS_RETRY = 3;
// 连续 XML 提示次数（防止无限循环）
let xmlHintCount = 0;
const XML_HINT_MAX = 10;
// 上次已处理的文本（去重，防同一条回复重复处理）
let lastProcessedText = '';
// 最近一次拦截到的完整回复文本（供手动解析复用，不依赖 DOM）
let lastInterceptedText = '';

// 处理链异常兜底：processInterceptedResponse 执行中抛异常（工具/JS 执行崩溃等）时，
// 原实现只打一行日志就吞掉 —— 不回传、不重试、不催促，用户看到的是「AI 说完就没下文」。
// 现在改为把错误回传给 AI 让其重试。独立计数 + 时间窗口，防止异常本身导致死循环。
// 注：声明必须放在 enqueueProcessing 之前（函数体内引用这些变量）。
let queueErrorContinueCount = 0;
let lastQueueErrorContinueAt = 0;
const QUEUE_ERROR_WINDOW_MS = 180000;
const QUEUE_ERROR_MAX = 3;

// 串行化处理队列：processInterceptedResponse 可能因工具/JS 脚本执行耗时数十秒，
// 期间若又有 lingya-ai-response 事件到达（用户手动发消息、页面重试等），
// 事件监听器不会等待前一个 async 完成 → 并发重入，导致状态错乱、回复丢失。
// 用 Promise 链把处理强制串行，后到的事件排队执行。
// 队列等待告警阈值：超过这么久才轮到执行，说明前面有长任务堵住了。
// 典型场景：bashOutput 的 wait 很长，导致后续回复全部排队、UI 无反馈。
const QUEUE_WAIT_WARN_MS = 180000; // 3 分钟

// 分批发送初始提示时，AI 连续回复都含工具调用导致「等它干完再发下一段」一直等不到。
// 累计到下列阈值（先到者为准）就放弃分段，把剩余段合并成一条发出 ——
// 提示词晚一点到不影响正确性，但让整条 Agent 循环被永久屏蔽是致命的。
const INITIAL_CHUNK_DEFER_MAX = 3;              // 连续暂缓次数上限
const INITIAL_CHUNK_DEFER_TIMEOUT_MS = 90000;   // 或累计暂缓时长上限（90 秒）

let processingChain = Promise.resolve();
// 队列繁忙标记：当前是否有任务正在执行（不含「排队等待中」的那些）。
// UI 与监督者据此区分「真的在处理」和「还在排队」——
// 队列被长任务堵住时，状态机停在 RESPONDED，看起来像「解析卡住」，
// 实际是「还没轮到解析」。不区分会导致误判与误提示。
let queueBusy = false;
let queueDepth = 0;

/** 当前队列状态（供 UI / 监督者查询） */
function getQueueState() {
  return { busy: queueBusy, depth: queueDepth };
}

function enqueueProcessing(taskFn) {
  const enqueuedAt = Date.now();
  queueDepth++;
  // 入队即标记：此时回复已到但还没轮到处理，UI 应显示「排队等待」而非「正在解析」
  try { taskState.setQueued(queueDepth > 0); } catch (_) {}
  processingChain = processingChain.then(() => {
    queueDepth--;
    queueBusy = true;
    // 轮到自己了 → 不再是「排队」，如实标记为「正在处理」。
    //
    // 【为什么不写 setQueued(queueDepth > 0)】
    // queued 是全局单值，但队列里可能有多个任务。若用 queueDepth 判断，
    // 「A 正在解析 + B 已入队」时会把 queued 置 true —— 状态机是 A 的，
    // UI 会误说「A 在排队」，实际排队的是 B。状态机单例无法区分是谁。
    // 解析是毫秒级、几乎瞬间过渡，这个歧义在实践中影响可忽略；
    // 但语义上「我已在执行」就该是 false，不要用别人的状态污染自己。
    try { taskState.setQueued(false); } catch (_) {}
    // 实际轮到执行时，先报告等了多久 —— 队列阻塞必须可见，不能静默
    const waited = Date.now() - enqueuedAt;
    if (waited > QUEUE_WAIT_WARN_MS) {
      console.warn('[LingYa][拦截] ⚠️ 处理队列阻塞：本条回复排队等待了 ' +
        Math.round(waited / 1000) + 's 才开始处理（阈值 ' +
        Math.round(QUEUE_WAIT_WARN_MS / 1000) + 's）。' +
        '常见原因：上一条回复里有耗时很长的工具（如 bashOutput 的长等待）。' +
        '期间 AI 新输出的代码块都不会被执行，UI 也不会有反应。');
    }
    return taskFn();
  }).finally(() => {
    queueBusy = false;
  }).catch((err) => {
    console.error('[LingYa][拦截] 队列处理出错:', err);
    // 异常不能让任务静默死掉：把错误回传给 AI，让它知道发生了什么并重试。
    // 注意：本 catch 内部必须再包 try/catch —— 若异常本身就来自 sendMessageToChat，
    // 直接调用会再次抛出，导致「异常 → 发送 → 再异常」的死循环。
    try {
      if (state.stopped) return;               // 用户已停止，不打扰

      const now = Date.now();
      if (now - lastQueueErrorContinueAt > QUEUE_ERROR_WINDOW_MS) queueErrorContinueCount = 0;
      lastQueueErrorContinueAt = now;
      if (queueErrorContinueCount >= QUEUE_ERROR_MAX) {
        console.log('[LingYa][拦截] 队列异常已连续 ' + queueErrorContinueCount + ' 次（上限 ' + QUEUE_ERROR_MAX + '），停止自动重试');
        return;
      }
      queueErrorContinueCount++;

      const detail = (err && err.message) ? String(err.message).slice(0, 500) : String(err || '未知错误');
      console.log('[LingYa][拦截] 队列异常第 ' + queueErrorContinueCount + ' 次，回传错误并催 AI 重试');
      sendMessageToChat(
        '刚才那步出错了：' + detail + '\n\n接着往下做，先看看上一步是不是已经生效，别重复做。全做完了跟我说“完成了”。',
        '队列异常重试',
        { auto: true }
      );
    } catch (innerErr) {
      console.error('[LingYa][拦截] 异常兜底本身失败（已忽略，防死循环）:', innerErr && innerErr.message);
    }
  });
  return processingChain;
}
// "AI 生成中" 超时兜底定时器（防止 finish 事件丢失导致状态卡死）
let generateTimeout = null;
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;

const DONE_HINT_RE = /(任务已?完成|全部完成|所有(任务|步骤)?(已|都)?完成|均已?完成|(没有|无)(其它|其他|剩余)?(需要|待办|要做)|无需继续|nothing (else )?to do|task (is )?complete)/i;


/**
 * 判断 AI 的纯文本回复是否在"向用户提问 / 等用户决策"。
 * 命中时不应自动续跑 —— 球在用户那边，AI 需要的是答案而非"继续"。
 *
 * 返回 { matched, strong }：
 *   matched — 是否在等用户
 *   strong  — 是否「强等待」：AI 明确列出多个方案让用户挑，
 *             这种等多久都合理，supervisor 不应超时催促。
 *
 * 信号分层：
 *   弱（3 分钟超时后会被催）：结尾问号、模糊征询词
 *   强（不催，等到用户回复）：选项结构（A./B. 列表、「你有两个选项」、「方案一/二」）
 *
 * 【为什么需要强等待】
 * 曾出现：AI 回复「现在你有两个选项 / A. ... / B. ...」等用户挑，
 * 但该回复没有问号、结尾是列表末项，旧规则全部漏判 → 监督者 120 秒后
 * 判定「停滞」并催促 → AI 自己随便选了一个继续跑，用户失去了决策权。
 */
function looksLikeUserQuestion(raw) {
  return judgeUserWait(raw).matched;
}

/** 是否「强等待」（选项式，不应超时催促） */
function looksLikeStrongUserWait(raw) {
  return judgeUserWait(raw).strong;
}

function judgeUserWait(raw) {
  const text = String(raw || '').trim();
  if (!text) return { matched: false, strong: false };

  // ===== 1) 选项结构（强信号，先判 —— 这类回复通常没有问号）=====
  // 剥掉代码块，避免把示例代码里的 A. B. 当选项
  const noCode = text.replace(/```[\s\S]*?```/g, '');

  // 1a) 选项标题词
  if (/(你有\s*[两二三四2-4]\s*个?选项|两个选项|几个选项|以下选项|以下方案|几种方案|两种方案|两个方案|从中选|任选一|选一个|选择一个|挑一个|你更倾向|你想先)/i.test(noCode)) {
    return { matched: true, strong: true };
  }

  // 1b) 行首字母选项：A. / B. / A) / B）（至少 2 个不同字母）
  //     排除 Markdown 有序列表（1. 2.），只认字母，降低误判
  const letterOpts = noCode.match(/^[ \t]*([A-Da-d])\s*[.．、)）]\s*\S/gm) || [];
  const letters = new Set(letterOpts.map((s) => s.trim()[0].toUpperCase()));
  if (letters.size >= 2) return { matched: true, strong: true };

  // 1c) 中文/数字方案并列：方案一 / 方案二
  const cnOpts = noCode.match(/^[ \t]*(?:方案|选项)\s*[一二三四1-4]/gm) || [];
  if (cnOpts.length >= 2) return { matched: true, strong: true };

  // ===== 2) 结尾问号 =====
  const tailShort = text.slice(-100);
  if (/[?？]\s*$/.test(tailShort)) return { matched: true, strong: false };

  // ===== 3) 征询/等待句式：扫最后 300 字符 =====
  // 原实现扫 150 字符，选项说明较长时关键词会被挤出窗口
  const tail = text.slice(-300);

  if (/(选哪个|选哪一|请你选择|请你确认|请你决定|你希望我|需要我继续吗|是否要我|是否继续|告诉我你|等你回复|等你确认|等你答复|由你决定|方案\s*[A-D])/i.test(tail)) {
    return { matched: true, strong: false };
  }
  if (/(告诉我即可|告诉我一声|由你拍板|等你指示|听你的|你来选|你来定|回复我|发我|确认后|确认一下|可以就|说一声)/i.test(tail)) {
    return { matched: true, strong: false };
  }

  return { matched: false, strong: false };
}

function looksLikeIncompleteCodeError(error) {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行 JS 代码块，遇到"代码不完整"错误时自动重试。
 * 拦截模式下文本已完整（finished），无需重新提取，简单重试执行即可。
 */
async function executeJsBlocksWithRetry(blocks) {
  let results = [];
  for (let attempt = 0; attempt <= MAX_JS_RETRY; attempt++) {
    results = [];
    for (const code of blocks) {
      const r = await handleJsToolScript(code);
      if (r) results.push(r);
    }
    const hasIncompleteFailure = results.some(
      (item) => item && item.result && !item.result.success && looksLikeIncompleteCodeError(item.result.error)
    );
    if (!hasIncompleteFailure) break;
    if (attempt < MAX_JS_RETRY) await sleep(1000);
  }
  return results;
}



/**
 * XML/DSML 格式错误检测与纠错提示。
 *
 * 【为什么抽成函数】改造前这段逻辑只在「正常完成」路径里跑，
 * 「中断」路径（interrupted === true）完全跳过它，直接去催「接着做」——
 * 用户实测：AI 输出 DSML 被判定为流中断，收到的却是催促而不是纠错提示。
 * 抽出来后两条路径共用，顺序问题从根上消失。
 *
 * @param {string} raw 本轮 AI 回复全文
 * @returns {boolean} true 表示已处理（发了纠错提示或已达上限），调用方应 return
 */
// 【2026-11-01 对齐 Cuckoo】XML 拦截正则/提示语可从设置面板配置
const INTERCEPT_PATTERNS_KEY = 'lingya-ai-intercept-patterns';
const INTERCEPT_PROMPT_KEY = 'lingya-ai-intercept-prompt';
const { compileCustomPatterns } = require('./xml-detect');

const DEFAULT_INTERCEPT_PROMPT = '请使用 lingya 代码块进行工具调用，不要使用 XML invoke 格式。';

/** 读用户配置的拦截正则（已编译）。空配置 → 只走内置正则。 */
function getCustomInterceptPatterns() {
  try {
    const raw = localStorage.getItem(INTERCEPT_PATTERNS_KEY) || '';
    if (!raw.trim()) return [];
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return compileCustomPatterns(lines);
  } catch (_) { return []; }
}

/** 读用户配置的拦截提示语（空 → 用默认） */
function getInterceptPrompt() {
  try {
    const p = localStorage.getItem(INTERCEPT_PROMPT_KEY);
    return (p && p.trim()) ? p.trim() : DEFAULT_INTERCEPT_PROMPT;
  } catch (_) { return DEFAULT_INTERCEPT_PROMPT; }
}

function checkXmlFormatAndCorrect(raw) {
  const customPatterns = getCustomInterceptPatterns();
  if (!detectXmlFormat(raw, customPatterns)) return false;

  if (xmlHintCount >= XML_HINT_MAX) {
    console.log('[LingYa][拦截] 已连续提示 ' + xmlHintCount + ' 次 XML 格式，停止发送');
    try {
      const { showToast } = require('../overlay/ui');
      if (showToast) showToast('AI 连续 ' + XML_HINT_MAX + ' 次使用 XML 格式调用工具，已停止自动纠正。请手动发一条消息让它改用 lingya 代码块。', 8000);
    } catch (_) {}
    return true;
  }
  xmlHintCount++;
  console.log('[LingYa][拦截] 检测到 XML/DSML 格式工具调用（第 ' + xmlHintCount + ' 次提示，自定义正则 ' + customPatterns.length + ' 条）');

  // 用用户配置的提示语；如果用户没配，用默认（Cuckoo 风格简短提示）
  const customPrompt = getInterceptPrompt();
  const useDefaultDemo = !localStorage.getItem(INTERCEPT_PROMPT_KEY) || !localStorage.getItem(INTERCEPT_PROMPT_KEY).trim();
  let prompt;
  if (useDefaultDemo) {
    // 默认提示：带示例
    const nl = String.fromCharCode(10);
    prompt = '格式写错了，用 ' + BT + BT + BT + 'lingya' + BT + BT + BT + ' 包起来，不要用 XML。' + nl + nl +
      '像这样：' + nl +
      BT + BT + BT + 'lingya' + nl +
      'const out = await bashOutput("TASK_ID", { wait: 60000 });' + nl +
      'log(out);' + nl +
      BT + BT + BT;
  } else {
    prompt = customPrompt;
  }
  sendMessageToChat(prompt, 'XML工具调用提示', { auto: true });
  return true;
}



/**
 * 处理一条已完成的 AI 回复文本
 * @param {string} text 完整回复文本（Markdown 原文）
 * @param {boolean} [force] 为 true 时跳过去重（手动解析重新执行同一条时使用）
 */
async function processInterceptedResponse(text, force, interrupted) {
  state.touch(); // 任何 AI 回复到达 = 有活动
  state.awaitingUserInput = false; // 新回复到达 → 说明用户已交互，清除等待标志
  state.awaitingUserInputAt = 0;
  state.awaitingUserInputStrong = false;
  const raw = (text || '').trim();
  // 用户已点停止：丢弃本次回复，不执行任何工具、不回传结果
  //
  // 【兜底】stopped 的正常清除路径是 'lingya-ai-start' 监听器（用户发新消息即恢复）。
  // 但该事件依赖主世界 hook 成功注入并正确匹配 completion 请求——hook 失效时事件不来，
  // stopped 就会永久卡住，表现为「用户发了消息，AI 也回复了，但工具永远不执行」。
  // 这里加一道基于「回复内容非空 + 距停止已过 30 秒」的兜底：能收到非空回复本身
  // 就证明用户主动发起了新一轮对话（不是程序自动续跑，那些在 stopped 下会被丢弃）。
  if (state.stopped) {
    const sinceStop = Date.now() - (state.stoppedAt || 0);
    if (raw && sinceStop > 30000) {
      console.log('[LingYa][拦截] 停止已 ' + Math.round(sinceStop / 1000) +
        's 且收到新回复，判定用户已重新发起对话 → 自动恢复执行');
      state.stopped = false;
      state.stoppedAt = 0;
      try { window.electronAPI.clearAbort(); } catch (_) {}
      try { setStopped(false); } catch (_) {}
    } else {
      console.log('[LingYa][拦截] 已停止，丢弃本次回复（距停止 ' +
        Math.round(sinceStop / 1000) + 's）');
      return;
    }
  }
  // 统一去重（同一文本只处理一次，除非 force）
  if (raw && !force && raw === lastProcessedText) return;
  if (raw) lastProcessedText = raw;

  // 优先提取并执行 JS 工具代码块：即使流被中断（服务端已停止/流断开），
  // 已完整输出的 lingya 代码块仍应执行——否则 AI 输出了工具调用却不生效，
  // 表现为"工具调用变成纯文本"。
  const jsBlocks = extractJsToolBlocks(raw);
  if (jsBlocks.length > 0) {
    console.log('[LingYa][拦截] 检测到 JS 工具代码块（' + jsBlocks.length + ' 个）' +
      (interrupted ? '（流中断，仍执行）' : '') + '，开始执行');
    xmlHintCount = 0;
    queueErrorContinueCount = 0; // 链路正常，重置异常兜底预算
    state.markToolExecuted(); // 本会话已执行过工具 → 允许无计划兜底续跑
    // 抢占后立刻清掉排队态：本条回复马上要执行工具，面板必须显示执行态
    // 而不是「排队等待处理」，否则用户看到的仍是卡住的旧症状。
    try { taskState.setQueued(false); } catch (_) {}
    // 状态机：进入工具执行阶段（超时阈值 720s，覆盖 JsRunner 的 660s deadline）
    try { taskState.transition(taskState.STATES.EXECUTING); } catch (_) {}
    // 【Harness 2026-11-02】把实际执行的 JS 代码传给监听器，供 harness 显示工具名和参数
    const combinedCode = jsBlocks.join(String.fromCharCode(10) + String.fromCharCode(10));
    emitToolCall({ phase: 'start', code: combinedCode });
    const results = await executeJsBlocksWithRetry(jsBlocks);
    // 结果拼成文本传给 end 事件
    let endOutput = '';
    let endSuccess = false;
    try {
      const outLines = [];
      for (const r of (results || [])) {
        if (r && r.result) {
          if (r.result.success) {
            endSuccess = true;
            const d = r.result.data;
            outLines.push(typeof d === 'string' ? d : JSON.stringify(d));
          } else {
            outLines.push('❌ ' + (r.result.error || '失败'));
          }
        }
      }
      endOutput = outLines.join(String.fromCharCode(10) + String.fromCharCode(10));
    } catch (_) {}
    emitToolCall({ phase: 'end', success: endSuccess, output: endOutput, code: combinedCode });
    if (results.length > 0) {
      if (state.stopped) {
        console.log('[LingYa][拦截] 已停止，丢弃 JS 结果回传');
      } else {
        sendCombinedJsResultsToChat(results);
      }
    }
    return;
  }

    // 中断（服务端已停止/流断开）处理：已完整输出的 JS 代码块在上方已执行，
  // 此处仅做格式纠错 / 用户等待判断，其余中断内容直接丢弃。
  if (interrupted) {
    console.log('[LingYa][拦截] 检测到生成中断（服务端已停止/流断开），raw 长度=' + raw.length);
    if (raw && checkXmlFormatAndCorrect(raw)) return;
    if (raw) {
      const waitJudge = judgeUserWait(raw);
      if (waitJudge.matched) {
        state.awaitingUserInput = true;
        state.awaitingUserInputAt = Date.now();
        state.awaitingUserInputStrong = waitJudge.strong;
        try { taskState.reset('AI 在向用户提问（中断路径）'); } catch (_) {}
        try { markTaskDone(); } catch (_) {}
        return;
      }
    }
    console.log('[LingYa][拦截] 生成中断，丢弃中断内容');
    // 【状态收口】中断分支提前 return，后续没有任何代码会把状态推走。
    // 若不在这里复位，状态机会永久停在 RESPONDED，UI 显示「正在解析回复」永不消失
    //（2026-10-28 实测：detail.text 为空 + 无代码块 → 卡 3 分钟以上）。
    try { taskState.reset('回复中断且无可执行内容'); } catch (_) {}
    return;
  }
  if (!raw) {
    // 同上：空回复不构成「正在解析」，复位避免状态泄漏。
    try { taskState.reset('收到空回复'); } catch (_) {}
    return;
  }

  console.log('[LingYa][拦截] 收到完整回复，长度=' + raw.length);

  // 状态机：收到回复 → RESPONDED（后续若有工具执行会切 EXECUTING）
  try {
    taskState.transition(taskState.STATES.RESPONDED, {
      lastResponsePreview: raw.slice(0, 120),
    });
  } catch (_) { /* ignore */ }

  // 正常完成：清空续写计数



  // 1. JSON 工具调用
  const toolCall = tryParseToolCall(raw);
  if (toolCall) {
    xmlHintCount = 0;
    state.markToolExecuted(); // 本会话已执行过工具 → 允许无计划兜底续跑
    try { taskState.transition(taskState.STATES.EXECUTING); } catch (_) {}
    if (!hasTool(toolCall.toolName)) {
      console.log('[LingYa][拦截] 工具不存在: ' + toolCall.toolName);
      sendToolResultToChat(
        toolCall,
        { success: false, error: '工具 ' + toolCall.toolName + ' 不存在，可用工具: ' + toolNamesList() }
      );
      return;
    }
    console.log('[LingYa][拦截] 工具存在: ' + toolCall.toolName + ', 开始执行');
    emitToolCall({ phase: 'start', toolName: toolCall.toolName });
    await handleToolCall(toolCall);
    emitToolCall({ phase: 'end', toolName: toolCall.toolName });
    return;
  }

  // 3. XML / DSML 格式工具调用提示
  //
  // 【历史 BUG】原实现三个正则全部失效，导致 AI 输出 DSML 格式时静默丢弃、Agent 循环停摆：
  //   hasAntmlXml  = /^<\s*｜｜DSML｜｜/   —— ^ 锚定开头，AI 只要前面说一句"让我重试"就不匹配
  //   hasXmlInvoke = /<\s*[\w-]*:?invoke\s+name=/ —— 只认 <invoke>/<antml:invoke>，
  //                                                  不认 ｜｜DSML｜｜ invoke（中间是竖线不是冒号）
  //   hasXmlParam  = 同上，也不认 ｜｜DSML｜｜ parameter
  // 结果：条件恒为 false → 不提示 → 不执行 → 用户看到"AI 不说话了"。
  //
  // 修复：只要出现 DSML 特征串就判定，同时保留标准 <invoke> 的检测作为兜底。
  //
  // 【2026-10-24 二次修复】AI 有时输出半角竖线带空格的变体：
  //   < | DSML | | invoke>       ← 单竖线 + 空格
  //   < | DSML | | parameter>    ← 同上
  // 原正则 /｜｜\s*DSML\s*｜｜/ 要求两个全角竖线紧邻，全部漏判 →
  // XML 文本被当普通回复放过，Agent 静默停摆（用户截图实测）。
  //
  // 新正则：竖线 [｜|] 允许 1~2 个、中间可有空格；
  //         invoke/parameter 前允许任意非 > 字符（容忍 < | DSML | | invoke> 这种）。
  // 具体检测与提示逻辑见 checkXmlFormatAndCorrect（与中断路径共用）
  if (checkXmlFormatAndCorrect(raw)) return;

    // 4. 纯文本回复：交由插件拦截（如拒绝改写）
  try {
    const handled = await require('../plugin-api').tryIntercept(raw);
    if (handled) return;
  } catch (err) {
    console.error('[LingYa][拦截] 插件拦截处理出错:', err);
  }

  // 5. 普通文本回复：先判断 AI 是否在向用户提问（等决策）——
  //    若是，球在用户那边，本轮不催、不判完成，等用户回答。
  const waitJudge = judgeUserWait(raw);
  if (waitJudge.matched) {
    state.awaitingUserInput = true;
    state.awaitingUserInputAt = Date.now();
    state.awaitingUserInputStrong = waitJudge.strong;
    console.log('[LingYa][拦截] 检测到 AI 在向用户提问（' +
      (waitJudge.strong ? '强等待：选项式，不超时催促' : '弱等待：3 分钟后可能被判误判') +
      '），暂停自动续跑');
    // 状态机回 IDLE：球在用户那边，本轮循环已正常结束。
    // 防误催由 state.awaitingUserInput 负责（supervisor 会先检查它）。
    try { taskState.reset('AI 在向用户提问'); } catch (_) {}
    try { markTaskDone(); } catch (_) { /* 显示为待交互 */ }
    // 【Harness 2026-11-02】任务空闲信号（AI 在等用户）
    try { emitTaskIdle(); } catch (_) {}
    return;
  }
  // 计划已完成 / 本就无计划 → 收尾
  console.log('[LingYa][拦截] 正常文本回复，未检测到工具调用，且无未完成计划');

  // 【关键】AI 明确说「任务已完成」→ 清掉任务型标记，阻止 supervisor 无计划兜底误催。
  //
  // 为什么必须在这里做：supervisor 的无计划兜底只查 state（拿不到 raw 文本），
  // 它看到「sessionHadToolExecution=true + 状态机 IDLE」就会催。
  // 而 sessionHadToolExecution 一旦置 true 就永不复位 —— 导致 AI 说完"任务已完成"
  // 之后，每轮空闲都会被催一次（用户反馈：计划 7/7 完成 + AI 说完成，还在催）。
  // 在这里按 raw 判断后复位，supervisor 就认为这不是任务型会话，自然不催。
  // 后续用户发新任务时，markToolExecuted() 会重新置 true，不受影响。
  if (raw && DONE_HINT_RE.test(String(raw))) {
    try { state.resetTaskFlags(); } catch (_) {}
    // 置位「已声明完成」标记：supervisor 看到就不再催（哪怕 todo 里还有未完成项）。
    // 下次 AI 调工具时 markToolExecuted() 会自动复位。
    try { state.taskDeclaredDone = true; } catch (_) {}
    console.log('[LingYa][拦截] AI 已声明任务完成，置位 taskDeclaredDone（停止所有监督兜底）');
  }

  // 状态机回 IDLE：一轮 Agent 循环正常结束。
  try { taskState.reset('一轮循环正常收尾'); } catch (_) {}
  try {
    window.electronAPI.showAiNotification().catch(() => {});
  } catch (e) { /* ignore */ }
  // 任务完成标志：悬浮球转绿 + 提示（飞书由 feishu-bridge 独立上报 task-done）
  try { markTaskDone(); } catch (e) { /* ignore */ }
  // 【Harness 2026-11-02】任务空闲信号（一轮 Agent 循环正常结束）
  try { emitTaskIdle(); } catch (_) {}
}

// 工具调用监听器（供飞书同步等订阅工具 start/end 状态）
const toolCallListeners = new Set();

/**
 * 注册"工具调用"监听器
 * @param {Function} cb 参数 { phase: 'start'|'end', code?, success?, output?, error? }
 * @returns {Function} 取消注册
 */
function onToolCall(cb) {
  toolCallListeners.add(cb);
  return () => toolCallListeners.delete(cb);
}

/** 派发工具调用事件（无监听者时零开销） */
function emitToolCall(ev) {
  if (toolCallListeners.size === 0) return;
  for (const cb of toolCallListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// ===== Harness（纯净模式）用的事件派发 =====
// 2026-11-02 新增：为 harness 页面提供流式增量、任务空闲、AI 错误三个事件。
// 不改动现有 Agent 循环，纯新增回调通道（无监听者时零开销）。
const streamListeners = new Set();
const taskIdleListeners = new Set();
const aiErrorListeners = new Set();

function onStream(cb) {
  streamListeners.add(cb);
  return () => streamListeners.delete(cb);
}

function emitStream(ev) {
  if (streamListeners.size === 0) return;
  for (const cb of streamListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

function onTaskIdle(cb) {
  taskIdleListeners.add(cb);
  return () => taskIdleListeners.delete(cb);
}

function emitTaskIdle() {
  if (taskIdleListeners.size === 0) return;
  for (const cb of taskIdleListeners) {
    try { cb(); } catch (_) { /* ignore */ }
  }
}

function onAiError(cb) {
  aiErrorListeners.add(cb);
  return () => aiErrorListeners.delete(cb);
}

function emitAiError(ev) {
  if (aiErrorListeners.size === 0) return;
  for (const cb of aiErrorListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// 回复完成监听器（供压缩等流程等待 AI 回复完成）
const responseListeners = new Set();

/**
 * 注册"AI 回复完成"监听器
 * @param {Function} cb 收到完成回复时调用，参数为 (text, thinking)
 *        thinking 是深度思考内容，可能为空串
 * @returns {Function} 取消注册
 */
function onInterceptedResponse(cb) {
  responseListeners.add(cb);
  return () => responseListeners.delete(cb);
}

/**
 * 推送当前会话的「对话上下文」到壳页面状态栏（对齐 Cuckoo 2026-11-01）
 * @param {string|null} sid 会话 ID（null/空 = 首页 → __home__）
 * 逻辑：优先读 state.serverTokenUsageBySession[sid]，按 baseline 扣减后推送；
 *      无缓存则推送 0（清空显示，与 Cuckoo getTokenForSession 缺省 0 一致）。
 */
function pushContextToStatusBar(sid) {
  try {
    if (!window.electronAPI || typeof window.electronAPI.updateTokenUsage !== 'function') return;
    const key = sid || '__home__';
    const entry = state.serverTokenUsageBySession[key];
    const baseline = (state.tokenBaselineBySession && state.tokenBaselineBySession[key]) || 0;
    const acc = entry && typeof entry.accumulatedTokens === 'number' ? entry.accumulatedTokens : 0;
    const effective = Math.max(0, acc - baseline);
    window.electronAPI.updateTokenUsage(effective, 0, 0, 0, null).catch(() => {});
  } catch (_) {}
}

/**
 * 启动拦截事件监听
 */
function startInterceptObserver() {
  // 【token 持久化】启动时把上次会话的 token 缓存读回内存，
  // 这样打开历史对话就能直接显示上次的数字，不必等新响应。
  try {
    const cached = loadTokenCache();
    const n = Object.keys(cached.usage).length;
    state.serverTokenUsageBySession = cached.usage;
    // 同时恢复基线（迁移过的新会话靠它把承接的历史扣掉）
    state.tokenBaselineBySession = cached.baseline;
    // 关键：启动后若页面直接停在某个会话的 URL，watchSessionForStateReset 的 check()
    // 因 sid === lastSid 不会触发，serverTokenUsage 会一直是 null，悬浮球显示 0。
    // 这里主动按当前 URL 搬运一次，保证「重开即显示上次的数字」。
    try {
      const { getProviderByUrl } = require('../../providers');
      const _p0 = getProviderByUrl(window.location.href);
      const _sid0 = (_p0 && typeof _p0.extractSessionId === 'function'
        ? _p0.extractSessionId(window.location.href)
        : null) || '__home__';
      state.serverTokenUsage = cached.usage[_sid0] || null;
      // 【对齐 Cuckoo 2026-11-01】启动时把缓存中的 token 推送到状态栏
      // （否则状态栏初始显示 0，即便该会话有缓存）
      try { pushContextToStatusBar(_sid0); } catch (_) {}
    } catch (_) {}
    if (n > 0) console.log('[LingYa][Token] 已从 localStorage 恢复 ' + n + ' 个会话的 token 缓存');
  } catch (_) { /* 恢复失败不影响启动 */ }
  // 从 localStorage 恢复上次的状态机快照（页面刷新 / 渲染进程崩溃重载后走这里）。
  // 不恢复的话，状态机会归零回 IDLE，supervisor 就不知道「上次停在 AWAITING」，
  // 崩溃后无法接着判断该不该兜底。
  // 【会话隔离】恢复前必须先确定当前会话，否则会把别的会话的状态捞回来。
  // 典型症状：从「正在执行工具」的旧会话切到新对话首页，界面却显示
  // 「正在执行工具 7m20s」——实际什么都没在跑。
  try {
    let curSid = null;
    try {
      const { getProviderByUrl } = require('../../providers');
      const provider = getProviderByUrl(window.location.href);
      if (provider && typeof provider.extractSessionId === 'function') {
        curSid = provider.extractSessionId(window.location.href) || null;
      }
    } catch (_) { /* 无 provider：当作首页/新对话 */ }

    taskState.setSession(curSid);
    const restored = taskState.restore(curSid);
    if (restored && restored.state !== 'IDLE') {
      console.log('[LingYa][拦截] 状态机已恢复，当前 ' + restored.state +
        '，交由 supervisor 判断是否停滞');
    }
  } catch (err) {
    console.error('[LingYa][拦截] 状态机恢复失败:', err && err.message);
  }

  // AI 开始生成回复：悬浮球切换为「AI 生成中」
  const evtNames = require('./evt-names');

  // 【对齐 Cuckoo 2026-11-01】流式增量 → TPS 测速 → 推送壳页面状态栏
  const { createTpsMeter, formatTps } = require('./tps-meter');
  const tpsMeter = createTpsMeter();
  let lastPushedTps = '';
  function pushTps() {
    const text = tpsMeter.value > 0 ? formatTps(tpsMeter.value) : '';
    if (text === lastPushedTps) return;
    lastPushedTps = text;
    try {
      if (window.electronAPI && window.electronAPI.updateTps) {
        window.electronAPI.updateTps(text).catch(() => {});
      }
    } catch (_) {}
  }
  window.addEventListener(evtNames.AI_STREAM, (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      tpsMeter.update(d.text || '', !!d.finished, typeof d.accumulatedTokens === 'number' ? d.accumulatedTokens : null);
      pushTps();
      // 【Harness 2026-11-02】流式增量派发（无监听者时零开销）
      emitStream({ text: d.text || '', think: d.think || d.thinking || '', finished: !!d.finished });
    } catch (_) {}
  });

  // 【Harness 2026-11-02】AI 错误事件派发（供 harness 复位忙碌状态）
  try {
    if (evtNames.AI_ERROR) {
      window.addEventListener(evtNames.AI_ERROR, (ev) => {
        try {
          const d = (ev && ev.detail) || {};
          emitAiError(d);
        } catch (_) {}
      });
    }
  } catch (_) {}

  window.addEventListener(evtNames.AI_START, () => {
    try {
      state.touch(); // AI 开始生成 = 有活动
      // 检测到新一轮 AI 生成开始（用户手动发消息 或 程序发送）
      // 若此前处于「已停止」状态，说明用户主动发起了新对话 → 自动恢复自动执行
      if (state.stopped) {
        state.stopped = false;
        state.stoppedAt = 0;
        try { window.electronAPI.clearAbort(); } catch (_) {}
        try { setStopped(false); } catch (_) {}
        console.log('[LingYa][拦截] 检测到新对话开始，已恢复自动执行');
      }
      setFabState('generating');
      // 状态机：确认 AI 已开始生成 → 从 SENT 切到 AWAITING（发送 ack 达成）
      try {
        const snap = taskState.snapshot();
        if (snap.state === taskState.STATES.SENT || snap.state === taskState.STATES.IDLE) {
          taskState.transition(taskState.STATES.AWAITING);
        } else {
          taskState.touch(); // 其他状态仅刷新活动时间
        }
      } catch (_) { /* ignore */ }
      // 补记请求起点 + 判断是否新一轮
      // 情况 A：用户直接在页面输入框打字 → 不经过 sendToChat，lastRequestStartAt 为 0
      //         → 视为新一轮，重置本轮统计
      // 情况 B：程序通过 sendToChat 发送 → 已设 lastRequestStartAt，属同一轮，不重置
      if (!state.lastRequestStartAt) {
        state.lastRequestStartAt = Date.now();
        console.log('[LingYa] 检测到新请求（用户直发），开始计时');
      }
      if (generateTimeout) clearTimeout(generateTimeout);
      generateTimeout = setTimeout(() => {
        // 【修复】原来只把悬浮球打回 idle，状态机仍停在 AWAITING →
        // 状态条一直显示「AI 正在生成」直到监督者 120s 后才发现停滞。
        // 现在同步交给状态机判断：超时说明事件可能丢了，状态条应转为「等待响应」并保持可见。
        if (getFabState() === 'generating') setFabState('idle');
        console.log('[LingYa][拦截] 生成超时（' + Math.round(GENERATE_TIMEOUT_MS / 1000) +
          's），状态机保持在 AWAITING 由监督者兜底');
      }, GENERATE_TIMEOUT_MS);
    } catch (err) {
      console.error('[LingYa][拦截] 处理生成开始事件出错:', err);
    }
  });

  window.addEventListener(evtNames.AI_RESPONSE, (ev) => {
    try {
      const detail = ev && ev.detail;
      if (!detail || !detail.finished) return;
      // 【对齐 Cuckoo】如果有真实 TPS（CDP 模式下从 getResponseBody 拿到的精确值），
      // 覆盖测速器的估算值，让状态栏显示真实速度
      if (typeof detail._realTps === 'number' && detail._realTps > 0) {
        try { tpsMeter.setValue(detail._realTps); pushTps(); } catch (_) {}
      }
      // 【2026-10-30】记录本次回复的总字符数（正文 + 思考），供下一条消息的延迟计算使用。
      // 真人读完长回复会等更久才发下一条 —— 这是「间隔 vs 回复长度」正相关的来源。
      // 实测基线：回复 4143 字节 → 等 8.7s；回复 8603 字节 → 等 14.5s。
      try {
        // 只记正文长度：延迟模拟的是「读完回复」的时间，思考内容用户通常折叠不看。
        // 实测基线：正文 604 字符 → 等 8.7s，正文 710 字符 → 等 14.5s。
        const len = String(detail.text || '').length;
        if (len > 0) state.lastResponseLen = len;
      } catch (_) {}
      if (state.stopped) {
        // 已停止：忽略本次完成事件，同时清掉请求起点。
        // 否则停止后下一次回复会把「停止前的等待时长」也算进思考耗时，
        // 导致下次发送被上限（默认 15 秒）拖住。
        state.lastRequestStartAt = 0;
        return;
      }
      // 回复完成：清除「生成中」状态与兜底定时器（随后工具执行会再切到「执行中」）
      if (generateTimeout) { clearTimeout(generateTimeout); generateTimeout = null; }
      if (getFabState() === 'generating') setFabState('idle');

      // 【同步修复】状态机必须在事件到达时就切出 AWAITING，不能等队列。
      //
      // 根因：状态切换写在 processInterceptedResponse 里，而它排在串行队列后面。
      // 若前一个任务还在跑（典型：bashOutput 等 120 秒），队列堵住 →
      // 回复早已完整显示在界面上，状态条却还停在「AI 正在思考」，看起来像没同步。
      //
      // 事件到达 = 回复已完整 = 事实已确定，状态应立刻反映，与后续处理解耦。
      try {
        const snap = taskState.snapshot();
        if (snap.state === taskState.STATES.AWAITING || snap.state === taskState.STATES.SENT) {
          taskState.transition(taskState.STATES.RESPONDED, {
            lastResponsePreview: String(detail.text || '').slice(0, 120),
          });
        } else {
          taskState.touch();
        }
        // 队列若正忙，本次回复要排队 → 标记 queued，UI 显示「排队等待」而非「正在解析」
        taskState.setQueued(queueBusy || queueDepth > 0);
      } catch (_) { /* ignore */ }

      // ===== 抢占：本条回复含工具调用 → 中止上一轮前台执行，不必排队 =====
      //
      // 【为什么放在 enqueueProcessing 之前】抢占必须发生在入队前。
      // 若先入队再抢占，旧任务仍占着 Promise 链，新回复依旧要等它退出，
      // 面板仍显示「排队等待」—— 这正是要修的症状。
      //
      // 【为什么只对含工具调用的回复】纯聊天不打断正在跑的任务：
      // 用户随口问一句不该把构建/爬虫杀掉。
      try {
        if (shouldPreempt(detail.text)) {
          const sessionId = (taskState.snapshot() || {}).sessionId || null;
          // 不等它完成：抢占是「发令」，入队要立刻继续，
          // 否则又变成串行等待，只是把等待从队列挪到了这里。
          preemptPreviousRun(null, sessionId).then((r) => {
            if (r && r.killed > 0) {
              console.log('[LingYa][抢占] 已中止上一轮前台执行，杀掉进程 ' + r.killed + ' 个');
            }
            // 抢占了就不该再显示「排队等待」：本条回复马上要执行工具
            try { taskState.setQueued(false); } catch (_) {}
          }).catch(() => {
            try { taskState.setQueued(false); } catch (_) {}
          });
        }
      } catch (_) { /* 抢占失败不阻断正常流程 */ }
      // 缓存最近一次完整回复文本，供手动解析复用（不依赖 DOM）
      lastInterceptedText = detail.text || '';

      // ===== 分批发送初始提示：上一段已发完且本条回复不含工具调用 → 发下一段 =====
      // 为什么要求「不含工具调用」：若 AI 已经开始干活（输出 lingya 代码块），
      // 此时插入下一段提示词会和工具结果回传交错，把上下文搅乱。
      // 等它把这一轮工具跑完、再回复时，自然会轮到下一段。
      if (state.awaitingNextInitialChunk) {
        const hasToolCall = String(detail.text || '').indexOf('\u0060\u0060\u0060lingya') !== -1;
        if (hasToolCall) {
          // 【关键】暂缓必须有上限。
          // AI 初始化后常常连着干好几轮活，每轮回复都带工具调用 ——
          // 若无限期「等它干完」，awaitingNextInitialChunk 会永久为 true，
          // 而它同时屏蔽了计划续跑/中断续跑/停滞监督三条路径 → 整条 Agent 循环静默死亡。
          // 所以：连续暂缓到阈值（次数或时长）就强制合并剩余段发出，优先保证流程能推进。
          if (!state.initialChunkDeferAt) state.initialChunkDeferAt = Date.now();
          state.initialChunkDeferCount = (state.initialChunkDeferCount || 0) + 1;
          const deferMs = Date.now() - state.initialChunkDeferAt;
          const overLimit = state.initialChunkDeferCount >= INITIAL_CHUNK_DEFER_MAX ||
            deferMs >= INITIAL_CHUNK_DEFER_TIMEOUT_MS;
          console.log('[LingYa][分批] 本轮回复含工具调用，暂缓发送下一段（第 ' +
            state.initialChunkDeferCount + ' 次，已等 ' + Math.round(deferMs / 1000) + 's）');
          if (overLimit) {
            console.log('[LingYa][分批] 暂缓已达上限，强制放行剩余分段');
            try {
              const chatInput = require('./chat-input');
              if (chatInput.flushRemainingInitialChunks) {
                chatInput.flushRemainingInitialChunks('连续暂缓 ' + state.initialChunkDeferCount + ' 次');
              } else {
                state.awaitingNextInitialChunk = false;
              }
            } catch (e) {
              console.error('[LingYa][分批] 强制放行失败:', e && e.message);
              state.awaitingNextInitialChunk = false;
            }
          }
        } else {
          state.initialChunkDeferCount = 0;
          state.initialChunkDeferAt = 0;
          try {
            const chatInput = require('./chat-input');
            if (chatInput.sendNextInitialPromptChunk) chatInput.sendNextInitialPromptChunk();
          } catch (e) {
            console.error('[LingYa][分批] 发送下一段失败:', e && e.message);
            state.awaitingNextInitialChunk = false;
          }
        }
      }
      // 计算本次请求往返耗时：从消息发出 → 回复完成（含 AI 思考 + 生成回复）。
      // 每轮独立：本次回复耗时只影响下一次发送的延迟，不累加、不继承历史最长。
      if (state.lastRequestStartAt > 0) {
        const thinkMs = Date.now() - state.lastRequestStartAt;
        state.lastRequestStartAt = 0;
        state.lastThinkMs = thinkMs;
        // 【新功能】防爆锁解锁：收到新会话的第一条 AI 回复后，解除 isMigrating
        if (state.isMigrating) {
          console.log('[LingYa 迁移] 新会话已产生第一轮回复，解除防爆锁');
          state.isMigrating = false;
          // 【token 基线】迁移后的首轮回复：把这轮的 accumulatedTokens 记为基线，
          // 使新会话的 token 显示与阈值判定从 0 重新计算，不把承接的历史计入。
          // 只在首轮记录一次（已有 baseline 则不覆盖），避免后续轮次反复改写。
          try {
            if (detail.tokenUsage && typeof detail.tokenUsage.accumulatedTokens === 'number') {
              const { getProviderByUrl } = require('../../providers');
              const _p0 = getProviderByUrl(window.location.href);
              const _sid0 = (_p0 && typeof _p0.extractSessionId === 'function'
                ? _p0.extractSessionId(window.location.href)
                : null) || '__home__';
              if (_sid0 !== '__home__' && !state.tokenBaselineBySession[_sid0]) {
                state.tokenBaselineBySession[_sid0] = detail.tokenUsage.accumulatedTokens || 0;
                console.log('[LingYa][Token] 迁移基线已记录 ' + String(_sid0).slice(0, 8) + ' = ' + state.tokenBaselineBySession[_sid0]);
                // 落盘（此处 serverTokenUsageBySession 稍后才写，用当前快照存一次）
                try { saveTokenCache(state.serverTokenUsageBySession); } catch (_) {}
              }
            }
          } catch (_) { /* 基线记录失败不阻断主流程 */ }
        }

        const ratio = Number(state.thinkRatio) || 0;
        const maxDelay = Number(state.thinkMaxDelay) || 0;
        let adaptive = 0;
        if (ratio > 0 && thinkMs > 0) {
          adaptive = Math.floor(thinkMs * ratio);
          if (maxDelay > 0) adaptive = Math.min(adaptive, maxDelay);
        }
        const capped = (maxDelay > 0 && Math.floor(thinkMs * ratio) > maxDelay);
        console.log('[LingYa] 本次请求往返 ' + thinkMs +
          'ms（含 AI 思考 + 生成回复）× ' + ratio +
          ' = ' + adaptive + 'ms' + (capped ? '（已达上限 ' + maxDelay + 'ms）' : ''));
      }
      // 保存服务端权威 token 统计（供面板显示）
      if (detail.tokenUsage) {
        state.serverTokenUsage = detail.tokenUsage;
        // 【token 按会话隔离】同时写入按会话缓存。
        // 为什么从 URL 直接解析 sid 而不用 state.currentSessionId：
        // 后者由 800ms 轮询更新，刚发完请求就切会话时有最多 800ms 的时序窗口，
        // 会把 A 会话的 token 误记到 B 的键上。URL 是同步可信的。
        try {
          const { getProviderByUrl } = require('../../providers');
          const _p = getProviderByUrl(window.location.href);
          const _sid = (_p && typeof _p.extractSessionId === 'function'
            ? _p.extractSessionId(window.location.href)
            : null) || '__home__';
          state.serverTokenUsageBySession[_sid] = detail.tokenUsage;
          // 同步落盘：关闭 LingYa 再打开时仍能看到该会话的 token
          saveTokenCache(state.serverTokenUsageBySession);
          // 【对齐 Cuckoo 2026-11-01】推送 token 上下文给壳页面状态栏
          pushContextToStatusBar(_sid);
        } catch (_) { /* URL 解析失败不阻断 token 显示 */ }
      }
      // 保存最近一次回复的消息 id（压缩时定位摘要用）
      if (detail.msgIds) {
        state.lastResponseMsgIds = detail.msgIds;
      }
      // 通知监听器（第二个参数 thinking：深度思考内容，可能为空串）
      const _thinkLen = String(detail.thinking || '').length;
      console.log('[LingYa][拦截] 收到回复：正文 ' + String(detail.text || '').length +
        ' 字符，思考 ' + _thinkLen + ' 字符' + (_thinkLen === 0 ? '（本轮无思考或捕获失败）' : ''));
      for (const cb of responseListeners) {
        try { cb(detail.text || '', detail.thinking || ''); } catch (_) { /* ignore */ }
      }
      enqueueProcessing(() => processInterceptedResponse(detail.text, false, !!detail.interrupted));
    } catch (err) {
      console.error('[LingYa][拦截] 处理回复事件出错:', err);
    }
  });
  // hook 自检：主世界注入器确认生效后会派发此事件。
  // 它的价值在于「可观测」——若这条日志没出现，说明 hook 没注入成功或事件通道断了，
  // 用户/开发者能立刻定位，而不是面对「AI 回复不执行」的静默失败。
  window.addEventListener(evtNames.HOOK_READY, (ev) => {
    const d = (ev && ev.detail) || {};
    // 【2026-10-30】幂等：主世界为解决时序竞态会派发多次，这里只记录第一次。
    if (window.__lingyaHookReadySeen__) return;
    window.__lingyaHookReadySeen__ = true;
    console.log('[LingYa][拦截] ✅ hook 自检通过：provider=' + (d.provider || '?') +
      '，事件通道贯通');
  });

  // ===== 会话切换：重置状态机 =====
  // DeepSeek 是 SPA，切换会话不重新加载页面，上面的 restore() 不会再跑。
  // 若不主动重置，从「正在执行工具」的会话切到新对话后，状态条会一直挂着旧状态。
  // 用 URL 轮询兜底（pushState 不触发 popstate）。
  (function watchSessionForStateReset() {
    let lastSid = null;
    function readSid() {
      try {
        const { getProviderByUrl } = require('../../providers');
        const p = getProviderByUrl(window.location.href);
        if (p && typeof p.extractSessionId === 'function') {
          return p.extractSessionId(window.location.href) || null;
        }
      } catch (_) {}
      return null;
    }
    lastSid = readSid();
    taskState.setSession(lastSid);
    // 【监督激活】启动时把当前会话 ID 同步到 state，并从主进程拉取已激活会话列表。
    // 为什么必须做：canNudge() 依赖 state.currentSessionId 与 activatedSessions，
    // 二者都只在内存里；重启 LingYa 后若不拉取，之前激活过的会话会被当成未激活。
    state.currentSessionId = lastSid;
    try {
      window.electronAPI.listActivatedSupervisors().then((r) => {
        if (!r || !r.success || !Array.isArray(r.sessions)) return;
        for (const sid of r.sessions) state.activatedSessions.add(sid);
        console.log('[LingYa][监督] 已从磁盘恢复激活会话 ' + r.sessions.length + ' 个');
      }).catch(() => {});
    } catch (_) { /* IPC 不可用不阻断 */ }

    function check() {
      const sid = readSid();
      if (sid === lastSid) return;
      console.log('[LingYa][状态机] 会话切换 ' +
        (lastSid ? lastSid.slice(0, 8) : '(首页)') + ' → ' +
        (sid ? sid.slice(0, 8) : '(首页)') + '，重置为 IDLE');
      lastSid = sid;
      taskState.setSession(sid);
      try { taskState.reset('会话切换'); } catch (_) {}
      state.userTaskStarted = false;
      state.initializationDone = false;
      // 【监督激活】按会话独立：只更新当前会话 ID，不清空 activatedSessions。
      // 切到别的会话时 canNudge() 查集合自然返回 false（若该会话没建过计划）。
      state.currentSessionId = sid;
      // 【token 按会话隔离】切到目标会话时，把该会话的 token 值搬回显示字段。
      // 没有缓存（第一次进入/刷新后未响应）→ 置 null，悬浮球显示 0，等下次响应自动填充。
      // 不这么做的话，切会话后悬浮球会一直显示上一个会话的 token 数，界面上是错的。
      // 显示刷新交给 events.js 的 1 秒定时器（updateConversationTokenDisplay），
      // 这里只做状态搬运，不跨模块调用渲染函数（dom 层不应依赖 overlay 层的私有函数）。
      try {
        const _tokenKey = sid || '__home__';
        state.serverTokenUsage = state.serverTokenUsageBySession[_tokenKey] || null;
      } catch (_) {}
      // 【对齐 Cuckoo 2026-11-01】切会话时推送新会话的 token 给状态栏
      // （Cuckoo 在 handleUrlChanged 里调 refreshTokenForCurrentSession 等效）
      try { pushContextToStatusBar(sid); } catch (_) {}
      // 首页暂存的激活请求：会话 ID 一出现立即补激活
      if (sid && state.pendingActivation) {
        state.pendingActivation = false;
        try {
          const { activateSupervisorForCurrentSession } = require('./tool-executor');
          activateSupervisorForCurrentSession();
        } catch (_) { /* ignore */ }
      }
    }
    window.addEventListener('popstate', check);
    window.addEventListener('hashchange', check);
    setInterval(check, 800);
  })();

  console.log('[LingYa][拦截] 已启动 lingya-ai-response 事件监听');
  // 5 秒后仍未收到 hook 自检 → 打印明确警告（不阻断，但要让问题可见）
  //
  // 【CDP 模式不检查】走 CDP 捕获时页面主世界根本没有 hook，
  // 不会有 lingya-hook-ready 事件，此警告必然是误报。改为检查 CDP 是否已启用。
  setTimeout(() => {
    if (window.__lingyaCdpActive__) return;
    if (window.__lingyaHookReadySeen__) return;
    console.warn('[LingYa][拦截] ⚠️ 5 秒内未收到 hook 自检事件。' +
      '可能原因：① hook 注入失败（见上方「主世界拦截器注入」日志）；' +
      '② 事件通道被页面隔离；③ 平台端点已变更导致 isCompletion 不匹配。' +
      '此时 AI 回复将不会被自动执行。');
  }, 5000);
}

/** 取最近一次拦截到的完整回复文本（手动解析用） */
function getLastInterceptedText() {
  return lastInterceptedText;
}


/** 取最近一次已处理的文本（供 DOM 兜底去重比对） */
function getLastProcessedText() {
  return lastProcessedText;
}

/** 清除「生成中」兜底定时器并复位状态（停止任务时调用） */
function resetGenerating() {
  if (generateTimeout) { clearTimeout(generateTimeout); generateTimeout = null; }
  if (getFabState() === 'generating') setFabState('idle');
}

module.exports = { startInterceptObserver, processInterceptedResponse, getLastInterceptedText, getLastProcessedText, onInterceptedResponse, onToolCall, onStream, onTaskIdle, onAiError, resetGenerating, getQueueState, DONE_HINT_RE };
