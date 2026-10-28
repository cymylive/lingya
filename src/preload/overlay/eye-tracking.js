/**
 * 眼珠跟随鼠标 —— 鼠标在窗口内时，悬浮球宠物的眼睛朝鼠标方向偏移。
 *
 * 与现有两套眼部动效的关系：
 *   - 眨眼：.lingya-pet-eye 的 transform: scaleY()（CSS 动画），互不干扰
 *   - 左右扫视：.lingya-pet-eye-scan 的 translate 动画（idle 时生效）
 *   - 跟随：也用 translate，会和扫视打架 → 跟随期间给 badge 加 .lingya-eye-tracking，
 *     该状态类在 template.js 里把扫视动画关掉，只保留眨眼，位移由 CSS 变量驱动。
 *
 * 位移用 CSS 变量 --lingya-eye-dx/dy 传给 .lingya-pet-eye 的 translate 属性，
 * 变量设在 #lingya-status-badge 上，靠 CSS 变量继承作用到内部所有眼睛。
 *
 * 为什么用 rAF 节流：overlay 注入在 AI 网页里，pointermove 高频触发，
 * 不节流会拖累聊天框输入。
 */

/** 眼睛最大偏移量（px） */
const MAX_OFFSET = 1.8;

/** 距离参照：鼠标离眼睛超过这个距离后偏移量拉满 */
const RANGE = 140;

let started = false;
let rafId = 0;
let pending = null;

/** 取 badge 元素（不存在时返回 null，所有函数都做空值兜底） */
function getBadge() {
  try { return document.getElementById('lingya-status-badge'); } catch (_) { return null; }
}

/** 宠物被用户关掉时不跟随 */
function isPetOff() {
  try {
    return !!(document.body && document.body.classList.contains('lingya-pet-off'));
  } catch (_) { return false; }
}

/**
 * 计算眼睛应当的偏移量。
 * @param {number} x 鼠标 clientX
 * @param {number} y 鼠标 clientY
 * @returns {{dx:number,dy:number}|null} 无法计算时返回 null
 */
function computeOffset(x, y) {
  const badge = getBadge();
  if (!badge) return null;
  if (isPetOff()) return null;

  // 优先以眼睛自身中心为基准；眼睛缺失时退回 badge 中心
  const eye = badge.querySelector('.lingya-pet-eye');
  const el = eye || badge;
  let rect = null;
  try { rect = el.getBoundingClientRect(); } catch (_) { return null; }
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const vx = x - cx;
  const vy = y - cy;
  const dist = Math.sqrt(vx * vx + vy * vy);
  if (!(dist > 0.001)) return { dx: 0, dy: 0 };

  // 距离越远偏移越大，超过 RANGE 拉满（避免近距离直接跳到边缘）
  const ratio = Math.min(dist / RANGE, 1);
  const amount = ratio * MAX_OFFSET;
  return {
    dx: (vx / dist) * amount,
    dy: (vy / dist) * amount,
  };
}

/** 把偏移写进 CSS 变量并确保跟随状态类存在 */
function applyOffset(dx, dy) {
  const badge = getBadge();
  if (!badge) return;
  if (!badge.classList.contains('lingya-eye-tracking')) {
    badge.classList.add('lingya-eye-tracking');
  }
  badge.style.setProperty('--lingya-eye-dx', dx.toFixed(2) + 'px');
  badge.style.setProperty('--lingya-eye-dy', dy.toFixed(2) + 'px');
}

/** 归零并退出跟随状态，让 CSS 的左右扫视动画恢复 */
function resetEyes() {
  const badge = getBadge();
  if (!badge) return;
  badge.classList.remove('lingya-eye-tracking');
  badge.style.setProperty('--lingya-eye-dx', '0px');
  badge.style.setProperty('--lingya-eye-dy', '0px');
}

function onPointerMove(e) {
  pending = { x: e.clientX, y: e.clientY };
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const p = pending;
    pending = null;
    if (!p) return;
    const r = computeOffset(p.x, p.y);
    if (!r) return;
    applyOffset(r.dx, r.dy);
  });
}

function onPointerLeave() {
  if (rafId) {
    try { cancelAnimationFrame(rafId); } catch (_) {}
    rafId = 0;
  }
  pending = null;
  resetEyes();
}

/**
 * 启动眼珠跟随。重复调用安全（幂等）。
 */
function startEyeTracking() {
  if (started) return;
  started = true;
  try {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    // 鼠标移出文档（进标题栏/外部）时归零，否则眼睛会卡在最后方向
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    window.addEventListener('blur', onPointerLeave);
  } catch (err) {
    console.error('[LingYa] 眼珠跟随监听注册失败:', err);
  }
}

/** 停止跟随并归零（留给后续「关闭动效」开关使用） */
function stopEyeTracking() {
  if (!started) return;
  started = false;
  try {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('blur', onPointerLeave);
  } catch (_) {}
  onPointerLeave();
}

module.exports = {
  startEyeTracking,
  stopEyeTracking,
  computeOffset,
  resetEyes,
  MAX_OFFSET,
  RANGE,
};
