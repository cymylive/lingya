/* 灵鸦远程 · 手机桌宠
 * 对外 API：window.LingyaPet.mount(container, opts) / setState(s)
 * 状态：thinking / working / waiting / idle / done / error
 * 交互：横向拖动记忆位置；竖向滑动交给页面滚动（touch-action: pan-y）
 */
(function () {
'use strict';

var PET_SVG = '<svg class="ly-pet" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path class="ly-tail" d="M50 36 Q59 43 61 51 Q54 48 50 45 Q56 52 54 57 Q47 50 45 41 Z"/>'
  + '<path class="ly-wing" d="M36 28 Q47 34 44 47 Q34 42 31 30 Z"/>'
  + '<ellipse class="ly-body" cx="33" cy="37" rx="17" ry="15"/>'
  + '<circle class="ly-head" cx="24" cy="23" r="12.5"/>'
  + '<path class="ly-beak" d="M11.5 22.5 L2.5 25.5 L11.5 28.5 Z"/>'
  + '<circle class="ly-eye" cx="19.5" cy="20.5" r="2.7"/>'
  + '</svg>';

var DEFAULT_STORAGE = 'lingya-pet-x';
var PET_W = 56;

var el = null;
var container = null;
var storageKey = DEFAULT_STORAGE;
var dragging = false;
var moved = false;
var startX = 0;
var startLeft = 0;

function clampX(x) {
  var w = (el && el.offsetWidth) || PET_W;
  var max = window.innerWidth - w - 4;
  return Math.max(4, Math.min(x, Math.max(4, max)));
}

function readX() {
  try {
    var raw = localStorage.getItem(storageKey);
    if (raw == null) return 8;
    var n = parseInt(raw, 10);
    return isFinite(n) ? n : 8;
  } catch (_) { return 8; }
}

function saveX(x) {
  try { localStorage.setItem(storageKey, String(x)); } catch (_) {}
}

function applyLeft(x) {
  if (!el) return;
  var px = clampX(x);
  el.style.left = px + 'px';
  return px;
}

function onDown(e) {
  if (!el) return;
  dragging = true;
  moved = false;
  var t = e.touches ? e.touches[0] : e;
  startX = t.clientX;
  startLeft = parseInt(el.style.left || '8', 10);
  el.classList.add('dragging');
}

function onMove(e) {
  if (!dragging) return;
  var t = e.touches ? e.touches[0] : e;
  var dx = t.clientX - startX;
  if (Math.abs(dx) > 4) moved = true;
  applyLeft(startLeft + dx);
}

function onUp() {
  if (!dragging) return;
  dragging = false;
  if (el) el.classList.remove('dragging');
  if (moved) {
    var px = applyLeft(parseInt(el.style.left || '8', 10));
    saveX(px);
  }
}

function bindDragEvents() {
  el.addEventListener('touchstart', onDown, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: true });
  el.addEventListener('touchend', onUp);
  el.addEventListener('touchcancel', onUp);
  el.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', function () {
    if (el) applyLeft(parseInt(el.style.left || '8', 10));
  });
}

function setState(s) {
  if (!el) return;
  var st = String(s || 'idle');
  el.className = 'ly-pet-wrap st-' + st + (dragging ? ' dragging' : '');
}

function mount(c, opts) {
  try {
    container = c || document.body;
    storageKey = (opts && opts.storageKey) || DEFAULT_STORAGE;
    el = document.createElement('div');
    el.className = 'ly-pet-wrap st-idle';
    el.innerHTML = PET_SVG;
    el.style.left = applyLeft(readX()) + 'px';
    container.appendChild(el);
    bindDragEvents();
  } catch (_) { el = null; }
}

function unmount() {
  if (el && el.parentNode) el.parentNode.removeChild(el);
  el = null;
}

window.LingyaPet = { mount: mount, unmount: unmount, setState: setState };

// 兜底：如果页面未显式调 mount（老版本 app.js），DOM 就绪后自动挂到 body
if (!window.__LINGYA_PET_AUTO) {
  window.__LINGYA_PET_AUTO = true;
  var auto = function () {
    if (!el && !window.__LINGYA_PET_MOUNTED) {
      // 若 app.js 在之后才 mount，这里不重复挂载
      setTimeout(function () {
        if (!el && !window.__LINGYA_PET_MOUNTED) {
          mount(document.body, { storageKey: DEFAULT_STORAGE });
          window.__LINGYA_PET_MOUNTED = true;
        }
      }, 100);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
}
})();
