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

/** 渲染待办列表 */
function renderTodos(todos) {
  const list = document.getElementById('lingya-plan-list');
  const count = document.getElementById('lingya-plan-count');
  if (!list) return;
  const items = Array.isArray(todos) ? todos : [];
  const done = items.filter((t) => t.status === 'completed').length;
  if (count) count.textContent = done + '/' + items.length;
  // 页签上的进度角标（跟随标题，不展开也能看到）
  const tabCount = document.getElementById('lingya-plan-tab-count');
  if (tabCount) tabCount.textContent = items.length > 0 ? ' ' + done + '/' + items.length : '';

  if (items.length === 0) {
    list.innerHTML = '<div class="lingya-plan-empty">暂无计划。AI 使用 todoWrite 时会显示在这里。</div>';
    return;
  }

  list.innerHTML = items.map((t, i) => {
    const st = STATUS_ICON[t.status] ? t.status : 'pending';
    return '<div class="lingya-plan-item ' + st + '">' +
      '<span class="lingya-plan-num">' + (i + 1) + '.</span>' +
      '<span class="lingya-plan-ico ' + st + '">' + STATUS_ICON[st] + '</span>' +
      '<span class="lingya-plan-text">' + escapeHtml(t.content) + '</span>' +
    '</div>';
  }).join('');
}

/** 拉取一次当前计划 */
async function refreshTodos() {
  try {
    const r = await window.electronAPI.getTodos();
    if (r && r.success) renderTodos(r.todos);
  } catch (e) {
    console.error('[LingYa] 读取计划失败:', e && e.message);
  }
}

/** 绑定计划面板：首次拉取 + 订阅变更 */
function bindPlanPanelEvents() {
  refreshTodos();
  if (!unsubscribe) {
    unsubscribe = window.electronAPI.onTodosUpdated(renderTodos);
  }
}

module.exports = { bindPlanPanelEvents, renderTodos, refreshTodos };
