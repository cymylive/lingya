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
const { getFabState, showToast } = require('../overlay/ui');
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
async function checkOnce() {
  if (state.stopped) return;                       // 用户已停止
  if (state.awaitingRefusalRewrite) return;        // 正在等改写回复
  if (state.awaitingUserInput) return;             // AI 在等用户回答，不该催
  const fab = getFabState();
  if (fab === 'executing' || fab === 'generating') return; // 正在忙

  const { enabled, stallMs, max } = await loadConfig();
  if (!enabled) return;

  const now = Date.now();
  const idleMs = now - (state.lastActivityAt || 0);
  if (idleMs < stallMs) return; // 还没停滞

  // 查该会话 todo：只有"有计划且未完成"才触发（保守，避免误伤闲聊）
  let res;
  try { res = await window.electronAPI.getTodos(); } catch (_) { return; }
  const todos = (res && res.success && Array.isArray(res.todos)) ? res.todos : [];
  const unfinished = todos.filter((t) => t && t.status !== 'completed');
  if (unfinished.length === 0) { stallCount = 0; return; }

  // 停滞计数（时间窗口内累加，超窗口重置）
  if (now - lastStallAt > STALL_WINDOW_MS) stallCount = 0;
  lastStallAt = now;
  if (stallCount >= max) {
    console.log('[LingYa][监督] 已达停滞催促上限 ' + max + '，停止');
    return;
  }
  stallCount++;

  const next = unfinished.find((t) => t.status === 'in_progress') || unfinished[0];
  console.log('[LingYa][监督] 检测到停滞 ' + Math.round(idleMs / 1000) + 's，任务剩 ' +
    unfinished.length + ' 项，第 ' + stallCount + ' 次催促');
  try { showToast('检测到任务停滞，已自动催促继续', 3000); } catch (_) { /* ignore */ }
  sendMessageToChat(
    '【监督续跑】检测到你已经 ' + Math.round(idleMs / 1000) + ' 秒没有动作，但任务计划尚未完成（还剩 ' +
    unfinished.length + ' 项）。请立即继续执行：' + next.content +
    '。不要停下来等用户确认；若任务确已完成，请用一句话明确说明"任务已完成"并更新 todo。',
    '监督续跑'
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
}

module.exports = { startSupervisor, stopSupervisor, resetStall, checkOnce };
