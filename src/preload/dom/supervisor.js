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
const { getFabState, setFabState, showToast } = require('../overlay/ui');
const { sendMessageToChat } = require('./chat-input');

// 检查间隔（毫秒）
const CHECK_INTERVAL_MS = 30 * 1000;
// 停滞阈值默认值（毫秒）：超过这么久没有活动视为停滞
const STALL_THRESHOLD_DEFAULT = 120 * 1000;
// 连续催促上限 / 窗口
const STALL_MAX_DEFAULT = 5;
const STALL_WINDOW_MS = 300 * 1000;

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
// awaitingUserInput 超过这个时长视为误判（AI 只是说了句带「确认」的话），强制催
const AWAITING_USER_TIMEOUT_MS = 3 * 60 * 1000;
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

    // DOM 兜底失败 → 催 AI 继续
    if (!recovered) {
      try { showToast('检测到回复中断，已自动催促继续', 4000); } catch (_) {}
      sendMessageToChat(
        '【监督续跑】检测到上一条回复可能因网络或页面异常中断（已 ' + sec + ' 秒无进展）。' +
        '请继续完成当前任务：若上一步已生效请勿重复执行，直接推进下一步；' +
        '若任务已完成，请用一句话明确说明"任务已完成"。',
        '状态机续跑',
        { auto: true }
      );
      try { taskState.reset('AWAITING 停滞已催促'); } catch (_) {}
      state.touch();
      return true;
    }
  }

  // RESPONDED 停滞：收到了回复但处理卡住（解析/执行阶段抛异常）
  if (stallInfo.state === taskState.STATES.RESPONDED) {
    console.log('[LingYa][监督] 回复处理卡住 ' + sec + 's，重置状态让流程继续');
    try { showToast('⚠️ 回复处理异常，已重置状态', 4000); } catch (_) {}
    try { taskState.reset('RESPONDED 处理卡住'); } catch (_) {}
    state.touch();
    return true;
  }

  // EXECUTING 停滞：工具卡死 → 提示并催
  if (stallInfo.state === taskState.STATES.EXECUTING) {
    try { showToast('⚠️ 工具执行超时（' + sec + 's），已中断并催促继续', 5000); } catch (_) {}
    sendMessageToChat(
      '【监督续跑】上一步工具执行超时（已 ' + sec + ' 秒无响应），可能已失败。' +
      '请检查该操作是否已生效：若未生效，换一种方式重试；若已生效，直接推进下一步。' +
      '若任务已完成，请用一句话明确说明"任务已完成"。',
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

  // === A) awaitingUserInput 超时 ===
  if (state.awaitingUserInput) {
    const waited = now - (state.awaitingUserInputAt || 0);
    if (waited < AWAITING_USER_TIMEOUT_MS) return;
    console.log('[LingYa][监督] awaitingUserInput 已 ' + Math.round(waited / 1000) +
      's，视为误判，清除标志并继续监督');
    // 清掉标志，否则下次检查又要白等 3 分钟
    state.awaitingUserInput = false;
    state.awaitingUserInputAt = 0;
    // 不 return，继续往下；如果计划真完成了会查 todo 判断
  }

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
    // ===== 无计划兜底（原 supervisor 的盲区）=====
    // 场景：任务型会话（执行过工具）但没建 todo，AI 停在中途不动了。
    // 原实现直接 return，这类会话永远不会被催促。
    // 判断依据：本会话执行过工具 + 当前处于 IDLE（说明一轮循环已结束但任务未必完成）
    //
    // 【重要】必须排除「AI 已声明任务完成」的情况，否则会出现：
    //   计划 7/7 全完成 + AI 明说"任务已完成" → 仍在催（用户实测反馈的 bug）
    // 主防护在 intercept-observer 收尾处（命中 DONE_HINT 就 resetTaskFlags），
    // 这里再加一道：检查最近一次拦截到的回复文本是否声明完成。
    if (state.sessionHadToolExecution) {
      const snap = taskState.snapshot();
      if (snap.state === taskState.STATES.IDLE) {
        // 双重保险：查最近回复是否已声明完成
        let declaredDone = false;
        try {
          const observer = require('./intercept-observer');
          const lastText = observer.getLastProcessedText ? observer.getLastProcessedText() : '';
          if (lastText && observer.DONE_HINT_RE && observer.DONE_HINT_RE.test(String(lastText))) {
            declaredDone = true;
            // 顺手复位标记，避免后续每轮都走到这里
            try { state.resetTaskFlags(); } catch (_) {}
            console.log('[LingYa][监督] 最近回复已声明任务完成，跳过无计划兜底');
          }
        } catch (_) { /* ignore */ }
        if (declaredDone) return;
        const nowMs = Date.now();
        if (nowMs - lastStallAt > STALL_WINDOW_MS) stallCount = 0;
        if (stallCount < max) {
          lastStallAt = nowMs;
          stallCount++;
          console.log('[LingYa][监督] 无计划任务停滞 ' + Math.round(idleMs / 1000) +
            's，兜底续跑第 ' + stallCount + ' 次');
          try { showToast('检测到任务停滞（无计划），已自动催促继续', 4000); } catch (_) {}
          sendMessageToChat(
            '【监督续跑】检测到你已经 ' + Math.round(idleMs / 1000) + ' 秒没有动作。' +
            '若任务尚未完成，请立即调用工具继续下一步（不要只描述计划、不要停下来等用户确认）；' +
            '若任务确已完成，请用一句话明确说明"任务已完成"。',
            '无计划兜底续跑',
            { auto: true }
          );
          state.touch();
        }
      }
    }
    return;
  }

  // 停滞计数（时间窗口内累加，超窗口重置）
  if (now - lastStallAt > STALL_WINDOW_MS) stallCount = 0;

  // === D) 打满后降频，不永久放弃 ===
  // 原实现打满后直接 return，本次会话再也不会催；改为每 STALL_RETRY_INTERVAL_MS 催一次。
  if (stallCount >= max) {
    if (now - lastStallAt < STALL_RETRY_INTERVAL_MS) {
      console.log('[LingYa][监督] 已达上限 ' + max + ' 次，降频等待 ' +
        Math.round((STALL_RETRY_INTERVAL_MS - (now - lastStallAt)) / 1000) + 's');
      return;
    }
    console.log('[LingYa][监督] 已超过 ' + Math.round(STALL_RETRY_INTERVAL_MS / 60000) +
      ' 分钟未响应，重置计数继续催');
    stallCount = 0;
  }
  lastStallAt = now;
  stallCount++;

  // 【重要】AI 已声明「任务已完成」但 todo 里还有未完成项时，不要催。
  //
  // 场景：AI 说「任务已完成，但 todo 里有 3 项我判断不需要做了」，
  //   或 todoWrite 工具执行失败导致 todo 没更新完。
  //   此时 todo 仍是 unfinished，supervisor 会一直催 —— 用户看到的正是「AI 说完成了还在催」。
  // 判断方式与无计划分支一致：查最近一次处理的回复文本。
  try {
    const observer = require('./intercept-observer');
    const lastText = observer.getLastProcessedText ? observer.getLastProcessedText() : '';
    if (lastText && observer.DONE_HINT_RE && observer.DONE_HINT_RE.test(String(lastText))) {
      console.log('[LingYa][监督] 有计划但 AI 已声明任务完成，跳过催促（todo 可能未同步）');
      stallCount = 0;
      return;
    }
  } catch (_) { /* ignore */ }

  const next = unfinished.find((t) => t.status === 'in_progress') || unfinished[0];
  console.log('[LingYa][监督] 检测到停滞 ' + Math.round(idleMs / 1000) + 's，任务剩 ' +
    unfinished.length + ' 项，第 ' + stallCount + ' 次催促');
  try { showToast('检测到任务停滞，已自动催促继续', 3000); } catch (_) { /* ignore */ }
  sendMessageToChat(
    '【监督续跑】检测到你已经 ' + Math.round(idleMs / 1000) + ' 秒没有动作，但任务计划尚未完成（还剩 ' +
    unfinished.length + ' 项）。请立即继续执行：' + next.content +
    '。不要停下来等用户确认；若任务确已完成，请用一句话明确说明"任务已完成"并更新 todo。',
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
