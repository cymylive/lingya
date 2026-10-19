/**
 * DeepSeek 网页侧栏「对话归档」注入模块
 *
 * 目标（对齐 deepseek-pp）：
 *   1. 点击会话行的「...」按钮 → 原生下拉菜单 → 追加「归档」项
 *   2. 侧栏顶部显示「📦 已归档 (N)」分组
 *   3. 归档的会话从 DeepSeek 原生列表隐藏
 *
 * 实测 DOM 结构（2026-10-18 逆向）：
 *   会话行：a[href*="/a/chat/s/"] > [role="button"]（... 按钮）
 *   菜单容器：.ds-floating-position-wrapper > .ds-dropdown-menu[role="menu"]
 *   菜单项：.ds-dropdown-menu-option
 *     ├─ .ds-dropdown-menu-option__icon（内含 svg）
 *     └─ .ds-dropdown-menu-option__label（文本：重命名/取消置顶/分享/多选/删除）
 *
 * 关键：菜单由「点击 ... 按钮」触发，不是右键（右键事件虽触发但 React 不响应）
 */

const ROOT_ID = 'lingya-archived-section';
const STYLE_ID = 'lingya-archived-css';
const HIDDEN_ATTR = 'data-lingya-archived-hidden';
const STORAGE_KEY = 'lingya-ds-archived-sessions';

let _observer = null;
let _timer = null;
let _started = false;
let _pendingCtx = null;   // { sid, title, seq }
let _pendingSeq = 0;      // 自增序号：快速连点时，旧轮询自动失效
let _pollTimer = null;

// ---------- 存储 ----------
function readArchived() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (_) { return {}; }
}
function writeArchived(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
}

// ---------- DOM 工具 ----------
function sessionIdFromHref(href) {
  if (!href) return null;
  const m = String(href).match(/\/(?:a\/)?chat\/s\/([a-f0-9-]{8,})/i);
  return m ? m[1] : null;
}

function findConversationAnchors() {
  const list = document.querySelectorAll('a[href*="/a/chat/s/"], a[href*="/chat/s/"]');
  const out = [];
  for (const a of list) {
    if (a.closest('#' + ROOT_ID)) continue;
    const sid = sessionIdFromHref(a.getAttribute('href'));
    if (!sid) continue;
    out.push({ anchor: a, sessionId: sid, title: (a.textContent || '').trim().slice(0, 80) });
  }
  return out;
}

/**
 * 精确找到「只属于这一个 anchor」的行容器。
 * 从 anchor 往上走，遇到「包含多个会话链接的父级」就停，说明上一个就是行。
 */
function findRowElement(anchor) {
  if (!anchor) return null;
  const SEL = 'a[href*="/a/chat/s/"], a[href*="/chat/s/"]';
  let n = anchor;
  for (let i = 0; i < 6 && n && n.parentElement && n.parentElement !== document.body; i++) {
    const parent = n.parentElement;
    let links = [];
    try { links = parent.querySelectorAll(SEL); } catch (_) { links = []; }
    if (links.length > 1) return n;   // parent 含多个会话 → n 是行
    n = parent;
  }
  return anchor.parentElement || anchor;
}

function findListContainer() {
  const items = findConversationAnchors();
  if (items.length === 0) return null;
  let n = items[0].anchor.parentElement;
  for (let i = 0; i < 8 && n; i++) {
    const allIn = items.every(it => n.contains(it.anchor));
    if (allIn) return n;
    n = n.parentElement;
  }
  return null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- 样式 ----------
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      margin: 8px 4px 6px;
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
    }
    html.light #${ROOT_ID}, body.light #${ROOT_ID} {
      background: rgba(0,0,0,0.03);
      border-color: rgba(0,0,0,0.08);
    }
    #${ROOT_ID} .ly-arch-head {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; cursor: pointer; user-select: none;
      font-size: 12px; color: #6b7280; font-weight: 500;
    }
    #${ROOT_ID} .ly-arch-head:hover { background: rgba(0,0,0,0.04); border-radius: 8px; }
    #${ROOT_ID} .ly-arch-caret { font-size: 10px; width: 10px; text-align: center; }
    #${ROOT_ID} .ly-arch-count { margin-left: 2px; }
    #${ROOT_ID} .ly-arch-list { display: none; flex-direction: column; gap: 2px; padding: 4px; }
    #${ROOT_ID} .ly-arch-list.open { display: flex; }
    #${ROOT_ID} .ly-arch-item {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px; border-radius: 6px; cursor: pointer;
      font-size: 12px; color: #374151;
    }
    #${ROOT_ID} .ly-arch-item:hover { background: rgba(0,0,0,0.05); }
    #${ROOT_ID} .ly-arch-title {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${ROOT_ID} .ly-arch-act {
      font-size: 11px; color: #9ca3af; padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
    }
    #${ROOT_ID} .ly-arch-act:hover { background: rgba(45,212,191,0.15); color: #0d9488; }
    #${ROOT_ID} .ly-arch-export {
      font-size: 12px;
    }
    #${ROOT_ID} .ly-arch-export:hover {
      background: rgba(59,130,246,0.15);
      color: #3b82f6;
    }
    #${ROOT_ID} .ly-arch-delete:hover {
      background: rgba(239,68,68,0.15);
      color: #ef4444;
    }
    a[${HIDDEN_ATTR}="1"] { display: none !important; }
    [data-lingya-archived-row="1"] { display: none !important; }
  `;
  document.head.appendChild(style);
}

// ---------- 归档 / 取消 ----------
function doArchive(sessionId, title) {
  const map = readArchived();
  map[sessionId] = { title: title || sessionId.slice(0, 12), archivedAt: new Date().toISOString() };
  writeArchived(map);
  applyArchivedState();
  renderArchivedSection();
}
function doUnarchive(sessionId) {
  const map = readArchived();
  delete map[sessionId];
  writeArchived(map);
  applyArchivedState();
  renderArchivedSection();
}

// ---------- 删除对话 ----------
/**
 * 删除会话（不可恢复）。
 * 实测 API：POST /api/v0/chat_session/delete
 *   Body: { chat_session_ids: [sessionId] }
 *   成功：{ data: { biz_code: 0 } }
 */
async function doDelete(sessionId, title) {
  if (!sessionId) return;
  const name = title || sessionId.slice(0, 12);
  if (!confirm('确定删除对话「' + name + '」？\n\n此操作不可恢复，会同时从 DeepSeek 服务器删除。')) return;

  console.log('[LingYa Archive] 开始删除: ' + sessionId);
  try {
    let token = null;
    try { token = JSON.parse(localStorage.getItem('userToken') || '{}').value; } catch (_) {}
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const ac = new AbortController();
    const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 30000);
    let resp;
    try {
      resp = await fetch('/api/v0/chat_session/delete', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ chat_session_ids: [sessionId] }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const code = json && json.data && json.data.biz_code;
    if (code !== 0) throw new Error('biz_code=' + code + ' ' + (json && json.data && json.data.biz_msg || ''));

    // 从归档存储中移除
    const map = readArchived();
    delete map[sessionId];
    writeArchived(map);

    // 从 DOM 移除该会话行（如果还在）
    try {
      const anchors = findConversationAnchors();
      for (const it of anchors) {
        if (it.sessionId === sessionId) {
          const row = findRowElement(it.anchor);
          if (row && row.parentElement) row.remove();
        }
      }
    } catch (_) {}

    applyArchivedState();
    renderArchivedSection();
    console.log('[LingYa Archive] 删除成功: ' + sessionId);
    try { alert('已删除对话「' + name + '」'); } catch (_) {}
  } catch (e) {
    console.error('[LingYa Archive] 删除失败:', e && e.message);
    try { alert('删除失败：' + (e && e.message)); } catch (_) {}
  }
}

// ---------- 导出对话 ----------
/**
 * 拉取会话完整消息并导出为 Markdown。
 * 实测 API：GET /api/v0/chat/history_messages?chat_session_id=<sid>
 * 返回：{ data: { biz_data: { chat_session: {title}, chat_messages: [
 *   { role: 'USER'|'ASSISTANT', fragments: [{ type: 'REQUEST'|'THINK'|'RESPONSE', content }] }
 * ] } } }
 */
async function doExport(sessionId, titleHint) {
  if (!sessionId) return;
  console.log('[LingYa Archive] 开始导出: ' + sessionId);
  try {
    let token = null;
    try { token = JSON.parse(localStorage.getItem('userToken') || '{}').value; } catch (_) {}
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const url = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId);
    const ac = new AbortController();
    const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 60000);   // 会话可能很大，60s
    let resp;
    try {
      resp = await fetch(url, { headers, credentials: 'include', signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    const bd = json && json.data && json.data.biz_data;
    if (!bd) throw new Error('响应缺少 biz_data');
    const sess = bd.chat_session || {};
    const msgs = bd.chat_messages || [];
    const title = sess.title || titleHint || sessionId.slice(0, 12);

    // 生成 Markdown
    const lines = [];
    lines.push('# ' + title);
    lines.push('');
    lines.push('> 导出自 DeepSeek，会话 ID：`' + sessionId + '`');
    if (sess.updated_at) {
      const d = new Date(Number(sess.updated_at) * 1000);
      lines.push('> 更新时间：' + d.toISOString());
    }
    lines.push('> 消息数：' + msgs.length);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const m of msgs) {
      const role = String(m.role || '').toUpperCase();
      const frags = Array.isArray(m.fragments) ? m.fragments : [];
      if (role === 'USER') {
        const req = frags.filter(f => f && f.type === 'REQUEST').map(f => f.content || '').join('\n');
        if (!req.trim()) continue;
        lines.push('## 👤 用户');
        lines.push('');
        lines.push(req);
        lines.push('');
      } else if (role === 'ASSISTANT') {
        const thinks = frags.filter(f => f && f.type === 'THINK').map(f => f.content || '').join('\n');
        const resps = frags.filter(f => f && f.type === 'RESPONSE').map(f => f.content || '').join('\n');
        if (thinks.trim()) {
          lines.push('<details><summary>💭 思考过程</summary>');
          lines.push('');
          lines.push(thinks);
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        if (resps.trim()) {
          lines.push('## 🤖 助手');
          lines.push('');
          lines.push(resps);
          lines.push('');
        }
      }
      lines.push('---');
      lines.push('');
    }

    const md = lines.join('\n');
    // 文件名：替换非法字符
    const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const filename = safe + '.md';
    downloadMarkdown(filename, md);
    console.log('[LingYa Archive] 导出完成: ' + filename + ' (' + md.length + ' 字符)');
  } catch (e) {
    console.error('[LingYa Archive] 导出失败:', e && e.message);
    alert('导出失败：' + (e && e.message));
  }
}

/** 触发浏览器下载 */
function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) {}
    try { a.remove(); } catch (_) {}
  }, 1000);
}

// ---------- 应用隐藏状态 ----------
function applyArchivedState() {
  const archived = readArchived();
  const ROW_ATTR = 'data-lingya-archived-row';
  // 清除所有旧的隐藏标记（anchor + row）
  document.querySelectorAll('a[' + HIDDEN_ATTR + ']').forEach(a => a.removeAttribute(HIDDEN_ATTR));
  document.querySelectorAll('[' + ROW_ATTR + ']').forEach(el => el.removeAttribute(ROW_ATTR));

  // 没有任何归档 → 清理完残留标记就可以直接返回，跳过后续全量扫描
  const ids = Object.keys(archived);
  if (ids.length === 0) return;

  // 重新标记已归档的会话
  for (const it of findConversationAnchors()) {
    if (!archived[it.sessionId]) continue;
    it.anchor.setAttribute(HIDDEN_ATTR, '1');
    // 精确找行容器（只含这一个会话的祖先），避免误伤置顶组
    const row = findRowElement(it.anchor);
    if (row && row !== it.anchor && !row.closest('#' + ROOT_ID)) {
      row.setAttribute(ROW_ATTR, '1');
    }
  }
}

// ---------- 渲染归档区块 ----------
function renderArchivedSection() {
  const old = document.getElementById(ROOT_ID);
  if (old) old.remove();

  const archived = readArchived();
  const ids = Object.keys(archived);
  if (ids.length === 0) return;

  const listContainer = findListContainer();
  if (!listContainer || !listContainer.parentElement) return;

  const titleMap = {};
  for (const it of findConversationAnchors()) titleMap[it.sessionId] = it.title;

  const section = document.createElement('div');
  section.id = ROOT_ID;

  let open = false;
  try { open = localStorage.getItem('lingya-ds-archived-open') === '1'; } catch (_) {}

  // ===== 头部（可折叠）=====
  const head = document.createElement('div');
  head.className = 'ly-arch-head';
  head.innerHTML = '<span class="ly-arch-caret">' + (open ? '▾' : '▸') + '</span>'
    + '<span>📦 已归档</span><span class="ly-arch-count">(' + ids.length + ')</span>';

  // ===== 列表 =====
  const list = document.createElement('div');
  list.className = 'ly-arch-list' + (open ? ' open' : '');

  ids.sort((a, b) => String(archived[b].archivedAt || '').localeCompare(String(archived[a].archivedAt || '')));

  for (const sid of ids) {
    const rec = archived[sid];
    const title = titleMap[sid] || rec.title || sid.slice(0, 12);
    const item = document.createElement('div');
    item.className = 'ly-arch-item';
    item.title = sid;
    item.innerHTML = '<span class="ly-arch-title">' + escapeHtml(title) + '</span>'
      + '<span class="ly-arch-act ly-arch-export" title="导出对话为 Markdown">📥</span>'
      + '<span class="ly-arch-act ly-arch-delete" title="删除对话（不可恢复）">🗑</span>'
      + '<span class="ly-arch-act" title="取消归档">↩</span>';
    item.addEventListener('click', (e) => {
      const exp = e.target.closest('.ly-arch-export');
      if (exp) { e.stopPropagation(); doExport(sid, title); return; }
      const del = e.target.closest('.ly-arch-delete');
      if (del) { e.stopPropagation(); doDelete(sid, title); return; }
      if (e.target.classList.contains('ly-arch-act')) { e.stopPropagation(); doUnarchive(sid); return; }
      location.href = '/a/chat/s/' + sid;
    });
    list.appendChild(item);
  }

  // ===== 折叠交互 =====
  head.addEventListener('click', () => {
    const nowOpen = !list.classList.contains('open');
    list.classList.toggle('open', nowOpen);
    head.querySelector('.ly-arch-caret').textContent = nowOpen ? '▾' : '▸';
    try { localStorage.setItem('lingya-ds-archived-open', nowOpen ? '1' : '0'); } catch (_) {}
  });

  section.appendChild(head);
  section.appendChild(list);
  listContainer.parentElement.insertBefore(section, listContainer);
}

// ---------- 菜单注入（核心）----------
/** 找 DeepSeek 原生下拉菜单（.ds-dropdown-menu） */
function findDropdownMenu() {
  const menus = document.querySelectorAll('.ds-floating-position-wrapper .ds-dropdown-menu[role="menu"], .ds-dropdown-menu[role="menu"]');
  for (const m of menus) {
    if (m.closest('[id^="lingya-"]')) continue;
    const opts = m.querySelectorAll('.ds-dropdown-menu-option');
    if (opts.length >= 2) return m;
  }
  return null;
}

/** 往菜单插入「归档」项 */
function injectMenuItem(menu, sessionId, title) {
  if (!menu) return;
  if (menu.querySelector('[data-lingya-menu-item]')) return;   // 已插入
  const archived = readArchived();
  const isArchived = !!archived[sessionId];

  const options = Array.from(menu.querySelectorAll('.ds-dropdown-menu-option'));
  if (options.length === 0) return;

  // 找「分享」作为模板（样式最接近），找不到用第一个
  let tpl = options.find(o => {
    const lbl = o.querySelector('.ds-dropdown-menu-option__label');
    return lbl && (lbl.textContent || '').trim() === '分享';
  }) || options[0];

  const clone = tpl.cloneNode(true);
  clone.setAttribute('data-lingya-menu-item', '1');
  clone.style.cursor = 'pointer';

  // 改 label
  const label = clone.querySelector('.ds-dropdown-menu-option__label');
  if (label) label.textContent = isArchived ? '取消归档' : '归档';

  // 改 icon（把 svg 换成 emoji span）
  const iconWrap = clone.querySelector('.ds-dropdown-menu-option__icon');
  if (iconWrap) {
    iconWrap.innerHTML = '';
    const emoji = document.createElement('span');
    emoji.textContent = isArchived ? '↩' : '📦';
    emoji.style.cssText = 'font-size:15px;line-height:16px;display:inline-block;';
    iconWrap.appendChild(emoji);
  }

  // 点击
  clone.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 关闭菜单
    try { document.body.click(); } catch (_) {}
    if (isArchived) doUnarchive(sessionId);
    else doArchive(sessionId, title);
  }, true);

  // 插到「删除」之前
  const delOpt = options.find(o => {
    const lbl = o.querySelector('.ds-dropdown-menu-option__label');
    return lbl && (lbl.textContent || '').trim() === '删除';
  });
  if (delOpt && delOpt.parentElement === tpl.parentElement) {
    tpl.parentElement.insertBefore(clone, delOpt);
  } else {
    tpl.parentElement.appendChild(clone);
  }
  console.log('[LingYa Archive] 已插入「' + (isArchived ? '取消归档' : '归档') + '」到菜单');
}

/** 轮询等菜单出现后插入 */
function pollForMenu(attempt, seq) {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  if (!_pendingCtx) return;
  // 序号不匹配 → 说明已被更新的右键请求取代，放弃本次（防止插错菜单项）
  if (typeof seq === 'number' && seq !== _pendingCtx.seq) return;
  if (attempt > 25) { _pendingCtx = null; return; }
  const menu = findDropdownMenu();
  if (menu) {
    injectMenuItem(menu, _pendingCtx.sid, _pendingCtx.title);
    _pendingCtx = null;
    return;
  }
  const s = _pendingCtx.seq;
  _pollTimer = setTimeout(() => pollForMenu(attempt + 1, s), 60);
}

// ---------- 事件绑定 ----------
let _bound = false;
// 命名监听器，便于 stop() 时精确移除
function _onDocClickForMenu(e) {
  let btn = null;
  try { btn = e.target && e.target.closest ? e.target.closest('a[href*="/a/chat/s/"] [role="button"], a[href*="/chat/s/"] [role="button"]') : null; } catch (_) {}
  if (!btn) return;
  const a = btn.closest('a[href*="/a/chat/s/"], a[href*="/chat/s/"]');
  if (!a || a.closest('#' + ROOT_ID)) return;
  // 「...」按钮通常是行内最后一个 role=button
  const btns = a.querySelectorAll('[role="button"]');
  if (!btns.length || btn !== btns[btns.length - 1]) return;
  const sid = sessionIdFromHref(a.getAttribute('href'));
  if (!sid) return;
  _pendingSeq += 1;
  _pendingCtx = { sid, title: (a.textContent || '').trim().slice(0, 80), seq: _pendingSeq };
  pollForMenu(0, _pendingSeq);
}

function bindEvents() {
  if (_bound) return;
  _bound = true;
  // 点击「...」按钮 → 记录上下文 → 等菜单出现后插项
  document.addEventListener('click', _onDocClickForMenu, true);
}

// ---------- 刷新调度 ----------
// 最小刷新间隔：MutationObserver 监听整个 body，流式输出时每个 token 都会触发，
// 250ms 防抖不够，还要保证至少 2 秒才真正跑一次全量 DOM 扫描。
let _lastRefreshAt = 0;
const MIN_REFRESH_INTERVAL = 2000;

function scheduleRefresh() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    const now = Date.now();
    if (now - _lastRefreshAt < MIN_REFRESH_INTERVAL) {
      // 还没到最小间隔，重新排队等下一次
      scheduleRefresh();
      return;
    }
    _lastRefreshAt = now;
    try {
      injectStyles();
      applyArchivedState();
      renderArchivedSection();
    } catch (e) {
      console.error('[LingYa Archive] refresh 失败:', e && e.message);
    }
  }, 250);
}

// ---------- 对外 ----------
function start() {
  if (_started) return;
  // 跨模块防重复：插件 preload 可能已经启动过（同一页面共享 window）
  if (typeof window !== 'undefined' && window.__lingyaDeepseekArchiveStarted) {
    console.log('[LingYa Archive] 已由插件启动，跳过内置版本');
    return;
  }
  _started = true;
  try { window.__lingyaDeepseekArchiveStarted = true; } catch (_) {}
  console.log('[LingYa Archive] DeepSeek 侧栏归档注入已启动');
  injectStyles();
  bindEvents();
  _observer = new MutationObserver(() => scheduleRefresh());
  _observer.observe(document.body, { childList: true, subtree: true });
  scheduleRefresh();
}

function stop() {
  _started = false;
  // 清理刷新防抖定时器（否则 stop 后 250ms 内还会执行一次 refresh）
  if (_timer) { try { clearTimeout(_timer); } catch (_) {} _timer = null; }
  // 移除 document click 监听器
  try { document.removeEventListener('click', _onDocClickForMenu, true); } catch (_) {}
  _bound = false;
  if (_observer) { try { _observer.disconnect(); } catch (_) {} _observer = null; }
  if (_pollTimer) { try { clearTimeout(_pollTimer); } catch (_) {} _pollTimer = null; }
  const old = document.getElementById(ROOT_ID);
  if (old) old.remove();
  document.querySelectorAll('a[' + HIDDEN_ATTR + ']').forEach(a => a.removeAttribute(HIDDEN_ATTR));
  document.querySelectorAll('[data-lingya-archived-row]').forEach(el => el.removeAttribute('data-lingya-archived-row'));
  // 复位跨模块标志，允许将来重新 start()
  try { if (window) window.__lingyaDeepseekArchiveStarted = false; } catch (_) {}
}

module.exports = { start, stop };
