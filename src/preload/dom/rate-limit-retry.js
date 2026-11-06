/**
 * 失败自动重试引擎（对齐 Cuckoo-Code 0.8.19 的 bridge/loop/retry.ts）
 *
 * 三类失败：
 *  1. 普通失败（http/biz/network）→ retryDelayMin~retryDelayMax 秒随机，最多 retryCount 次
 *  2. 操作频繁（429 / biz_code=40029 / 限流文案）→ retry429Delay 秒等待，最多 retry429Count 次
 *  3. AI 回复超时（watchdog，静默超时）→ 发 watchdogPrompt，最多 watchdogCount 次
 *
 * 配置来源：localStorage（每窗口独立，即时生效）
 *  - lingya-retry-enabled         '1' | '0'  默认 '1'
 *  - lingya-retry-delay-min       毫秒，默认 4000（UI 显示秒）
 *  - lingya-retry-delay-max       毫秒，默认 10000
 *  - lingya-retry-count           普通失败次数，默认 10；负数=无限
 *  - lingya-retry-429-delay       毫秒，默认 120000（2 分钟）
 *  - lingya-retry-429-count       429 次数，默认 40；负数=无限
 *  - lingya-retry-prompt          重试提示词
 *  - lingya-xhr-idle-timeout      毫秒，默认 300000（5 分钟）；<=0 禁用
 *  - lingya-watchdog-prompt       超时重试提示词
 *  - lingya-watchdog-count        超时重试次数，默认 10；负数=无限
 *
 * 与原有 sendToChat 的关系：
 *  - 不替换 sendToChat，只在外部包一层"冷静期"
 *  - 冷静期内 doSendToChat 会检查 state.rateLimitUntil，> now 就丢弃
 *  - 用户主动发消息（tag 不含系统标记）会清空冷静期
 */
const state = require('./state');

const DEFAULTS = {
  enabled: true,
  delayMin: 4000,      // 普通失败：4 秒
  delayMax: 10000,     // 普通失败：10 秒
  count: 10,           // 普通失败：10 次
  delay429: 120000,    // 429：2 分钟
  count429: 40,        // 429：40 次
  prompt: '刚才的回复似乎中断了，请重新完整回答上一个问题。',
  idleTimeout: 300000, // 超时：5 分钟
  watchdogPrompt: '请继续',
  watchdogCount: 10,
};

let normalCount = 0;
let count429 = 0;
let watchdogCount = 0;
let pendingTimer = null;
let watchdogTimer = null;
let lastStreamAt = 0;
let started = false;

/** 读取配置（localStorage + 默认值） */
function readConfig() {
  const cfg = Object.assign({}, DEFAULTS);
  try {
    const en = localStorage.getItem('lingya-retry-enabled');
    if (en !== null) cfg.enabled = en === '1';
    const dmin = parseInt(localStorage.getItem('lingya-retry-delay-min') || '', 10);
    if (Number.isFinite(dmin)) cfg.delayMin = dmin;
    const dmax = parseInt(localStorage.getItem('lingya-retry-delay-max') || '', 10);
    if (Number.isFinite(dmax)) cfg.delayMax = dmax;
    const cnt = parseInt(localStorage.getItem('lingya-retry-count') || '', 10);
    if (Number.isFinite(cnt)) cfg.count = cnt;
    const d429 = parseInt(localStorage.getItem('lingya-retry-429-delay') || '', 10);
    if (Number.isFinite(d429)) cfg.delay429 = d429;
    const c429 = parseInt(localStorage.getItem('lingya-retry-429-count') || '', 10);
    if (Number.isFinite(c429)) cfg.count429 = c429;
    const p = localStorage.getItem('lingya-retry-prompt');
    if (p) cfg.prompt = p;
    const idle = parseInt(localStorage.getItem('lingya-xhr-idle-timeout') || '', 10);
    if (Number.isFinite(idle)) cfg.idleTimeout = idle;
    const wp = localStorage.getItem('lingya-watchdog-prompt');
    if (wp) cfg.watchdogPrompt = wp;
    const wc = parseInt(localStorage.getItem('lingya-watchdog-count') || '', 10);
    if (Number.isFinite(wc)) cfg.watchdogCount = wc;
  } catch (_) { /* ignore */ }
  return cfg;
}

function pickDelay(min, max) {
  if (!Number.isFinite(min) || min < 0) min = 0;
  if (!Number.isFinite(max) || max < min) max = min;
  if (min === max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 清理倒计时 */
function clearTimer() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
}

/** 冷静期判断 */
function isRateLimited() {
  return !!(state.rateLimitUntil && Date.now() < state.rateLimitUntil);
}

function remainingCoolDownMs() {
  if (!state.rateLimitUntil) return 0;
  const ms = state.rateLimitUntil - Date.now();
  return ms > 0 ? ms : 0;
}

/** 显示倒计时 Toast */
function showCountdownToast(totalMs, label, onCancel) {
  try {
    const { showToast } = require('../overlay/ui');
    if (!showToast) return;
    const sec = Math.ceil(totalMs / 1000);
    const txt = '⚠️ ' + label + '：已停止自动发送，' + sec + ' 秒后自动重试';
    showToast(txt, totalMs);
    if (onCancel) {
      setTimeout(() => {
        try {
          const el = document.getElementById('lingya-toast');
          if (el) el.onclick = onCancel;
        } catch (_) {}
      }, 50);
    }
  } catch (_) {}
}

/** 冷静期结束 → 发重试消息 */
function scheduleRetry(delayMs, prompt, label) {
  clearTimer();
  state.rateLimitUntil = Date.now() + delayMs;
  showCountdownToast(delayMs, label, cancelCoolDown);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    state.rateLimitUntil = 0;
    try {
      const { sendToChat } = require('./chat-input');
      sendToChat(prompt, '重试', undefined, undefined, { auto: true }).catch(() => {});
      console.log('[LingYa][重试] 冷静期结束，已自动重发：' + label);
    } catch (err) {
      console.error('[LingYa][重试] 冷静期结束发送失败:', err && err.message);
    }
  }, delayMs);
  console.log('[LingYa][重试] 进入冷静期 ' + Math.round(delayMs / 1000) + 's（' + label + '）');
}

function cancelCoolDown() {
  clearTimer();
  state.rateLimitUntil = 0;
  try {
    const { showToast } = require('../overlay/ui');
    if (showToast) showToast('已取消等待，请注意发送频率', 3000);
  } catch (_) {}
  console.log('[LingYa][重试] 用户取消冷静期');
}

/** 处理 AI_ERROR 事件 */
function handleAiError(detail) {
  if (!detail) return;
  if (state.stopped) return;   // 用户主动停止不重试
  const cfg = readConfig();
  if (!cfg.enabled) return;

  const is429 = detail.reason === 'rate_limit';

  if (is429) {
    if (cfg.count429 >= 0 && count429 >= cfg.count429) {
      console.log('[LingYa][重试] 429 已达上限 ' + cfg.count429 + ' 次，停止重试');
      return;
    }
    count429++;
    scheduleRetry(cfg.delay429, cfg.prompt, '操作频繁重试');
  } else {
    if (cfg.count >= 0 && normalCount >= cfg.count) {
      console.log('[LingYa][重试] 普通失败已达上限 ' + cfg.count + ' 次，停止重试');
      return;
    }
    normalCount++;
    const delay = pickDelay(cfg.delayMin, cfg.delayMax);
    scheduleRetry(delay, cfg.prompt, '失败重试');
  }
}

/** 成功回复后重置 */
function onSuccessResponse(detail) {
  if (!detail || !detail.finished) return;
  // 【2026-11-01 修复】中断（interrupted=true）不是成功，不清零计数
  if (detail.interrupted) {
    console.log('[LingYa][重试] 收到中断回复（interrupted=true），不清零计数');
    return;
  }
  if (normalCount > 0 || count429 > 0) {
    console.log('[LingYa][重试] 成功回复，清零重试计数');
    normalCount = 0;
    count429 = 0;
  }

  watchdogCount = 0;
  clearTimer();
}

/** ===== Watchdog（超时重试）===== */
function startWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  lastStreamAt = Date.now();
  const cfg = readConfig();
  if (!cfg.enabled || cfg.idleTimeout <= 0) return;
  if (watchdogCount >= cfg.watchdogCount && cfg.watchdogCount >= 0) return;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    // 已收到数据（AI 正在生成）→ 不触发
    if (Date.now() - lastStreamAt < cfg.idleTimeout) return;
    // 用户停止中 → 不触发
    if (state.stopped) return;
    watchdogCount++;
    console.log('[LingYa][重试] Watchdog 触发：' + (cfg.idleTimeout / 1000) + 's 无数据，发提示词');
    try {
      const { sendToChat } = require('./chat-input');
      sendToChat(cfg.watchdogPrompt, '超时重试', undefined, undefined, { auto: true }).catch(() => {});
    } catch (err) {
      console.error('[LingYa][重试] watchdog 发送失败:', err && err.message);
    }
    // 再启动一次（链式重试）
    startWatchdog();
  }, cfg.idleTimeout);
}

function onStreamData() {
  lastStreamAt = Date.now();
}

function onAiStart() {
  startWatchdog();
}

/** 启动引擎（幂等） */
function startRateLimitEngine() {
  if (started) return;
  started = true;
  const evtNames = require('./evt-names');
  window.addEventListener(evtNames.AI_ERROR, (ev) => {
    try { handleAiError(ev && ev.detail); } catch (err) {
      console.error('[LingYa][重试] 处理错误事件异常:', err && err.message);
    }
  });
  window.addEventListener(evtNames.AI_RESPONSE, (ev) => {
    try { onSuccessResponse(ev && ev.detail); } catch (_) {}
  });
  window.addEventListener(evtNames.AI_STREAM, () => {
    try { onStreamData(); } catch (_) {}
  });
  window.addEventListener(evtNames.AI_START, () => {
    try { onAiStart(); } catch (_) {}
  });
  console.log('[LingYa][重试] 引擎已启动（重试 + watchdog）');
}

module.exports = {
  startRateLimitEngine,
  isRateLimited,
  remainingCoolDownMs,
  cancelCoolDown,
  readConfig,
};
