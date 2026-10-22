/**
 * 任务状态机 —— Agent 循环的单一真相源
 *
 * 为什么需要：
 *   现有续跑逻辑全部挂在 'lingya-ai-response' 事件上。事件不来（hook 失效、流没收尾、
 *   页面异常）→ 整条链静默死亡，任务卡死且无任何提示。
 *   监督者虽是定时器，但只查 todo，无计划的任务型会话是盲区。
 *
 *   把一次 Agent 循环建模成显式状态，每个状态记录进入时刻并持久化到 localStorage：
 *     - 页面刷新后能读回「上次停在哪」，不重复也不丢
 *     - 监督者可以按状态 + 超时判断，而不是靠猜
 *     - 超时边界清晰：AWAITING 超时=事件可能丢了；EXECUTING 超时=工具卡死
 *
 * 状态流转：
 *   IDLE --send--> SENT --ai-start--> AWAITING --ai-response--> RESPONDED
 *   RESPONDED --有工具--> EXECUTING --执行完--> SENT（回传结果）
 *   RESPONDED --无工具--> IDLE（任务收尾）
 */

const STORAGE_KEY = 'lingya-task-state';

// 各状态的停滞阈值（毫秒）：超过即视为卡住，需要兜底
const STALL_THRESHOLDS = {
  // 已发出消息，但 AI 迟迟不开始生成 → 可能没发出去
  // 正常情况 DeepSeek 1-3s 内就会 ai-start，30s 已是极宽松的上限
  SENT: 30 * 1000,
  // 正在等 AI 回复，但流迟迟不收尾 → 可能事件丢了
  AWAITING: 120 * 1000,
  // 刚收到回复，正在解析/执行工具 → 正常情况下几乎瞬间过渡，30s 足够
  // （处理过程中抛异常时会卡在这里，需要兜底）
  RESPONDED: 30 * 1000,
  // 工具执行中 → 正常情况 660s 内必结束（JsRunner deadline），留余量
  EXECUTING: 720 * 1000,
};

/** 状态常量 */
const STATES = {
  IDLE: 'IDLE',
  SENT: 'SENT',
  AWAITING: 'AWAITING',
  RESPONDED: 'RESPONDED',
  EXECUTING: 'EXECUTING',
};

// 内存态（localStorage 只是持久化镜像，读走内存更快）
let current = {
  state: STATES.IDLE,
  enteredAt: Date.now(),
  // 本轮任务的序号，用于跨状态关联
  round: 0,
  // 最近一次发出的消息摘要（便于日志/恢复时判断）
  lastSentTag: '',
  // 最近一次收到的回复文本摘要
  lastResponsePreview: '',
};

let saveTimer = null;

// ===== 订阅机制：状态机是唯一真相源，UI 由它驱动 =====
// 为什么需要：原来 setTaskStatus() / setFabState() 散落在 intercept-observer、
// tool-executor、supervisor 各处手动调用，任何一处漏调 UI 就停在上一个状态。
// 现在所有 UI 订阅 transition/touch/reset，状态机变了 UI 必然跟着变。
const listeners = new Set();
let tickTimer = null;

/** 订阅状态变化（返回取消订阅函数） */
function onChange(cb) {
  if (typeof cb !== 'function') return function () {};
  listeners.add(cb);
  // 新订阅者立刻收到当前快照，避免 UI 空白
  try { cb(snapshot(), 'init'); } catch (_) {}
  return function () { listeners.delete(cb); };
}

/** 通知所有订阅者 */
function notify(reason) {
  const snap = snapshot();
  for (const cb of listeners) {
    try { cb(snap, reason); } catch (err) {
      console.error('[LingYa][状态机] 订阅者回调异常:', err && err.message);
    }
  }
}

/**
 * 启动秒级心跳：只做 UI 刷新（让「已执行 3m24s」这类计时持续走）。
 * 不改变状态，不触发业务逻辑，代价可忽略。
 */
function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    // 有订阅者就刷新。
    // 【不要在这里判断 IDLE】状态机可能已回 IDLE，但后台任务（bashBackground 起的
    // 服务/爬虫）仍在跑，UI 需要继续走计时。是否显示由 renderTaskbar 自己决定。
    if (listeners.size === 0) return;
    notify('tick');
  }, 1000);
}

/** 停止心跳 */
function stopTicker() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/** 持久化（节流 500ms，避免高频写 localStorage） */
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (_) { /* 存储满/禁用时忽略 */ }
  }, 500);
}

/** 立即持久化（关键状态切换时用） */
function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (_) { /* ignore */ }
}

/**
 * 状态切换
 * @param {string} next 目标状态
 * @param {object} [extra] 附加字段（写入 current）
 * @returns {object} 切换后的快照
 */
function transition(next, extra) {
  const prev = current.state;
  current.state = next;
  current.enteredAt = Date.now();
  if (extra && typeof extra === 'object') {
    Object.assign(current, extra);
  }
  console.log('[LingYa][状态机] ' + prev + ' -> ' + next +
    (extra && extra.lastSentTag ? '（' + extra.lastSentTag + '）' : ''));
  persist();
  notify('transition:' + prev + '->' + next);
  return snapshot();
}

/** 只刷新 enteredAt（有活动但状态不变，避免被误判停滞） */
function touch() {
  current.enteredAt = Date.now();
  persist();
  notify('touch');
}

/** 读取当前快照 */
function snapshot() {
  return Object.assign({}, current);
}

/** 从持久化恢复（页面刷新/重载后调用） */
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return snapshot();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return snapshot();
    // 只接受已知状态，防止脏数据
    if (obj.state && STATES[obj.state]) {
      current = Object.assign(current, {
        state: obj.state,
        enteredAt: Number(obj.enteredAt) || Date.now(),
        round: Number(obj.round) || 0,
        lastSentTag: String(obj.lastSentTag || ''),
        lastResponsePreview: String(obj.lastResponsePreview || ''),
      });
      console.log('[LingYa][状态机] 已从持久化恢复: ' + current.state +
        '（已停留 ' + Math.round((Date.now() - current.enteredAt) / 1000) + 's）');
    }
  } catch (_) { /* 脏数据忽略 */ }
  return snapshot();
}

/** 重置到 IDLE（新会话/用户停止/任务收尾） */
function reset(reason) {
  current.state = STATES.IDLE;
  current.enteredAt = Date.now();
  current.lastSentTag = '';
  current.lastResponsePreview = '';
  console.log('[LingYa][状态机] 重置为 IDLE' + (reason ? '（' + reason + '）' : ''));
  persistNow();
  notify('reset');
  return snapshot();
}

/**
 * 判断当前是否停滞（供监督者调用）
 * @returns {{stalled: boolean, state: string, elapsedMs: number, thresholdMs: number, reason: string}}
 */
function checkStall() {
  const snap = snapshot();
  const threshold = STALL_THRESHOLDS[snap.state] || 0;
  const elapsed = Date.now() - snap.enteredAt;
  if (threshold > 0 && elapsed > threshold) {
    const reason = snap.state === STATES.SENT ? '消息可能没发出去'
      : snap.state === STATES.AWAITING ? 'AI 回复事件可能丢失'
      : snap.state === STATES.RESPONDED ? '回复处理卡住（解析/执行阶段异常）'
      : snap.state === STATES.EXECUTING ? '工具执行卡死'
      : '状态停滞';
    return { stalled: true, state: snap.state, elapsedMs: elapsed, thresholdMs: threshold, reason: reason };
  }
  return { stalled: false, state: snap.state, elapsedMs: elapsed, thresholdMs: threshold, reason: '' };
}

/** 状态的中文描述（供 UI 直接显示） */
function describe(state) {
  switch (state) {
    case STATES.SENT: return '已发送，等待 AI 响应';
    case STATES.AWAITING: return 'AI 正在思考/生成';
    case STATES.RESPONDED: return '正在解析回复';
    case STATES.EXECUTING: return '正在执行工具';
    default: return '';
  }
}

/** 当前状态是否「进行中」（UI 据此决定是否持续显示） */
function isBusy() {
  return current.state !== STATES.IDLE;
}

/** 已停留时长（毫秒） */
function elapsedMs() {
  return Date.now() - (current.enteredAt || Date.now());
}

module.exports = {
  STATES,
  STALL_THRESHOLDS,
  transition,
  touch,
  snapshot,
  restore,
  reset,
  checkStall,
  onChange,
  startTicker,
  stopTicker,
  describe,
  isBusy,
  elapsedMs,
};
