/**
 * 会话标题同步（DeepSeek 等平台）
 *
 * 背景：nameConversation / 手动改名原本只写 LingYa 本地 session-store，
 * 完全不碰 AI 网页自己的 UI，所以用户看到「已重命名」但页面顶部和历史列表纹丝不动。
 *
 * 本模块做三件事：
 *   1. 调平台 API 改名（持久化到服务端，刷新后仍生效）
 *   2. 直接改 DOM（侧边栏会话项 + 页面顶部标题），立即见效
 *   3. MutationObserver 守护 —— React 重渲染会把标题改回去，需持续覆盖
 *
 * 平台差异：目前只实现 DeepSeek。其他平台走 DOM 兜底（无 API）。
 */

// ---------- 平台 API 定义 ----------
const PLATFORM_APIS = {
  deepseek: {
    matches: (url) => /chat\.deepseek\.com/.test(url),
    getToken: () => {
      try {
        const raw = localStorage.getItem('userToken');
        if (!raw) return null;
        const o = JSON.parse(raw);
        return (o && o.value) || null;
      } catch (_) { return null; }
    },
    rename: async (sessionId, title) => {
      const token = PLATFORM_APIS.deepseek.getToken();
      if (!token) return { ok: false, error: '未登录（无 userToken）' };
      const r = await fetch('/api/v0/chat_session/update_title', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_session_id: sessionId, title }),
        credentials: 'include',
      });
      let j = null;
      try { j = await r.json(); } catch (_) {}
      return { ok: r.ok && j && j.code === 0, code: j && j.code, status: r.status };
    },
  },
};

function pickApi(url) {
  const u = url || (typeof location !== 'undefined' ? location.href : '');
  for (const k of Object.keys(PLATFORM_APIS)) {
    if (PLATFORM_APIS[k].matches(u)) return PLATFORM_APIS[k];
  }
  return null;
}

// ---------- 从 URL 提取 sessionId ----------
function sessionIdFromUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/a\/chat\/s\/([a-f0-9-]{8,})/i);
  if (m) return m[1];
  m = s.match(/\/chat\/s\/([a-f0-9-]{8,})/i);
  if (m) return m[1];
  m = s.match(/\/s\/([a-f0-9-]{8,})/i);
  if (m) return m[1];
  return null;
}

// ---------- DOM 定位 ----------

/** 侧边栏里该会话的标题节点（a[href] 内的叶子 div） */
function findSidebarTitleEl(sessionId) {
  if (!sessionId) return null;
  const a = document.querySelector('a[href*="/a/chat/s/' + sessionId + '"]')
    || document.querySelector('a[href*="/s/' + sessionId + '"]');
  if (!a) return null;
  const divs = a.querySelectorAll('div');
  for (const d of divs) {
    if (d.children.length === 0 && (d.textContent || '').trim()) return d;
  }
  return null;
}

/** 明显不是标题的文字（按钮/标签） */
const NOT_TITLE = new Set([
  '开启新对话', '新对话', '复制', '下载', '分享', '返回', '更多', '编辑',
  '已思考', '思考中', '深度思考', '智能搜索', '联网搜索', '发送', '停止',
  '置顶', '今天', '昨天', '7 天内', '30 天内',
]);

/**
 * 页面顶部会话标题节点。
 * 策略：顶部 0~60px，横向 left>150（跳过侧边栏），字号 ≥13，排除按钮词。
 * preferText 传入时优先精确匹配（第一次同步用旧标题）。
 */
function findPageTitleEl(preferText) {
  const all = document.querySelectorAll('*');
  const cands = [];
  for (const el of all) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length < 2 || t.length > 80) continue;
    if (NOT_TITLE.has(t)) continue;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea') continue;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { continue; }
    if (r.top < 0 || r.top > 60 || r.left < 150 || r.width < 20) continue;
    let fs = 0;
    try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch (_) {}
    if (fs < 13) continue;
    cands.push({ el, t, top: r.top, fs });
  }
  if (cands.length === 0) return null;
  // 优先精确匹配旧标题
  if (preferText) {
    const hit = cands.find(c => c.t === preferText);
    if (hit) return hit.el;
  }
  // 否则按「越靠上、字号越大」排序取第一
  cands.sort((a, b) => (a.top - b.top) || (b.fs - a.fs));
  return cands[0].el;
}

// ---------- 期望状态 & 守护 ----------
const state = {
  sessionId: null,
  title: null,
  observer: null,
  timer: null,
};

function applyDom(sessionId, title, preferOldTitle) {
  const out = { sidebar: false, page: false };
  const sb = findSidebarTitleEl(sessionId);
  if (sb) { sb.textContent = title; out.sidebar = true; }
  // preferOldTitle：首次同步时页面还显示旧标题，精确匹配它更可靠
  const pt = findPageTitleEl(preferOldTitle || null);
  if (pt) { pt.textContent = title; out.page = true; }
  return out;
}

function guardTick() {
  if (!state.sessionId || !state.title) return;
  // 只守护当前会话
  const curSid = sessionIdFromUrl(location.href);
  if (curSid && curSid !== state.sessionId) {
    // 已切到别的会话：只守护侧边栏，不动页面标题
    const sb = findSidebarTitleEl(state.sessionId);
    if (sb && (sb.textContent || '').trim() !== state.title) sb.textContent = state.title;
    return;
  }
  const sb = findSidebarTitleEl(state.sessionId);
  if (sb && (sb.textContent || '').trim() !== state.title) sb.textContent = state.title;
  const pt = findPageTitleEl(null);
  if (pt && (pt.textContent || '').trim() !== state.title) pt.textContent = state.title;
}

function startGuard() {
  if (state.observer) return;
  try {
    state.observer = new MutationObserver(() => {
      if (state.timer) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        try { guardTick(); } catch (_) {}
      }, 120);
    });
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (_) { /* ignore */ }
}

function stopGuard() {
  if (state.observer) {
    try { state.observer.disconnect(); } catch (_) {}
    state.observer = null;
  }
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

// ---------- 对外主入口 ----------
/**
 * 同步会话标题。
 * @param {string} sessionId 会话 ID
 * @param {string} title 新标题
 * @returns {Promise<{api: object, dom: object, current: boolean}>}
 */
async function syncSessionTitle(sessionId, title) {
  const t = String(title || '').trim();
  if (!sessionId || !t) return { api: { ok: false, error: '参数为空' }, dom: {}, current: false };

  // 1) 调平台 API 改名（不管是不是当前会话，都要持久化）
  let api = { ok: false, error: '平台不支持 API 改名' };
  const platform = pickApi();
  if (platform && typeof platform.rename === 'function') {
    try { api = await platform.rename(sessionId, t); }
    catch (e) { api = { ok: false, error: e.message }; }
  }

  // 2) DOM 双写（只在 sessionId 是当前会话时才有意义）
  const curSid = sessionIdFromUrl(location.href);
  const isCurrent = !curSid || curSid === sessionId;
  let dom = {};
  if (isCurrent) {
    // 首次同步：把页面当前显示的旧标题作为精确定位线索
    const oldPageText = state.title ? null : (findPageTitleEl() ? findPageTitleEl().textContent : null);
    state.sessionId = sessionId;
    state.title = t;
    dom = applyDom(sessionId, t, oldPageText);
    startGuard();
  } else {
    // 非当前会话：仅守护侧边栏那一项
    const sb = findSidebarTitleEl(sessionId);
    if (sb) { sb.textContent = t; dom = { sidebar: true, page: false }; }
  }

  return { api, dom, current: isCurrent };
}

/** 页面导航后重新应用守护（SPA 路由切换） */
function onUrlChanged() {
  if (!state.sessionId || !state.title) return;
  try { applyDom(state.sessionId, state.title); } catch (_) {}
}

module.exports = {
  syncSessionTitle,
  onUrlChanged,
  stopGuard,
  // 导出供测试
  _internal: { findSidebarTitleEl, findPageTitleEl, sessionIdFromUrl, pickApi },
};
