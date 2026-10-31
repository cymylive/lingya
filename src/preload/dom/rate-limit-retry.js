/**
 * 限流退避引擎（移植自 Cuckoo-Code 0.8.19 的 bridge/loop/retry.ts 核心思路）
 *
 * 背景：
 *  DeepSeek 对高频请求有严格风控。原有的 sendToChat 走自适应延迟，但遇到
 *  服务端主动返回限流（429 / biz_code=40029 / "请求过于频繁"文案）时，
 *  继续按原节奏发消息会触发升级处罚（1天 → 3天 → 8天 → 永久封禁）。
 *
 * 本引擎做的事：
 *  1. 监听 lingya-ai-error 事件，识别 reason=rate_limit
 *  2. 立即停止一切自动发送（用户手动发送不受影响）
 *  3. 按 2 分钟 / 5 分钟 / 15 分钟 / 30 分钟 指数退避（4 次上限）
 *  4. 退避期间显示倒计时 Toast，用户可手动取消
 *  5. 退避结束后自动发一条「刚才的回复似乎中断了」重试消息
 *
 * 与原有 sendToChat 的关系：
 *  - 不替换 sendToChat，只在其外部包一层"冷静期"
 *  - 冷静期内 doSendToChat 会检查 state.rateLimitUntil，> now 就丢弃
 *  - 用户主动发消息（tag 不含系统标记）会清空冷静期
 */
const state = require('./state');

// 退避序列（毫秒）：2min → 5min → 15min → 30min
const BACKOFF_MS = [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
// 连续限流计数（成功回复后清零）
let consecutiveRateLimits = 0;
let pendingTimer = null;
let pendingToast = null;
let started = false;

/** 当前是否处于冷静期 */
function isRateLimited() {
  return !!(state.rateLimitUntil && Date.now() < state.rateLimitUntil);
}

/** 剩余冷静期（毫秒） */
function remainingCoolDownMs() {
  if (!state.rateLimitUntil) return 0;
  const ms = state.rateLimitUntil - Date.now();
  return ms > 0 ? ms : 0;
}

/** 清理当前倒计时（保留 rateLimitUntil，不主动解除冷静期） */
function clearTimer() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (pendingToast) { try { pendingToast.remove(); } catch (_) {} pendingToast = null; }
}

/** 显示 Toast 倒计时（复用 overlay 的 showToast，缺省不显示） */
function showCountdownToast(totalMs, onCancel) {
  try {
    const { showToast } = require('../overlay/ui');
    if (!showToast) return;
    const sec = Math.ceil(totalMs / 1000);
    const txt = '⚠️ DeepSeek 限流：已停止自动发送，' + sec + ' 秒后自动重试（点此取消）';
    showToast(txt, totalMs);
    // 尝试捕获 toast 元素做点击取消（overlay 内部实现若支持）
    setTimeout(() => {
      try {
        const el = document.getElementById('lingya-toast');
        if (el) el.onclick = onCancel;
      } catch (_) {}
    }, 50);
  } catch (_) { /* overlay 未就绪时忽略 */ }
}

/** 冷静期结束 → 自动发重试消息 */
function scheduleRetry(delayMs) {
  clearTimer();
  state.rateLimitUntil = Date.now() + delayMs;
  console.log('[LingYa][限流] 进入冷静期 ' + Math.round(delayMs / 1000) + 's（连续第 ' + consecutiveRateLimits + ' 次）');
  showCountdownToast(delayMs, cancelCoolDown);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    state.rateLimitUntil = 0;
    // 冷静期结束：发一条重试消息（tag 标记为系统消息，走随机延迟）
    try {
      const { sendToChat } = require('./chat-input');
      const prompt = '刚才的回复似乎中断了，请重新完整回答上一个问题。';
      sendToChat(prompt, '限流重试', undefined, undefined, { auto: true }).catch(() => {});
      console.log('[LingYa][限流] 冷静期结束，已自动重发重试消息');
    } catch (err) {
      console.error('[LingYa][限流] 冷静期结束发送失败:', err && err.message);
    }
  }, delayMs);
}

/** 用户点击取消 → 解除冷静期（但不清零计数，防止反复触发） */
function cancelCoolDown() {
  clearTimer();
  state.rateLimitUntil = 0;
  try {
    const { showToast } = require('../overlay/ui');
    if (showToast) showToast('已取消限流等待，请注意发送频率', 3000);
  } catch (_) {}
  console.log('[LingYa][限流] 用户取消冷静期');
}

/** 处理 lingya-ai-error */
function handleAiError(detail) {
  if (!detail || detail.reason !== 'rate_limit') return;
  // 用户主动停止状态：不进入冷静期（避免和停止逻辑冲突）
  if (state.stopped) return;
  consecutiveRateLimits++;
  const idx = Math.min(consecutiveRateLimits - 1, BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[idx];
  scheduleRetry(delay);
}

/** 成功回复后重置计数（由 lingya-ai-response 触发） */
function onSuccessResponse(detail) {
  if (!detail || !detail.finished) return;
  if (consecutiveRateLimits > 0) {
    console.log('[LingYa][限流] 收到正常回复，清零连续限流计数（原 ' + consecutiveRateLimits + '）');
    consecutiveRateLimits = 0;
  }
}

/** 启动引擎（幂等） */
function startRateLimitEngine() {
  if (started) return;
  started = true;
  const evtNames = require('./evt-names');
  window.addEventListener(evtNames.AI_ERROR, (ev) => {
    try { handleAiError(ev && ev.detail); } catch (err) {
      console.error('[LingYa][限流] 处理错误事件异常:', err && err.message);
    }
  });
  window.addEventListener(evtNames.AI_RESPONSE, (ev) => {
    try { onSuccessResponse(ev && ev.detail); } catch (_) {}
  });
  console.log('[LingYa][限流] 退避引擎已启动');
}

module.exports = {
  startRateLimitEngine,
  isRateLimited,
  remainingCoolDownMs,
  cancelCoolDown,
};
