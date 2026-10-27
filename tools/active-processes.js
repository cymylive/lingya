/**
 * 活动子进程跟踪器（主进程与 tools 共享）
 *
 * 目的：让"停止任务"能真正 kill 掉正在跑的 bash / pwsh / JS 沙箱子进程。
 * - 每个工具在 spawn 子进程时调用 register(child)
 * - 进程结束时调用 unregister(child)
 * - 用户点「停止」时主进程调用 killAll()，遍历 kill 并清空
 *
 * 同时维护一个全局 aborted 标志：停止后，正在运行的 JS 沙箱在下一次
 * 工具调用前会检测到该标志并主动中止，避免停止后继续执行后续步骤。
 */
const { execFileSync } = require('child_process');

const active = new Set();
// 中止标志按「窗口 + 会话」隔离：A 窗口点停止不应影响 B 窗口，
// 同一窗口内的 A 会话停止也不应影响 B 会话（多标签页/多会话共存）。
// 不传 key 的旧调用点退化为 '__global'，行为与原来一致。
const abortedKeys = new Set();
// 中止原因：key -> 'stop' | 'preempt'
// 为什么要区分：AI 看到「用户停止」应停下等指令，看到「被抢占」则知道自己
// 这轮已被新调用取代、不必重试。文案混用会让 AI 误判用户意图。
const abortReasons = new Map();
const GLOBAL_KEY = '__global';

/**
 * 构造隔离键：窗口 profileId + 会话 sessionId 的复合键。
 *
 * 【为什么必须带 sessionId】只用 profileId 时，同一窗口内切换会话（A → B）
 * 后，A 会话的停止标记会被 B 会话的 isAborted(profileId) 命中，
 * 表现为「B 会话一调用工具就报任务已被用户停止」——跨会话串扰。
 * 复合键让停止/清除/检查三方的粒度一致，都落到具体会话上。
 *
 * @param {string} [profileId] 窗口 profile 标识
 * @param {string} [sessionId] 会话标识
 * @returns {string} 形如 'p::s' 的复合键
 */
function abortKey(profileId, sessionId) {
  return (profileId || 'p') + '::' + (sessionId || 's');
}

// 子进程归属：child -> key（窗口+会话复合键），用于按会话隔离 kill
const owner = new WeakMap();
// 子进程类别：child -> 'foreground' | 'background'
// 为什么需要：抢占新工具调用时只能杀前台阻塞进程；后台任务（构建/服务/爬虫）
// 设计上就是长跑，由 AI 自己 bashKill 收尾，误杀会让用户丢工作成果。
const kindMap = new WeakMap();

/** 被新一轮工具调用抢占时的统一错误文案（AI 能据此理解「上一步没成」） */
const PREEMPT_ERROR = '被新的工具调用抢占，本次执行已中止';

/**
 * 注册一个正在运行的子进程
 * @param {object} child 子进程
 * @param {string} [key] 隔离键
 * @param {'foreground'|'background'} [kind] 类别，默认 foreground
 */
function register(child, key, kind) {
  if (child && typeof child.kill === 'function') {
    active.add(child);
    if (key) owner.set(child, key);
    kindMap.set(child, kind === 'background' ? 'background' : 'foreground');
  }
}

/** 读取子进程类别（未登记的按 foreground 处理，与历史行为一致） */
function getKind(child) {
  return kindMap.get(child) || 'foreground';
}

/** 注销一个已结束的子进程 */
function unregister(child) {
  active.delete(child);
}

/**
 * kill 掉活动子进程（Windows 用 taskkill /T 杀整棵进程树）。
 * @param {string} [key] 只杀属于该 key 的进程。不传则杀全部（兼容旧调用）。
 * @returns {number} 被处理（尝试 kill）的进程数
 */
/**
 * 杀掉一批子进程（Windows 走 taskkill /T 杀整棵进程树）。
 * @param {Set<object>} targets 待杀进程集合
 * @returns {number} 被处理的进程数
 */
function killTargets(targets) {
  let n = 0;
  for (const child of targets) {
    try {
      if (process.platform === 'win32' && child.pid) {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
          { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      } else {
        child.kill('SIGKILL');
      }
      n++;
    } catch (_) {
      try { child.kill('SIGKILL'); n++; } catch (_) { /* ignore */ }
    }
    active.delete(child);
  }
  return n;
}

function killAll(key) {
  const targets = new Set();
  for (const child of active) {
    if (key !== undefined && owner.get(child) !== key) continue;
    targets.add(child);
  }
  return killTargets(targets);
}

/**
 * 只杀属于该 key 的「前台」子进程，后台任务保留。
 * 用于新一轮工具调用抢占：前台阻塞调用该中止，后台长任务不该被牵连。
 * @param {string} key 隔离键
 * @returns {number} 被杀的前台进程数
 */
function killForeground(key) {
  const targets = new Set();
  for (const child of active) {
    if (key !== undefined && owner.get(child) !== key) continue;
    if (getKind(child) !== 'foreground') continue;
    targets.add(child);
  }
  return killTargets(targets);
}

/** 当前活动进程数 */
function count() {
  return active.size;
}

/**
 * 标记为已中止（停止任务时调用）。
 * @param {string} [key] 隔离键（建议用 abortKey(profileId, sessionId)）。
 *   不传则记为全局，影响所有窗口/会话。
 */
/**
 * 标记为已中止（停止任务或抢占时调用）。
 * @param {string} [key] 隔离键（建议用 abortKey(profileId, sessionId)）
 * @param {'stop'|'preempt'} [reason] 中止原因，默认 stop（用户主动停止）
 */
function markAborted(key, reason) {
  const k = key || GLOBAL_KEY;
  abortedKeys.add(k);
  abortReasons.set(k, reason === 'preempt' ? 'preempt' : 'stop');
}

// ========== 执行代际（抢占的正确实现） ==========
//
// 【为什么不能用 markAborted 做抢占】
// 抢占与新执行共用同一个 abortKey。若抢占用 markAborted(key) 标记，
// 新脚本 JsRunner.run() 开头就检测 isAborted(key) → 被自己刚设的标记拦住，
// 表现为「抢占之后什么都跑不起来」。代际把失效粒度精确到某一次执行：
// 抢占让旧代际失效，新执行拿新代际号，互不影响。
const execGen = new Map();   // key -> 当前代际号
let genSeq = 0;

/**
 * 开始一次执行，返回本次的代际号。
 * @param {string} key 隔离键
 * @returns {number} 代际号
 */
function beginExecution(key) {
  genSeq += 1;
  execGen.set(key || GLOBAL_KEY, genSeq);
  return genSeq;
}

/**
 * 本次执行是否仍是该 key 的当前执行。
 * 被抢占后旧执行的代际号不再等于当前值 → 返回 false，据此中止。
 * @param {string} key 隔离键
 * @param {number} gen 代际号
 */
function isCurrentExecution(key, gen) {
  return execGen.get(key || GLOBAL_KEY) === gen;
}

/**
 * 让该 key 的当前执行失效（抢占用），并杀掉其前台子进程。
 * 不产生 abort 标记，因此不会拦住随后的新执行。
 * @param {string} key 隔离键
 * @returns {number} 被杀的前台进程数
 */
function killRunning(key) {
  const k = key || GLOBAL_KEY;
  // 递增代际 = 旧执行失效（不用删，删了旧执行会误判为「当前」）
  genSeq += 1;
  execGen.set(k, genSeq);
  return killForeground(k);
}

/**
 * 执行收尾。只清理匹配的代际，避免旧执行收尾把新执行的状态清掉。
 * @param {string} key 隔离键
 * @param {number} gen 代际号
 */
function endExecution(key, gen) {
  const k = key || GLOBAL_KEY;
  if (execGen.get(k) === gen) execGen.delete(k);
}

/**
 * 读取中止原因。
 * @param {string} [key] 隔离键
 * @returns {'stop'|'preempt'|null} 未标记返回 null
 */
function getAbortReason(key) {
  const k = key || GLOBAL_KEY;
  if (abortReasons.has(k)) return abortReasons.get(k);
  if (abortedKeys.has(GLOBAL_KEY)) return abortReasons.get(GLOBAL_KEY) || 'stop';
  return null;
}

/**
 * 清除中止标志（用户下次发消息时调用）。
 * @param {string} [key] 隔离键。不传则清空全部（兼容旧调用）。
 */
function clearAborted(key) {
  if (key === undefined) {
    abortedKeys.clear();
    abortReasons.clear();
  } else {
    const k = key || GLOBAL_KEY;
    abortedKeys.delete(k);
    abortReasons.delete(k);
  }
}

/**
 * 是否已中止。
 * @param {string} [key] 隔离键（建议用 abortKey(profileId, sessionId)）。
 *   传了：只查该 key 或全局标记。
 *   不传：任一 key 被标记就算中止（兼容旧调用点）。
 */
function isAborted(key) {
  if (key === undefined) return abortedKeys.size > 0;
  return abortedKeys.has(key) || abortedKeys.has(GLOBAL_KEY);
}

module.exports = {
  register, unregister, killAll, killForeground, count, getKind,
  markAborted, clearAborted, isAborted, getAbortReason,
  beginExecution, isCurrentExecution, killRunning, endExecution,
  abortKey, GLOBAL_KEY, PREEMPT_ERROR,
};
