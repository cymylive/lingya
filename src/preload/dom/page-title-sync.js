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

  // 缓存命中：元素还在 DOM 里且 href 仍匹配该 sessionId → 直接用
  const cached = state.cachedSidebarEls[sessionId];
  if (cached && document.body &&
      typeof document.body.contains === 'function' &&
      document.body.contains(cached)) {
    return cached;
  }
  if (cached) delete state.cachedSidebarEls[sessionId];

  const a = document.querySelector('a[href*="/a/chat/s/' + sessionId + '"]')
    || document.querySelector('a[href*="/s/' + sessionId + '"]');
  if (!a) return null;
  const divs = a.querySelectorAll('div');
  for (const d of divs) {
    if (d.children.length === 0 && (d.textContent || '').trim()) {
      state.cachedSidebarEls[sessionId] = d;   // 缓存
      return d;
    }
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
  // 缓存优先：标题元素在会话生命周期内位置稳定，只在 React 重渲染时被替换
  if (state.cachedPageTitleEl &&
      document.body && typeof document.body.contains === 'function' &&
      document.body.contains(state.cachedPageTitleEl)) {
    try {
      const r = state.cachedPageTitleEl.getBoundingClientRect();
      // 仍在顶部区域（top 0-60，left >= 150）→ 认为有效
      if (r.top >= 0 && r.top <= 60 && r.left >= 150) {
        return state.cachedPageTitleEl;
      }
    } catch (_) {}
    state.cachedPageTitleEl = null;
  }

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
  const found = cands[0].el;
  state.cachedPageTitleEl = found;   // 缓存，下次直接返回
  return found;
}

// ---------- 期望状态 & 守护 ----------
const state = {
  sessionId: null,
  title: null,
  observer: null,
  timer: null,
  // 标题元素缓存：会话生命周期内位置稳定，避免每次 guardTick 全页面扫描
  cachedPageTitleEl: null,
  // 上次 guardTick 执行时刻：流式输出时 DOM 变动极频繁，需要节流
  lastGuardAt: 0,
  // 侧栏标题元素缓存：sessionId → 元素。querySelector 属性匹配在会话多时较慢
  cachedSidebarEls: Object.create(null),
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
        // 节流：流式输出时 DOM 变动极频繁，120ms 防抖后还要保证最少 500ms 间隔，
        // 否则长对话每次 token 都触发全量 DOM 扫描 → 严重卡顿。
        const now = Date.now();
        if (now - state.lastGuardAt < 500) return;
        state.lastGuardAt = now;
        try { guardTick(); } catch (_) {}
      }, 120);
    });
    // 只监听 childList：标题变化时 React 是替换文本节点，不会原地改字符。
    // 之前开了 characterData，流式输出时每个 token 都触发回调 → 长对话严重卡顿。
    state.observer.observe(document.body, { childList: true, subtree: true });
  } catch (_) { /* ignore */ }
}

function stopGuard() {
  if (state.observer) {
    try { state.observer.disconnect(); } catch (_) {}
    state.observer = null;
  }
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

// ---------- 自动回填：网页标题稳定后写入本地 store（2026-11-06）----------
// 背景：工作区会话名显示 ID，根因是本地 session-store 的 title 为 null。
// 网页上其实有真实标题，只是没有回写通道。本模块补上这条通道。
//
// 设计要点：
//   - debounce 3s：流式输出时 DOM 变化频繁，必须等标题稳定后才读，避免存入「正在生成…」这类临时文案
//   - 只在当前会话上生效：非当前会话读不到 DOM
//   - 用 lastSynced 去重：已同步过的标题不重复写盘
//   - syncSessionTitle 被调用时同步更新 lastSynced，避免自写自读形成循环
const autoSyncState = {
  sessionId: null,
  lastSynced: null,
  timer: null,
  observer: null,
};

/** 判断一个文本是否像有效会话标题（过滤按钮词、过短/过长） */
function looksLikeTitle(t) {
  const s = String(t || '').trim();
  if (!s || s.length < 2 || s.length > 80) return false;
  if (NOT_TITLE.has(s)) return false;
  return true;
}

/** 从当前网页顶部读取会话标题（复用 findPageTitleEl） */
function readCurrentTitleFromDom() {
  try {
    const el = findPageTitleEl(null);
    if (!el) return null;
    const t = (el.textContent || '').trim();
    return looksLikeTitle(t) ? t : null;
  } catch (_) { return null; }
}

/** debounce 调度：DOM 变化后等 3s 稳定再检查 */
function scheduleAutoSync() {
  if (autoSyncState.timer) clearTimeout(autoSyncState.timer);
  autoSyncState.timer = setTimeout(() => {
    autoSyncState.timer = null;
    try { doAutoSync(); } catch (_) {}
  }, 3000);
}

/** 执行自动回填 */
function doAutoSync() {
  const sid = sessionIdFromUrl(location.href);
  if (!sid) return;
  // 会话切换：重置状态
  if (sid !== autoSyncState.sessionId) {
    autoSyncState.sessionId = sid;
    autoSyncState.lastSynced = null;
  }
  const t = readCurrentTitleFromDom();
  if (!t) return;
  if (t === autoSyncState.lastSynced) return;   // 已同步过，跳过
  // 回写本地 store（幂等：写相同值无害）
  try {
    if (window.electronAPI && typeof window.electronAPI.setSessionTitle === 'function') {
      window.electronAPI.setSessionTitle(t, sid).then((r) => {
        if (r && r.success) {
          console.log('[灵鸦][标题自动回填] 已同步标题到本地: ' + t);
          autoSyncState.lastSynced = t;
        }
      }).catch(() => { /* 静默失败，不影响主流程 */ });
    }
  } catch (_) {}
}

/** 启动自动回填（幂等） */
function startAutoSync() {
  if (autoSyncState.observer) return;
  try {
    autoSyncState.observer = new MutationObserver(() => {
      scheduleAutoSync();
    });
    // 只监听 childList：标题变化时 React 替换文本节点
    autoSyncState.observer.observe(document.body, { childList: true, subtree: true });
    // 初始触发一次（页面可能已加载完）
    scheduleAutoSync();
    console.log('[灵鸦][标题自动回填] 已启动');
  } catch (_) { /* ignore */ }
}

/** 停止自动回填（测试/清理用） */
function stopAutoSync() {
  if (autoSyncState.observer) {
    try { autoSyncState.observer.disconnect(); } catch (_) {}
    autoSyncState.observer = null;
  }
  if (autoSyncState.timer) { clearTimeout(autoSyncState.timer); autoSyncState.timer = null; }
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

  // 记录已同步状态，避免自动回填对刚手动同步的标题重复回写
  autoSyncState.sessionId = sessionId;
  autoSyncState.lastSynced = t;

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
  // 2026-11-06 新增：自动回填 + 手动读取当前标题
  startAutoSync,
  stopAutoSync,
  readCurrentTitleFromDom,
  // 导出供测试
  _internal: { findSidebarTitleEl, findPageTitleEl, sessionIdFromUrl, pickApi, looksLikeTitle },
};
