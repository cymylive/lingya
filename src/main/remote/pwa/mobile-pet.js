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

var LS_X = 'lingya-pet-x';
var el = null;
var dragging = false;
var moved = false;
var startX = 0;
var startLeft = 0;

function clampX(x) {
  var w = el.offsetWidth || 64;
  var max = window.innerWidth - w - 4;
  return Math.max(4, Math.min(x, Math.max(4, max)));
}

function place(x) {
  el.style.left = clampX(x) + 'px';
  try { localStorage.setItem(LS_X, String(el.style.left)); } catch (_) {}
}

function onDown(e) {
  dragging = true; moved = false;
  var t = e.touches ? e.touches[0] : e;
  startX = t.clientX;
  startLeft = parseInt(el.style.left || '4', 10);
}

function onMove(e) {
  if (!dragging) return;
  var t = e.touches ? e.touches[0] : e;
  var dx = t.clientX - startX;
  if (Math.abs(dx) > 4) moved = true;
  el.style.left = clampX(startLeft + dx) + 'px';
}

function onUp() {
  if (!dragging) return;
  dragging = false;
  if (moved) place(parseInt(el.style.left || '4', 10));
}

function setState(s) {
  if (!el) return;
  el.className = 'ly-pet-wrap st-' + (s || 'idle');
}

function init() {
  try {
    el = document.createElement('div');
    el.className = 'ly-pet-wrap st-idle';
    el.innerHTML = PET_SVG;
    el.style.left = localStorage.getItem(LS_X) || '8px';
    document.body.appendChild(el);
    el.addEventListener('touchstart', onDown, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onUp);
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', function () { place(parseInt(el.style.left || '4', 10)); });
  } catch (_) { el = null; }
}

window.LingyaPet = { setState: setState };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
