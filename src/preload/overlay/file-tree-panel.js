/**
 * 项目文件树 UI：渲染 + 搜索 + 折叠 + 预览
 *
 * 数据来自主进程 get-file-tree（整树一次返回），前端做搜索过滤。
 * 只读：点文件显示内容预览（≤512KB）。
 */
// ========== 扩展名 → 颜色类（VSCode 风格）==========
const EXT_CLASS = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', json5: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', vue: 'html',
  py: 'py', java: 'java', go: 'go', rs: 'rs', rb: 'rb', php: 'php',
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cs: 'cs',
  sh: 'sh', bash: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh',
  yml: 'yml', yaml: 'yml', toml: 'yml', ini: 'yml',
  xml: 'xml', svg: 'xml',
  sql: 'sql',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', ico: 'img', svg2: 'img',
  mp4: 'img', mp3: 'img', wav: 'img',
  txt: 'txt', log: 'txt',
};

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function fileClass(name) {
  return 'lingya-ft-' + (EXT_CLASS[extOf(name)] || 'default');
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

// ========== 状态 ==========
let fullTree = [];              // 完整树
let rootPath = '';              // 项目根
let truncated = false;
let filter = '';                // 搜索关键词
const collapsed = new Set();    // 折叠的目录路径
let treeLoaded = false;

// ========== 渲染 ==========

/** 递归渲染节点 */
function renderNodes(nodes, depth) {
  const html = [];
  for (const n of nodes) {
    const indent = 'padding-left:' + (6 + depth * 12) + 'px';
    if (n.type === 'dir') {
      const isCollapsed = collapsed.has(n.path);
      html.push(
        '<div class="lingya-ft-row lingya-ft-dir" data-path="' + escapeHtml(n.path) + '" data-type="dir" style="' + indent + '">' +
          '<span class="lingya-ft-caret' + (isCollapsed ? ' lingya-ft-collapsed' : '') + '">▸</span>' +
          '<span class="lingya-ft-icon">📁</span>' +
          '<span class="lingya-ft-name">' + escapeHtml(n.name) + '</span>' +
        '</div>'
      );
      if (!isCollapsed && n.children && n.children.length) {
        html.push(renderNodes(n.children, depth + 1));
      }
    } else {
      html.push(
        '<div class="lingya-ft-row lingya-ft-file" data-path="' + escapeHtml(n.path) + '" data-type="file" style="' + indent + '" title="' + escapeHtml(n.path) + '">' +
          '<span class="lingya-ft-caret lingya-ft-caret-empty"></span>' +
          '<span class="lingya-ft-icon ' + fileClass(n.name) + '">📄</span>' +
          '<span class="lingya-ft-name">' + escapeHtml(n.name) + '</span>' +
        '</div>'
      );
    }
  }
  return html.join('');
}

/** 搜索过滤：保留匹配节点及其祖先 */
function filterTree(nodes, kw) {
  const low = kw.toLowerCase();
  const out = [];
  for (const n of nodes) {
    if (n.type === 'dir') {
      const kids = filterTree(n.children || [], kw);
      if (kids.length || n.name.toLowerCase().indexOf(low) !== -1) {
        out.push({ name: n.name, path: n.path, type: 'dir', children: kids });
      }
    } else if (n.name.toLowerCase().indexOf(low) !== -1 || n.path.toLowerCase().indexOf(low) !== -1) {
      out.push(n);
    }
  }
  return out;
}

/** 渲染整棵树 */
function renderTree() {
  const list = document.getElementById('lingya-ft-list');
  const stat = document.getElementById('lingya-ft-stat');
  if (!list) return;

  if (!rootPath) {
    list.innerHTML = '<div class="lingya-session-empty">未选择项目目录<br><span style="font-size:11px;">先在「主页」点「初始化项目」</span></div>';
    if (stat) stat.textContent = '';
    return;
  }

  const nodes = filter ? filterTree(fullTree, filter) : fullTree;

  if (!nodes.length) {
    list.innerHTML = '<div class="lingya-session-empty">' + (filter ? '无匹配项' : '空目录') + '</div>';
    if (stat) stat.textContent = filter ? '无匹配' : '';
    return;
  }

  // 搜索时全部展开（便于看结果）
  const savedCollapsed = filter ? new Set(collapsed) : null;
  if (filter) collapsed.clear();
  list.innerHTML = renderNodes(nodes, 0);
  if (savedCollapsed) { collapsed.clear(); savedCollapsed.forEach(p => collapsed.add(p)); }

  if (stat) {
    stat.textContent = filter ? ('匹配中 · ' + (truncated ? '已截断' : '')) : ('共 ' + countNodes(fullTree) + ' 项' + (truncated ? '（已截断）' : ''));
  }
  bindRowEvents();
}

function countNodes(nodes) {
  let n = 0;
  for (const x of nodes) { n++; if (x.children) n += countNodes(x.children); }
  return n;
}

/** 绑定行点击：目录折叠 / 文件预览 */
function bindRowEvents() {
  const list = document.getElementById('lingya-ft-list');
  if (!list) return;
  list.querySelectorAll('.lingya-ft-row').forEach((row) => {
    row.addEventListener('click', () => {
      const p = row.dataset.path;
      const t = row.dataset.type;
      if (t === 'dir') {
        if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p);
        renderTree();
      } else {
        previewFile(p);
      }
    });
  });
}

/** 预览文件 */
async function previewFile(filePath) {
  const box = document.getElementById('lingya-ft-preview');
  const title = document.getElementById('lingya-ft-preview-title');
  const body = document.getElementById('lingya-ft-preview-body');
  if (!box || !body) return;
  if (title) title.textContent = filePath.split(/[\\/]/).pop() || filePath;
  body.textContent = '读取中...';
  box.classList.remove('lingya-hidden');
  try {
    const r = await window.electronAPI.readFilePreview(filePath);
    if (r && r.success) {
      body.textContent = r.content || '(空文件)';
    } else {
      body.textContent = '读取失败: ' + ((r && r.error) || '未知错误');
    }
  } catch (err) {
    body.textContent = '读取失败: ' + err.message;
  }
}

// ========== 加载 ==========

async function refreshFileTree() {
  const list = document.getElementById('lingya-ft-list');
  if (list) list.innerHTML = '<div class="lingya-session-empty">加载中...</div>';
  try {
    if (!window.electronAPI || typeof window.electronAPI.getFileTree !== 'function') {
      if (list) list.innerHTML = '<div class="lingya-session-empty">API 不可用，请重启应用</div>';
      return;
    }
    const r = await window.electronAPI.getFileTree({});
    if (!r || !r.success) {
      rootPath = '';
      fullTree = [];
      if (list) list.innerHTML = '<div class="lingya-session-empty">' + escapeHtml((r && r.error) || '加载失败') + '</div>';
      const stat = document.getElementById('lingya-ft-stat');
      if (stat) stat.textContent = '';
      return;
    }
    rootPath = r.root || '';
    fullTree = r.tree || [];
    truncated = !!r.truncated;
    treeLoaded = true;
    const rootEl = document.getElementById('lingya-ft-root');
    if (rootEl) rootEl.textContent = rootPath || '未选择';
    renderTree();
  } catch (err) {
    if (list) list.innerHTML = '<div class="lingya-session-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
  }
}

// ========== 侧栏收展 ==========
const SIDEBAR_KEY = 'lingya-sidebar-open';

function isSidebarOpen() {
  const sb = document.getElementById('lingya-sidebar');
  return !!sb && !sb.classList.contains('lingya-sidebar-hidden');
}

/** 展开/收起侧栏（推挤布局：展开时把页面右推，不遮挡对话框） */
function setSidebarOpen(open) {
  const sb = document.getElementById('lingya-sidebar');
  const toggle = document.getElementById('lingya-sidebar-toggle');
  if (!sb) return;
  const rootEl = document.documentElement;
  if (open) {
    sb.classList.remove('lingya-sidebar-hidden');
    if (toggle) toggle.classList.add('lingya-toggle-shifted');
    if (rootEl) rootEl.classList.add('lingya-sidebar-push');
    // 窗口加宽 280px：侧栏占新增空间，AI 对话区净宽不变
    try {
      if (window.electronAPI && typeof window.electronAPI.sidebarResizeWindow === 'function') {
        window.electronAPI.sidebarResizeWindow(true, 280).catch(() => {});
      }
    } catch (_) {}
    // 推挤：用 padding-left 推 body 内容（比 margin 可靠，不受子元素/宽度影响）
    try {
      if (document.body) {
        document.body.style.setProperty('padding-left', '280px', 'important');
        document.body.style.setProperty('box-sizing', 'border-box', 'important');
      }
    } catch (_) {}
    if (!treeLoaded) refreshFileTree();   // 首次展开时加载
  } else {
    sb.classList.add('lingya-sidebar-hidden');
    if (toggle) toggle.classList.remove('lingya-toggle-shifted');
    if (rootEl) rootEl.classList.remove('lingya-sidebar-push');
    // 窗口收窄回原宽
    try {
      if (window.electronAPI && typeof window.electronAPI.sidebarResizeWindow === 'function') {
        window.electronAPI.sidebarResizeWindow(false, 280).catch(() => {});
      }
    } catch (_) {}
    try {
      if (document.body) {
        document.body.style.removeProperty('padding-left');
        document.body.style.removeProperty('box-sizing');
      }
    } catch (_) {}
  }
  try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch (_) {}
}

function toggleSidebar() { setSidebarOpen(!isSidebarOpen()); }

/** 绑定文件树事件（幂等） */
let bound = false;
function bindFileTreeEvents() {
  if (bound) return;
  bound = true;

  const refreshBtn = document.getElementById('lingya-ft-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshFileTree);

  const searchInput = document.getElementById('lingya-ft-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filter = searchInput.value.trim();
      renderTree();
    });
  }

  const closePreview = document.getElementById('lingya-ft-preview-close');
  if (closePreview) {
    closePreview.addEventListener('click', () => {
      const box = document.getElementById('lingya-ft-preview');
      if (box) box.classList.add('lingya-hidden');
    });
  }

  // 侧栏开合
  const toggle = document.getElementById('lingya-sidebar-toggle');
  if (toggle) toggle.addEventListener('click', toggleSidebar);
  const closeBtn = document.getElementById('lingya-sidebar-close');
  if (closeBtn) closeBtn.addEventListener('click', () => setSidebarOpen(false));

  // Esc 收起侧栏
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSidebarOpen()) setSidebarOpen(false);
  });

  // 恢复上次状态
  let saved = '0';
  try { saved = localStorage.getItem(SIDEBAR_KEY) || '0'; } catch (_) {}
  if (saved === '1') setSidebarOpen(true);

  // 主题（独立于文件树，但一起绑定省事）
  initTheme();
}

// ========== 主题切换 ==========
const THEME_KEY = 'lingya-theme';

/** 应用主题（'dark' | 'light'） */
function applyTheme(theme) {
  const rootEl = document.documentElement;
  if (!rootEl) return;
  const isLight = theme === 'light';
  rootEl.classList.toggle('lingya-theme-light', isLight);
  const ico = document.getElementById('lingya-theme-ico');
  if (ico) ico.textContent = isLight ? '☀️' : '🌙';
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
}

function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { return 'dark'; }
}

function toggleTheme() {
  applyTheme(getTheme() === 'light' ? 'dark' : 'light');
}

/** 初始化主题（在 bindFileTreeEvents 里调用） */
function initTheme() {
  applyTheme(getTheme());
  const btn = document.getElementById('lingya-btn-theme');
  if (btn) btn.addEventListener('click', toggleTheme);
}

/** 仅初始化主题（文件树已迁移到壳页面，覆盖层只保留主题切换） */
function initThemeOnly() {
  initTheme();
}

module.exports = { bindFileTreeEvents, refreshFileTree, renderTree, filterTree, extOf, fileClass, setSidebarOpen, toggleSidebar, isSidebarOpen, applyTheme, toggleTheme, getTheme, initThemeOnly };
