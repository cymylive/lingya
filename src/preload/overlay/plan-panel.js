/**
 * 计划（todoWrite）面板：渲染 AI 的待办列表，实时刷新。
 */
/** 转义 HTML（本模块内联，避免 require('./ui') 把 electron 依赖链拉进单测） */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_ICON = {
  pending: '○',        // ○
  in_progress: '◐',    // ◐
  completed: '✔',      // ✔
};

let unsubscribe = null;
// 悬浮卡是否处于最小化态（持久化）
let minimized = false;

/** 生成列表项 HTML */
function itemsHtml(items) {
  return items.map((t, i) => {
    const st = STATUS_ICON[t.status] ? t.status : 'pending';
    return '<div class="lingya-plan-item ' + st + '">' +
      '<span class="lingya-plan-num">' + (i + 1) + '.</span>' +
      '<span class="lingya-plan-ico ' + st + '">' + STATUS_ICON[st] + '</span>' +
      '<span class="lingya-plan-text">' + escapeHtml(t.content) + '</span>' +
    '</div>';
  }).join('');
}

/** 渲染待办列表（同时刷新页签面板 + 悬浮卡） */
function renderTodos(todos) {
  const items = Array.isArray(todos) ? todos : [];
  const done = items.filter((t) => t.status === 'completed').length;
  const progress = done + '/' + items.length;
  const hasItems = items.length > 0;

  // 页签面板
  const list = document.getElementById('lingya-plan-list');
  const count = document.getElementById('lingya-plan-count');
  if (count) count.textContent = progress;
  if (list) {
    list.innerHTML = hasItems
      ? itemsHtml(items)
      : '<div class="lingya-plan-empty">暂无计划。AI 使用 todoWrite 时会显示在这里。</div>';
  }

  // 页签角标
  const tabCount = document.getElementById('lingya-plan-tab-count');
  if (tabCount) tabCount.textContent = hasItems ? ' ' + progress : '';

  // 悬浮卡：常驻显示（空列表显示占位）
  const float = document.getElementById('lingya-plan-float');
  const floatList = document.getElementById('lingya-plan-float-list');
  const floatCount = document.getElementById('lingya-plan-float-count');
  if (floatCount) floatCount.textContent = progress;
  if (floatList) {
    floatList.innerHTML = hasItems
      ? itemsHtml(items)
      : '<div class="lingya-plan-empty">暂无计划</div>';
  }
  if (float) float.classList.remove('lingya-hidden');
}

/** 拉取一次当前计划 */
async function refreshTodos() {
  try {
    const r = await window.electronAPI.getTodos();
    if (r && r.success) {
      renderTodos(r.todos);
      const el = document.getElementById('lingya-plan-session');
      if (el) el.textContent = r.sessionId ? String(r.sessionId).slice(0, 10) : '(新会话)';
    }
  } catch (e) {
    console.error('[LingYa] 读取计划失败:', e && e.message);
  }
}

let lastUrl = null;

/** 让悬浮计划卡可拖拽：pointerdown 绑把手，pointermove/up 绑 window（不依赖 setPointerCapture，兼容被遮挡/冒泡拦截场景） */
function makeFloatDraggable(el, handle) {
  const POS_KEY = 'lingya-plan-float-pos';
  const THRESHOLD = 4;
  let dragging = false, moved = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  function applyPos(left, top) {
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 120;
    left = Math.max(0, Math.min(left, window.innerWidth - w));
    top = Math.max(0, Math.min(top, window.innerHeight - h));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const p = JSON.parse(saved);
      if (typeof p.left === 'number' && typeof p.top === 'number') applyPos(p.left, p.top);
    }
  } catch (_) {}

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
    moved = true;
    applyPos(startLeft + dx, startTop + dy);
    if (e.cancelable) e.preventDefault();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    if (moved) {
      try {
        const rect = el.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (_) {}
    }
  }

  function startDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (dragging) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    // 双通道：pointer 优先，mouse 兜底（部分宿主页面屏蔽 pointer 事件）
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }
  handle.addEventListener('pointerdown', startDrag, true);
  handle.addEventListener('mousedown', startDrag, true);

  window.addEventListener('resize', () => {
    const rect = el.getBoundingClientRect();
    applyPos(rect.left, rect.top);
  });
}

/** 监听 URL 变化（切换会话）时重拉计划。
 *  DeepSeek 是 SPA，pushState 不触发 popstate，故用定时轮询兜底。 */
function watchSessionChange() {
  lastUrl = window.location.href;
  const check = () => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      refreshTodos();
    }
  };
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  setInterval(check, 800);
}

/** 绑定计划面板：首次拉取 + 订阅变更 + 会话切换时重拉 + 悬浮卡拖拽 */
function bindPlanPanelEvents() {
  refreshTodos();
  if (!unsubscribe) {
    // 收到变更通知后重新拉取"当前会话"的权威数据（而非直接用广播内容），保证会话隔离
    unsubscribe = window.electronAPI.onTodosUpdated(() => refreshTodos());
  }
  watchSessionChange();

  const float = document.getElementById('lingya-plan-float');
  const head = document.getElementById('lingya-plan-float-head');
  const minBtn = document.getElementById('lingya-plan-float-close');
  if (float && head) makeFloatDraggable(float, head);
  initOpacityControl();

  // 最小化态持久化
  try { minimized = localStorage.getItem('lingya-plan-float-minimized') === '1'; } catch (_) {}
  applyMinimized();
  if (minBtn) {
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimized = !minimized;
      try { localStorage.setItem('lingya-plan-float-minimized', minimized ? '1' : '0'); } catch (_) {}
      applyMinimized();
    });
  }
}

/** 应用最小化态：折叠列表、切换按钮图标 */
function applyMinimized() {
  const float = document.getElementById('lingya-plan-float');
  const btn = document.getElementById('lingya-plan-float-close');
  if (float) float.classList.toggle('lingya-minimized', minimized);
  if (btn) {
    btn.textContent = minimized ? '+' : '−';
    btn.title = minimized ? '展开' : '最小化';
  }
}

/** 透明度控制：滑块 ↔ CSS 变量 ↔ localStorage */
function initOpacityControl() {
  const slider = document.getElementById('lingya-plan-opacity');
  const label = document.getElementById('lingya-plan-opacity-val');
  if (!slider) return;

  function apply(pct) {
    const v = Math.max(20, Math.min(100, pct)) / 100;
    document.documentElement.style.setProperty('--lingya-float-opacity', String(v));
    if (label) label.textContent = Math.round(v * 100) + '%';
  }

  // 恢复已保存的值
  let saved = 85;
  try {
    const raw = localStorage.getItem('lingya-plan-float-opacity');
    if (raw) saved = parseInt(raw, 10) || 85;
  } catch (_) {}
  slider.value = String(saved);
  apply(saved);

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10) || 85;
    apply(v);
    try { localStorage.setItem('lingya-plan-float-opacity', String(v)); } catch (_) {}
  });
}

module.exports = { bindPlanPanelEvents, renderTodos, refreshTodos };
