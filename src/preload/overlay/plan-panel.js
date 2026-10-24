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

/** 进度条 HTML（dsh 式：完成比例可视化） */
function progressHtml(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const done = items.filter((t) => t.status === 'completed').length;
  const pct = Math.round((done / items.length) * 100);
  return '<div class="lingya-plan-progress">' +
    '<div class="lingya-plan-progress-bar" style="width:' + pct + '%"></div>' +
  '</div>';
}

// 当前会话 ID（用于按会话过滤广播，避免跨会话串扰）
// 【审查修复】拆成两个独立变量。
// 原实现 AI 计划与用户待办共用一个 currentSessionId，两个 refresh 都是 async，
// 并发时后返回的会覆盖前者 → 会话切换瞬间可能把待办渲染到错误会话。
let planSessionId = null;
let userTodoSessionId = null;

/** 渲染待办列表（同时刷新页签面板 + 悬浮卡） */
function renderTodos(todos, archived) {
  const items = Array.isArray(todos) ? todos : [];
  const done = items.filter((t) => t.status === 'completed').length;
  const allDone = items.length > 0 && done === items.length;
  const progress = (archived || allDone) ? ('✓ ' + items.length + '/' + items.length) : (done + '/' + items.length);
  const hasItems = items.length > 0;

  // 页签面板
  const list = document.getElementById('lingya-plan-list');
  const count = document.getElementById('lingya-plan-count');
  if (count) count.textContent = progress;
  if (list) {
    list.innerHTML = hasItems
      ? progressHtml(items) + itemsHtml(items)
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
      ? progressHtml(items) + itemsHtml(items)
      : '<div class="lingya-plan-empty">暂无计划</div>';
  }
  if (float) float.classList.remove('lingya-hidden');
}

/** 拉取一次当前计划 */
async function refreshTodos() {
  try {
    const r = await window.electronAPI.getTodos();
    if (r && r.success) {
      planSessionId = r.sessionId || null;
      renderTodos(r.todos, r.archived);
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
      refreshUserTodos();   // 会话切换时同步刷新用户待办
    }
  };
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  setInterval(check, 800);
}

// ===================== 我的待办（用户手动）=====================
// 与 AI 的 todoWrite 完全独立：独立存储、独立 IPC、独立渲染。
// 详见 tools/UserTodoStore.js 与 src/main/ipc.js 的 user-todos-* 通道。

/** 正在行内编辑的待办 id；非 null 时暂停重渲染（防焦点丢失） */
let editingUserId = null;
/** 编辑开始时所属的会话 id；用于判断「会话已切换」时强制退出编辑态 */
let editingSessionId = null;
/** 当前用户待办列表缓存（渲染用） */
let userTodoCache = [];

/** 渲染用户待办列表 */
function renderUserTodos(todos) {
  // 编辑期间不重渲染：否则广播到达会把正在编辑的输入框冲掉，用户输入全丢。
  // 但会话切换必须强制退出编辑态 —— 否则切到别的会话后，新会话的待办永远渲染不出来
  // （editingUserId 非空 → 每次 render 都早退），用户看到的是上一个会话的残留内容。
  if (editingUserId) {
    if (userTodoSessionId && userTodoSessionId !== editingSessionId) {
      console.log('[LingYa] 会话已切换，强制退出待办编辑态');
      editingUserId = null;
      editingSessionId = null;
    } else {
      return;
    }
  }

  const items = Array.isArray(todos) ? todos : [];
  userTodoCache = items;

  const list = document.getElementById('lingya-utodo-list');
  const count = document.getElementById('lingya-utodo-count');
  const done = items.filter((t) => t.done).length;
  if (count) count.textContent = done + '/' + items.length;

  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '<div class="lingya-plan-empty">暂无待办。在下方输入框添加，或点「+」。</div>';
    return;
  }

  list.innerHTML = items.map((t) => {
    const cls = t.done ? 'lingya-utodo-item done' : 'lingya-utodo-item';
    return '<div class="' + cls + '" data-id="' + escapeHtml(t.id) + '">' +
      '<span class="lingya-utodo-check" data-act="toggle" title="' + (t.done ? '标记未完成' : '标记完成') + '">✓</span>' +
      '<span class="lingya-utodo-text" data-act="edit" title="双击编辑">' + escapeHtml(t.text) + '</span>' +
      '<span class="lingya-utodo-start" data-act="start" title="发送给 AI 开始处理">▶</span>' +
      '<span class="lingya-utodo-del" data-act="del" title="删除">×</span>' +
    '</div>';
  }).join('');

  // 事件委托：勾选 / 双击编辑 / 删除
  list.querySelectorAll('.lingya-utodo-item').forEach((el) => {
    const id = el.dataset.id;
    const item = userTodoCache.find((t) => t.id === id);
    if (!item) return;

    const check = el.querySelector('[data-act="toggle"]');
    if (check) {
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        window.electronAPI.userTodosUpdate(id, { done: !item.done }).catch((err) => {
          console.warn('[LingYa] 切换待办状态失败:', err && err.message);
          refreshUserTodos(); // 回滚 UI 到服务端真实状态
        });
      });
    }

    const text = el.querySelector('[data-act="edit"]');
    if (text) {
      text.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEditUserTodo(el, item);
      });
    }

    const start = el.querySelector('[data-act="start"]');
    if (start) {
      start.addEventListener('click', (e) => {
        e.stopPropagation();
        if (start.dataset.busy === '1') return;  // 防重复点击
        start.dataset.busy = '1';
        start.style.opacity = '0.4';
        try {
          const { sendMessageToChat } = require('../dom/chat-input');
          sendMessageToChat(
            '【待办任务】' + item.text + String.fromCharCode(10) + String.fromCharCode(10) +
            '请开始处理这个任务。',
            '待办任务',
            { auto: true }
          );
          console.log('[LingYa] 待办已发送给 AI: ' + item.text.slice(0, 40));
        } catch (err) {
          console.warn('[LingYa] 发送待办失败:', err && err.message);
        } finally {
          setTimeout(() => {
            start.dataset.busy = '';
            start.style.opacity = '';
          }, 3000);
        }
      });
    }

    const del = el.querySelector('[data-act="del"]');
    if (del) {
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        window.electronAPI.userTodosDelete(id).catch((err) => {
          console.warn('[LingYa] 删除待办失败:', err && err.message);
          refreshUserTodos();
        });
      });
    }
  });
}

/** 进入行内编辑：把文字替换成 input，回车保存 / Esc 取消 / 失焦保存 */
function startEditUserTodo(rowEl, item) {
  if (editingUserId) return; // 同时只允许编辑一条
  editingUserId = item.id;
  editingSessionId = userTodoSessionId;

  const textEl = rowEl.querySelector('[data-act="edit"]');
  if (!textEl) { editingUserId = null; return; }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lingya-utodo-edit-input';
  input.value = item.text;
  input.maxLength = 500;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    editingUserId = null;
    editingSessionId = null;
    const v = input.value.trim();
    if (save && v && v !== item.text) {
      window.electronAPI.userTodosUpdate(item.id, { text: v }).catch((err) => {
        console.warn('[LingYa] 保存待办文本失败:', err && err.message);
        refreshUserTodos();
      });
    }
    // 无论保存与否都重渲染回只读态（update 成功会触发广播重渲染；
    // 失败或内容未变时这里兜底恢复）
    renderUserTodos(userTodoCache);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** 拉取一次用户待办 */
async function refreshUserTodos() {
  try {
    const r = await window.electronAPI.userTodosList();
    if (r && r.success) {
      if (r.sessionId) userTodoSessionId = r.sessionId;
      renderUserTodos(r.todos);
    }
  } catch (e) {
    console.error('[LingYa] 读取用户待办失败:', e && e.message);
  }
}

/** 提交输入框内容（支持多行粘贴，拆条在主进程做） */
// 系统消息前缀（与 tools/UserTodoStore.js 的 SYSTEM_PREFIXES 保持一致）
// 前端预检只为给出友好提示，真正的硬防线在存储层。
const SYSTEM_PREFIXES_UI = [
  '【监督续跑】', '【自动续跑】', '【系统提示】', '【工具执行结果】',
  '【JS 执行结果', '【计划续跑】', '【兜底续跑】', '【中断续跑】',
];

async function submitUserTodo() {
  const input = document.getElementById('lingya-utodo-input');
  const btn = document.getElementById('lingya-utodo-add-btn');
  if (!input) return;
  const text = String(input.value || '').trim();
  if (!text) return;

  // 预检：避免把系统消息当待办（存储层也会拒，这里只是给更友好的提示）
  const hit = SYSTEM_PREFIXES_UI.find((p) => text.startsWith(p));
  if (hit) {
    console.warn('[LingYa] 拒绝添加系统消息作为待办: ' + hit);
    try {
      const { showToast } = require('./ui');
      if (showToast) showToast('这看起来是系统消息，不能作为待办', 3000);
    } catch (_) {}
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const r = await window.electronAPI.userTodosAdd(text);
    if (r && r.success) {
      input.value = '';
      input.rows = 1;
      if (Array.isArray(r.todos)) renderUserTodos(r.todos);
    } else if (r && r.error) {
      console.warn('[LingYa] 添加待办失败:', r.error);
    }
  } catch (e) {
    console.error('[LingYa] 添加待办异常:', e && e.message);
  } finally {
    if (btn) btn.disabled = false;
    input.focus();
  }
}

/** 绑定用户待办面板 */
function bindUserTodoPanel() {
  refreshUserTodos();

  // 订阅变更：**只注册一次**（bindUserTodoPanel 若被重复调用不会累积监听器）
  try {
    if (!window.__lingyaUserTodoSubscribed && window.electronAPI.onUserTodosUpdated) {
      window.__lingyaUserTodoSubscribed = true;
      window.electronAPI.onUserTodosUpdated((payload) => {
        const sid = payload && payload.sessionId;
        if (sid && userTodoSessionId && sid !== userTodoSessionId) return;
        if (sid) userTodoSessionId = sid;
        if (Array.isArray(payload && payload.todos)) {
          renderUserTodos(payload.todos);
        } else {
          refreshUserTodos();
        }
      });
    }
  } catch (_) {}

  // 输入框：Enter 提交（Shift+Enter 换行）；自动增高
  const input = document.getElementById('lingya-utodo-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // 【最后一道防线】只接受真实用户触发的 Enter。
        // chat-input 的 triggerSend 会合成 KeyboardEvent；若 findInputArea 误把
        // 本框当成聊天输入框，这里会凭空创建待办。isTrusted=false 即可拦下。
        if (!e.isTrusted) {
          console.warn('[LingYa] 忽略合成的 Enter（非用户输入），避免误提交待办');
          return;
        }
        e.preventDefault();
        submitUserTodo();
      }
    });
    input.addEventListener('input', () => {
      const lines = String(input.value || '').split('\n').length;
      input.rows = Math.max(1, Math.min(4, lines));
    });
  }

  const btn = document.getElementById('lingya-utodo-add-btn');
  if (btn) btn.addEventListener('click', submitUserTodo);
}

/** 绑定计划面板：首次拉取 + 订阅变更 + 会话切换时重拉 + 悬浮卡拖拽 */
function bindPlanPanelEvents() {
  refreshTodos();
  bindUserTodoPanel();
  if (!unsubscribe) {
    // 收到变更通知：若带 sessionId 且与当前会话不符 → 忽略（防跨会话串扰）。
    // payload 里已带 todos/archived，直接渲染，不再多发一次 get-todos IPC。
    unsubscribe = window.electronAPI.onTodosUpdated((payload) => {
      try {
        const sid = payload && payload.sessionId;
        if (sid && planSessionId && sid !== planSessionId) return;
        if (sid) planSessionId = sid;
        if (Array.isArray(payload.todos)) {
          renderTodos(payload.todos, !!payload.archived);
          const el = document.getElementById('lingya-plan-session');
          if (el) el.textContent = sid ? String(sid).slice(0, 10) : '(新会话)';
          return;
        }
      } catch (_) { /* 回落 */ }
      // payload 缺 todos 时才走 IPC
      refreshTodos();
    });
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

module.exports = {
  bindPlanPanelEvents,
  renderTodos,
  refreshTodos,
  renderUserTodos,
  refreshUserTodos,
};
