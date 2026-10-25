/**
 * 停滞监督者（Stall Supervisor）——独立于 AI 回复事件的心跳定时器。
 *
 * 为什么需要它：
 *   原有自动续跑逻辑（intercept-observer 的 continueIfPlanUnfinished）挂在
 *   'lingya-ai-response' 事件处理链上，依赖"AI 回复事件到达"。
 *   但存在事件根本不来的场景：流未正常收尾、页面异常、脚本卡死等。
 *   事件不来 → 处理链不触发 → 续跑逻辑永远不跑 → 任务静默停滞。
 *
 *   监督者用纯定时器心跳（不依赖任何事件），定期检查
 *   "任务未完成 + 长时间无活动 + 空闲"，命中就主动催 AI 继续。
 *
 * 保守策略（避免误伤纯问答/闲聊）：
 *   仅在"该会话 todo 有计划且仍有未完成项"时才触发。
 *   无计划的会话由 intercept-observer 的无计划兜底负责。
 */
const state = require('./state');
const taskState = require('./task-state');
const { decide } = require('./nudge-policy');
const { getFabState, setFabState, showToast } = require('../overlay/ui');
const { sendMessageToChat } = require('./chat-input');

// 检查间隔（毫秒）
const CHECK_INTERVAL_MS = 30 * 1000;
// 停滞阈值默认值（毫秒）：超过这么久没有活动视为停滞
const STALL_THRESHOLD_DEFAULT = 120 * 1000;
// 连续催促上限 / 窗口
const STALL_MAX_DEFAULT = 5;
const STALL_WINDOW_MS = 300 * 1000;

/**
 * 是否允许发送催促消息（闸门）。
 *
 * 【为什么需要】初始化项目时 systemPrompt 分多段自动发出（都是 auto 消息），
 * AI 读完回一句「已就绪」，用户还没开口。若不设闸门，120 秒后会命中
 * 「停滞」分支反复催促，AI 只能回「没有任务」，再被催……死循环。
 *
 * 【激活语义】按会话独立、持久化、无上限：
 *   - 某会话 AI 建过 todo 计划 → 该会话永久激活
 *   - 切到别的会话 → 各自的激活状态互不影响
 *   - 切回原会话 / 重启 LingYa → 仍保持激活（状态存在 supervisor-store）
 *
 * 状态来源：state.activatedSessions（内存镜像，启动时从主进程同步）。
 *
 * 注意：只挡「发消息」的动作。fab 卡死自愈、DOM 兜底、状态机重置
 * 这些不发消息的修复动作必须照常执行（否则初始化期间出错就没人救了）。
 */
function canNudge() {
  const sid = state.currentSessionId;
  if (!sid) return false;
  return state.activatedSessions.has(sid);
}

let timer = null;
let stallCount = 0;
let lastStallAt = 0;
// 状态机停滞的独立计数器：与 todo 续跑分开，避免两条路径互相挤占预算
let stateStallCount = 0;
let lastStateStallAt = 0;
let running = false;

/**
 * 读取监督者配置（走安全配置存储，复用已有 IPC）
 * 返回 { enabled, stallMs, max }
 */
async function loadConfig() {
  let cfg = null;
  try { cfg = await window.electronAPI.getSecurityConfig(); } catch (_) { /* 用默认值 */ }
  const enabled = !(cfg && cfg.stallSupervisorEnabled === false); // 默认开
  const stallMs = (cfg && Number(cfg.stallThresholdMs) > 0)
    ? Math.max(30000, Number(cfg.stallThresholdMs)) : STALL_THRESHOLD_DEFAULT;
  const max = (cfg && Number(cfg.stallContinueMax) > 0)
    ? Math.floor(Number(cfg.stallContinueMax)) : STALL_MAX_DEFAULT;
  return { enabled, stallMs, max };
}

/**
 * 单次检查。命中"任务未完成 + 停滞 + 空闲"时主动催促。
 */
// fab「忙」状态超过这个时长视为卡死（工具崩了没复位），强制复位继续监督
const FAB_STUCK_MS = 5 * 60 * 1000;
// stallCount 打满后的降频间隔：不再永久放弃，而是每 5 分钟催一次
const STALL_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 状态机停滞处理 —— 覆盖「事件丢失」盲区。
 *
 * 与 todo 判断的区别：
 *   todo 判断看的是「AI 有没有按计划推进」，只在有计划时有效。
 *   本函数看的是「Agent 循环本身有没有卡住」，不依赖 todo，能救：
 *     - 消息发出去了但 AI 没开始生成（SENT 停滞 → 重发）
 *     - AI 在生成但流没收尾、事件丢失（AWAITING 停滞 → 催它继续）
 *     - 工具执行卡死（EXECUTING 停滞 → 标记失败并催）
 *
 * @returns {Promise<boolean>} true 表示已处理（调用方应 return）
 */
async function handleTaskStateStall(now, max) {
  let stallInfo;
  try { stallInfo = taskState.checkStall(); } catch (_) { return false; }
  if (!stallInfo || !stallInfo.stalled) return false;

  // 独立计数：与 todo 续跑分开，互不挤占预算
  if (now - lastStateStallAt > STALL_WINDOW_MS) stateStallCount = 0;
  if (stateStallCount >= max) {
    if (now - lastStateStallAt < STALL_RETRY_INTERVAL_MS) {
      // 降频期内不处理状态机，但返回 false 让 todo 分支有机会（可能确实有计划待催）
      return false;
    }
    console.log('[LingYa][监督] 状态机停滞已达上限 ' + max + ' 次且超过降频窗口，重置计数');
    stateStallCount = 0;
  }
  lastStateStallAt = now;
  stateStallCount++;

  // 【统一闸门 · 用户要求 ③A】无计划时状态机停滞也完全不管。
  // 三类停滞（SENT / AWAITING / EXECUTING）全部挡掉，包括：
  //   - SENT 的 showToast 提示（消息发送失败用户不会收到提示）
  //   - AWAITING 的 DOM 兜底 + 催促
  //   - EXECUTING 的催促
  // 这是「监督机制必须在创建计划后才激活」的最严格执行方式。
  // 未建计划的会话若卡死，只能靠用户手动介入。
  if (!canNudge()) {
    console.log('[LingYa][监督] 状态机停滞（' + stallInfo.state + '）但 AI 尚未创建计划，不做任何处理');
    return false;
  }

  const sec = Math.round(stallInfo.elapsedMs / 1000);
  console.log('[LingYa][监督] 状态机停滞：' + stallInfo.state + ' 已 ' + sec + 's（阈值 ' +
    Math.round(stallInfo.thresholdMs / 1000) + 's），判定：' + stallInfo.reason +
    '，第 ' + stateStallCount + ' 次处理');

  // SENT 停滞：消息大概率没发出去 → 提示用户，不自动重发（避免重复消息）
  if (stallInfo.state === taskState.STATES.SENT) {
    try { showToast('⚠️ 消息可能未发送成功（' + sec + 's 无响应），请手动检查输入框', 6000); } catch (_) {}
    // 回到 IDLE，避免每轮都报警
    try { taskState.reset('SENT 停滞已提示'); } catch (_) {}
    return true;
  }

  // AWAITING 停滞：事件可能丢了
  if (stallInfo.state === taskState.STATES.AWAITING) {
    // 先试 DOM 兜底：如果页面上其实已经有完整回复（只是事件没来），直接补处理，
    // 比催 AI 重发更准确（避免重复生成、省 token）
    let recovered = false;
    try {
      const domFallback = require('./dom-fallback');
      const observer = require('./intercept-observer');
      const r = await domFallback.tryRecoverFromDom(
        observer.getLastProcessedText ? observer.getLastProcessedText() : '',
        observer.processInterceptedResponse
      );
      if (r && r.recovered) {
        recovered = true;
        console.log('[LingYa][监督] DOM 兜底成功：' + r.reason);
        try { showToast('检测到回复事件丢失，已从页面补回', 4000); } catch (_) {}
        try { taskState.reset('AWAITING 已 DOM 补回'); } catch (_) {}
        state.touch();
        return true;
      }
      console.log('[LingYa][监督] DOM 兜底未成功：' + (r && r.reason) + '，改为催促 AI 继续');
    } catch (err) {
      console.log('[LingYa][监督] DOM 兜底异常：' + (err && err.message) + '，改为催促 AI 继续');
    }

    // DOM 兜底失败 → 催 AI 继续（用户还没派任务时不催，见 canNudge 注释）
    if (!recovered && !canNudge()) {
      console.log('[LingYa][监督] AWAITING 停滞但用户尚未派任务，只重置状态不催促');
      try { taskState.reset('AWAITING 停滞（初始化期不催）'); } catch (_) {}
      state.touch();
      return true;
    }
    if (!recovered) {
      try { showToast('回复好像断了，已提醒继续', 4000); } catch (_) {}
      sendMessageToChat(
        '刚才好像断了。接着往下做，已经做过的别重来；全做完了跟我说一声“完成了”。',
        '状态机续跑',
        { auto: true }
      );
      try { taskState.reset('AWAITING 停滞已催促'); } catch (_) {}
      state.touch();
      return true;
    }
  }

  // RESPONDED 停滞：收到了回复但处理卡住（解析/执行阶段抛异常）
  // 【排除排队态】队列被前一个长任务占住时，回复还没轮到处理 ——
  // 这不是「处理卡住」，重置反而会丢掉待处理的回复。交给队列自己消化。
  if (stallInfo.state === taskState.STATES.RESPONDED) {
    const snap = taskState.snapshot();
    if (snap.queued) {
      console.log('[LingYa][监督] 回复在排队等待处理（' + sec + 's），不算卡住，继续等');
      return true;
    }
    console.log('[LingYa][监督] 回复处理卡住 ' + sec + 's，重置状态让流程继续');
    try { showToast('⚠️ 回复处理异常，已重置状态', 4000); } catch (_) {}
    try { taskState.reset('RESPONDED 处理卡住'); } catch (_) {}
    state.touch();
    return true;
  }

  // EXECUTING 停滞：工具卡死 → 提示并催（用户还没派任务时只重置，不催）
  if (stallInfo.state === taskState.STATES.EXECUTING) {
    if (!canNudge()) {
      console.log('[LingYa][监督] EXECUTING 停滞但用户尚未派任务，只重置状态不催促');
      try { taskState.reset('EXECUTING 停滞（初始化期不催）'); } catch (_) {}
      state.touch();
      return true;
    }
    try { showToast('⚠️ 工具执行超时（' + sec + 's），已中断并催促继续', 5000); } catch (_) {}
    sendMessageToChat(
      '刚才那个操作卡了 ' + sec + ' 秒没反应，可能没成。' +
      '先确认一下有没有生效：没成换个法子重来，成了就接着往下做。全做完跟我说“完成了”。',
      '工具超时续跑',
      { auto: true }
    );
    try { taskState.reset('EXECUTING 停滞已催促'); } catch (_) {}
    state.touch();
    return true;
  }

  return false;
}

async function checkOnce() {
  if (state.stopped) return;                       // 用户已停止
  if (state.awaitingRefusalRewrite) return;        // 正在等改写回复

  // 【关键】AI 已明确声明任务完成 → 不催。
  // 这是最高优先级的停止信号：todo 里残留的未完成项可能只是 AI 判断不需要做的，
  // 或 todoWrite 更新失败。继续催会形成「AI 说完成 → 被催 → 再说完成」的死循环。
  if (state.taskDeclaredDone) return;

  const now = Date.now();

  // === C) fab 卡死自愈 ===
  const fab = getFabState();
  if (fab === 'executing' || fab === 'generating') {
    const idleMs = now - (state.lastActivityAt || 0);
    if (idleMs > FAB_STUCK_MS) {
      console.log('[LingYa][监督] fab 状态 ' + fab + ' 已卡 ' + Math.round(idleMs / 1000) +
        's，强制复位为 idle 继续监督');
      try { setFabState('idle'); } catch (_) { /* ignore */ }
      // 继续往下检查，不 return
    } else {
      return; // 正常忙，跳过
    }
  }

  // === A) AI 在等用户回答 ===
  // 【2026-10-25 决策】强弱等待一视同仁，一律不催。
  // 改造前弱等待有 3 分钟超时，实测会造成「AI 问了句『要不要继续』，3 分钟后被催，
  // 于是它自己选了个方向继续跑，用户失去决策权」。用户明确选择取消该超时。
  if (state.awaitingUserInput) {
    return;
  }

  // 正在分批发送初始提示：等回复是正常流程，不是停滞
  if (state.awaitingNextInitialChunk) return;

  const { enabled, stallMs, max } = await loadConfig();
  if (!enabled) return;

  const idleMs = now - (state.lastActivityAt || 0);
  if (idleMs < stallMs) return; // 还没停滞

  // ===== A2) 状态机停滞：能救「事件丢失」的盲区 =====
  // 这是 todo 判断覆盖不到的场景：AI 发出了工具调用但 lingya-ai-response 事件没来，
  // 或消息根本没发出去。此时 todo 可能是空的（无计划会话），原逻辑会直接 return。
  if (await handleTaskStateStall(now, max)) return;

  // 查该会话 todo：只有"有计划且未完成"才触发（保守，避免误伤闲聊）
  let res;
  try { res = await window.electronAPI.getTodos(); } catch (_) { return; }
  const todos = (res && res.success && Array.isArray(res.todos)) ? res.todos : [];
  const unfinished = todos.filter((t) => t && t.status !== 'completed');
  if (unfinished.length === 0) {
    stallCount = 0;
    // 计划已完成：清掉等待标志（AI 说的"待确认"其实已经做完了）
    if (state.awaitingUserInput) {
      state.awaitingUserInput = false;
      state.awaitingUserInputAt = 0;
    }
    // 【无计划兜底已移除】
    // 用户要求：监督机制必须在创建计划后才激活。原分支专门处理
    // 「任务型会话但没建 todo，AI 停在中途」的情况 —— 与「无计划不介入」
    // 的要求直接冲突，故整体删除。现在无计划时监督者不做任何催促，
    // 只能靠用户手动推进。
    return;
  }

  // 监督机制激活条件：本会话是否已激活（见 canNudge 的注释）
  if (!canNudge()) {
    console.log('[LingYa][监督] 本会话监督机制未激活（未建过计划），跳过催促');
    return;
  }

  // 停滞计数（时间窗口内累加，超窗口重置）
  if (now - lastStallAt > STALL_WINDOW_MS) stallCount = 0;

  // 【统一闸门】所有「要不要催」的判断都收敛到 nudge-policy.decide()，
  // 与 continueIfPlanUnfinished / continueOnInterruptFallback 共用同一套标准。
  const verdict = decide({
    stopped: state.stopped,
    awaitingNextInitialChunk: state.awaitingNextInitialChunk,
    sessionId: state.currentSessionId,
    activatedSessions: state.activatedSessions,
    awaitingUserInput: state.awaitingUserInput,
    taskDeclaredDone: state.taskDeclaredDone,
    xmlDetected: false,  // 定时检查拿不到本轮 raw，格式错误由回复路径处理
    enabled,
    count: stallCount,
    max,
  });
  if (verdict.action !== 'nudge') {
    // 打满后降频：不是永久放弃，而是每 STALL_RETRY_INTERVAL_MS 再试一次
    if (stallCount >= max) {
      if (now - lastStallAt < STALL_RETRY_INTERVAL_MS) {
        console.log('[LingYa][监督] ' + verdict.reason + '，降频等待 ' +
          Math.round((STALL_RETRY_INTERVAL_MS - (now - lastStallAt)) / 1000) + 's');
        return;
      }
      console.log('[LingYa][监督] 已超过 ' + Math.round(STALL_RETRY_INTERVAL_MS / 60000) +
        ' 分钟未响应，重置计数继续催');
      stallCount = 0;
    } else {
      console.log('[LingYa][监督] ' + verdict.reason + '，跳过催促');
      return;
    }
  }
  lastStallAt = now;
  stallCount++;

  const next = unfinished.find((t) => t.status === 'in_progress') || unfinished[0];
  console.log('[LingYa][监督] 检测到停滞 ' + Math.round(idleMs / 1000) + 's，任务剩 ' +
    unfinished.length + ' 项，第 ' + stallCount + ' 次催促');
  try { showToast('卡住了，已提醒继续', 3000); } catch (_) { /* ignore */ }
  sendMessageToChat(
    '接着做：' + next.content + '。做完再往下走，不用等我确认。',
    '监督续跑',
    { auto: true }
  );
  // 催促即视为一次活动，避免下一次检查立刻又命中
  state.touch();
}

/** 启动监督者（幂等） */
function startSupervisor() {
  if (timer) return;
  running = true;
  timer = setInterval(() => {
    if (!running) return;
    checkOnce().catch((err) => console.error('[LingYa][监督] 检查出错:', err));
  }, CHECK_INTERVAL_MS);
  console.log('[LingYa][监督] 停滞监督者已启动（间隔 ' + (CHECK_INTERVAL_MS / 1000) + 's）');
}

/** 停止监督者 */
function stopSupervisor() {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
}

/** 重置停滞计数（新任务/新会话时调用） */
function resetStall() {
  stallCount = 0;
  lastStallAt = 0;
  stateStallCount = 0;
  lastStateStallAt = 0;
}

module.exports = { startSupervisor, stopSupervisor, resetStall, checkOnce };
