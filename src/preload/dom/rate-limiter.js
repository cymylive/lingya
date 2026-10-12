/**
 * 发送限流防护：自适应最小间隔 + 冷却期 + 页面提示检测
 *
 * 背景：DeepSeek 网页版跑 Agent 循环时，每轮回传工具结果都会打一次 API。
 * 默认发送间隔 2-4s（state.sendDelayMin/Max），一个任务几十轮就可能触发账号级限流
 * （页面提示「消息发送过于频繁」，冷却约 10 分钟），任务直接卡死。
 *
 * 三层防护：
 *  A 预防：getWaitMs() —— 发送前统一询问还需等待多久，冷却期 + 自适应间隔取最大值
 *  B 检测：MutationObserver 监听页面短提示文本（限流提示出现即命中）
 *  C 恢复：命中后进入冷却，冷却期内发送自动排队等待，结束自动恢复
 *
 * 设计约束：本模块必须能被纯 Node 加载（供单测），故所有 DOM/electron 访问都做存在性保护。
 */

// ========== 常量 ==========
const COOLDOWN_MS = 10 * 60 * 1000;      // 命中限流后的冷却时长（10 分钟）
const MIN_INTERVAL_STEP = 3000;          // 每次命中后最小间隔增量
const MIN_INTERVAL_MAX = 30000;          // 最小间隔上限
const DETECT_WINDOW_MS = 15000;          // 发送后多久内出现的提示才算限流（防误报）

// 限流提示关键词（页面短文本命中即视为限流）
const RATE_LIMIT_PATTERNS = [
  '发送过于频繁', '请求过于频繁', '操作过于频繁', '访问过于频繁',
  '频率过高', '请稍后重试', '稍后再试', '达到上限',
  'too many requests', 'rate limit', 'ratelimited', 'slow down', 'try again later',
];

// ========== 状态 ==========
let cooldownUntil = 0;
let minInterval = 0;
let lastSentAt = 0;
let rateLimitHits = 0;
let observer = null;
let countdownTimer = null;
const listeners = new Set();

function nowMs() { return Date.now(); }

// ========== 纯逻辑（可单测） ==========

/** 剩余冷却毫秒数（0 = 不在冷却） */
function getCooldownRemaining(atMs) {
  const t = typeof atMs === 'number' ? atMs : nowMs();
  return Math.max(0, cooldownUntil - t);
}

/** 是否处于冷却期 */
function isCooling(atMs) { return getCooldownRemaining(atMs) > 0; }

/**
 * 发送前询问：还需等待多少毫秒才能发。
 * 取「冷却剩余」与「距上次发送是否够 minInterval」的较大值。
 */
function getWaitMs(atMs) {
  const t = typeof atMs === 'number' ? atMs : nowMs();
  const cd = getCooldownRemaining(t);
  const intervalWait = lastSentAt ? Math.max(0, minInterval - (t - lastSentAt)) : 0;
  return Math.max(cd, intervalWait);
}

/** 标记「刚刚发送了一条」 */
function markSent(atMs) { lastSentAt = typeof atMs === 'number' ? atMs : nowMs(); }

/**
 * 计算命中限流后的新状态（纯函数，便于测试）
 * @returns {{cooldownUntil:number, minInterval:number}}
 */
function computeAfterRateLimit(atMs, cooldownMs) {
  const t = typeof atMs === 'number' ? atMs : nowMs();
  const dur = Number(cooldownMs) > 0 ? Number(cooldownMs) : COOLDOWN_MS;
  return {
    cooldownUntil: Math.max(cooldownUntil, t + dur),
    minInterval: Math.min(MIN_INTERVAL_MAX, minInterval + MIN_INTERVAL_STEP),
  };
}

/** 文本是否像限流提示 */
function looksLikeRateLimit(text) {
  if (!text) return false;
  const s = String(text).trim().toLowerCase();
  if (!s || s.length > 120) return false;   // 长文本大概率是 AI 回复正文，不是系统提示
  for (const p of RATE_LIMIT_PATTERNS) {
    if (s.indexOf(p.toLowerCase()) !== -1) return true;
  }
  return false;
}

// ========== 状态变更与通知 ==========

function notifyListeners() {
  const remaining = getCooldownRemaining();
  for (const cb of listeners) {
    try { cb(remaining); } catch (_) { /* ignore */ }
  }
}

/** 订阅冷却状态变化，返回取消函数 */
function onCooldownChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  try { cb(getCooldownRemaining()); } catch (_) {}
  return () => listeners.delete(cb);
}

/**
 * 命中限流：进入冷却 + 提升最小间隔
 * @param {number} [cooldownMs] 自定义冷却时长
 * @param {string} [reason] 命中来源（日志用）
 */
function triggerCooldown(cooldownMs, reason) {
  const next = computeAfterRateLimit(nowMs(), cooldownMs);
  cooldownUntil = next.cooldownUntil;
  minInterval = next.minInterval;
  rateLimitHits++;
  const secs = Math.round(getCooldownRemaining() / 1000);
  console.log('[LingYa][限流] 命中（' + (reason || 'unknown') + '），冷却 ' + secs +
    's，最小间隔提升至 ' + minInterval + 'ms（累计 ' + rateLimitHits + ' 次）');
  try {
    const { showToast } = require('../overlay/ui');
    if (showToast) showToast('⚠️ 触发平台限流，已冷却 ' + Math.round(secs / 60) + ' 分钟', 4000);
  } catch (_) { /* 单测环境无 ui 模块 */ }
  startCountdown();
  notifyListeners();
}

// ========== 冷却倒计时（驱动 UI） ==========

function startCountdown() {
  if (countdownTimer) return;
  // 无监听者（纯 Node 测试 / UI 未启动）时不空转定时器，避免进程无法退出
  if (listeners.size === 0) return;
  countdownTimer = setInterval(() => {
    notifyListeners();
    if (!isCooling()) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      console.log('[LingYa][限流] 冷却结束，恢复正常发送');
    }
  }, 1000);
}

// ========== 页面提示检测（MutationObserver） ==========

let lastDetectAt = 0;

function checkNodeForRateLimit(node) {
  if (!node || node.nodeType !== 1) return;
  // 只在「刚发送过」的时间窗内检测，避免 AI 回复正文里出现关键词造成误报
  const sinceSend = nowMs() - lastSentAt;
  if (!lastSentAt || sinceSend > DETECT_WINDOW_MS) return;
  const text = (node.textContent || '').trim();
  if (!looksLikeRateLimit(text)) return;
  const t = nowMs();
  if (t - lastDetectAt < 3000) return;   // 去抖：3 秒内只触发一次
  lastDetectAt = t;
  triggerCooldown(0, '页面提示: ' + text.slice(0, 40));
}

/** 监听主世界 hook 派发的限流事件（HTTP 429 / 响应体关键词） */
function startRateLimitEventListener() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  if (window.__lingyaRateLimitListenerAttached__) return;
  window.__lingyaRateLimitListenerAttached__ = true;
  window.addEventListener('lingya-ai-ratelimited', function (ev) {
    var reason = (ev && ev.detail && ev.detail.reason) || 'hook';
    // hook 已明确判定限流，直接进入完整冷却
    triggerCooldown(0, 'hook: ' + reason);
  });
  console.log('[LingYa][限流] hook 限流事件监听已启动');
}

/** 启动页面提示监听（幂等） */
function startRateLimitWatcher() {
  startRateLimitEventListener();
  if (observer) return;
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes || []) checkNodeForRateLimit(node);
    }
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[LingYa][限流] 页面提示监听已启动');
  } catch (err) {
    console.error('[LingYa][限流] 监听启动失败:', err && err.message);
  }
}

/** 停止监听（测试/清理用） */
function stopRateLimitWatcher() {
  if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  // 事件监听挂在 window 上，重置标记以便重新启动
  if (typeof window !== 'undefined') {
    try { delete window.__lingyaRateLimitListenerAttached__; } catch (_) {}
  }
}

// ========== 测试辅助 ==========

/** 重置全部状态（仅测试用） */
function __reset() {
  cooldownUntil = 0; minInterval = 0; lastSentAt = 0; rateLimitHits = 0; lastDetectAt = 0;
  stopRateLimitWatcher();
  listeners.clear();
}

module.exports = {
  // 常量（供测试与配置参考）
  COOLDOWN_MS, MIN_INTERVAL_STEP, MIN_INTERVAL_MAX, DETECT_WINDOW_MS, RATE_LIMIT_PATTERNS,
  // 发送前询问
  getWaitMs, markSent, getCooldownRemaining, isCooling,
  // 命中处理
  triggerCooldown, onCooldownChange,
  // 检测
  startRateLimitWatcher, stopRateLimitWatcher, startRateLimitEventListener, looksLikeRateLimit,
  // 纯函数（测试用）
  computeAfterRateLimit,
  // 测试辅助
  __reset,
};