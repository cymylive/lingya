/**
 * 壳页面渲染 —— 照搬 cuckoo-code files.ts + preview.ts 的实现
 * 项目文件树（SVG 图标 / 语言角标 / 搜索高亮）+ 分栏预览 + 拖拽调宽
 */
(function () {
  // 常量（SVG 图标 / 扩展名映射）已迁至 shell-utils.js，
  // 通过 window.__lyShellUtils 访问，此处不再重复定义。

  var MIN_W = 240, MAX_W = 640, DEFAULT_W = 320, COLLAPSED = 46;
  var WIDTH_KEY = 'lingya-sidebar-width', OPEN_KEY = 'lingya-sidebar-open';

  var slot = document.getElementById('lingya-sidebar-slot');
  var resizer = document.getElementById('lingya-sidebar-resizer');
  var abCollapse = document.getElementById('sh-ab-collapse');
  var expanded = {};        // 目录展开状态
  var cachedTree = [];
  var cachedTruncated = false;
  var open = false;
  var previewOpen = false;
  var currentFile = null;   // 当前预览/编辑的文件路径
  var editing = false;      // 是否处于编辑模式

  var width = (function () { try { var v=Number(localStorage.getItem(WIDTH_KEY)); if(isFinite(v)&&v>=MIN_W&&v<=MAX_W) return Math.round(v);}catch(_){} return DEFAULT_W; })();

  // 纯函数从 shell-utils.js 复用（审计后提取，已有 29 个单测覆盖）
  // 该模块经 <script src> 先行加载，挂到 window.__lyShellUtils
  var U = window.__lyShellUtils || {};
  if (!U.esc) {
    console.error('[LingYa Shell] shell-utils.js 未加载，文件树功能将不可用');
  }
  function esc(t){ return U.esc ? U.esc(t) : String(t == null ? '' : t); }
  function attr(t){ return U.attr ? U.attr(t) : String(t == null ? '' : t); }
  function extOf(name){ return U.extOf ? U.extOf(name) : ''; }
  function highlight(text, kw){ return U.highlight ? U.highlight(text, kw) : String(text == null ? '' : text); }
  function colorClass(name, type){ return U.colorClass ? U.colorClass(name, type) : ''; }
  function nameClass(name, type){ return U.nameClass ? U.nameClass(name, type) : 'ck-ft-name'; }
  function iconHtml(name, type){ return U.iconHtml ? U.iconHtml(name, type) : ''; }

  // ===== 开合 =====
  function applyState(notify) {
    slot.classList.toggle('open', open);
    slot.classList.toggle('collapsed', !open);
    slot.style.width = open ? (width+'px') : '';
    if (abCollapse) abCollapse.textContent = open ? '\u00ab' : '\u00bb';
    try { localStorage.setItem(OPEN_KEY, open?'1':'0'); } catch(_){}
    if (notify && window.shellAPI && window.shellAPI.toggleSidebar) window.shellAPI.toggleSidebar(open, width)['catch'](function(){});
    if (open && !cachedTree.length) loadFiles();
  }
  function setOpen(n){ open=!!n; applyState(true); }

  if (abCollapse) abCollapse.addEventListener('click', function(){ setOpen(!open); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape'&&open) setOpen(false); });

  // OLD_AB_REMOVED：活动栏绑定已迁移到文件末尾的多视图框架


  // ===== 侧栏拖拽调宽 =====
  if (resizer) {
    var sd=false;
    resizer.addEventListener('mousedown', function(e){
      if(!open) return; e.preventDefault(); sd=true; slot.classList.add('dragging'); document.body.style.cursor='col-resize';
      if(window.shellAPI&&window.shellAPI.startSidebarDrag) window.shellAPI.startSidebarDrag();
    });
    document.addEventListener('mousemove', function(e){
      if(!sd) return;
      width=Math.max(MIN_W,Math.min(MAX_W,Math.round(e.clientX)));
      try{localStorage.setItem(WIDTH_KEY,String(width));}catch(_){}
      slot.style.width=width+'px';
      if(window.shellAPI&&window.shellAPI.resizeSidebar) window.shellAPI.resizeSidebar(width)['catch'](function(){});
    });
    document.addEventListener('mouseup', function(){
      if(!sd) return; sd=false; slot.classList.remove('dragging'); document.body.style.cursor='';
      if(window.shellAPI&&window.shellAPI.endSidebarDrag) window.shellAPI.endSidebarDrag();
    });
  }

  // ===== 树渲染 =====
  // renderNodes / flatten 也来自 shell-utils（递归 + 转义逻辑，已有测试）
  function renderNodes(nodes, depth) {
    return U.renderNodes ? U.renderNodes(nodes, depth, expanded) : '';
  }
  function flatten(nodes, out){
    if (U.flatten) { U.flatten(nodes, out); return out; }
    out = out || [];
    if (!Array.isArray(nodes)) return out;
    for(var i=0;i<nodes.length;i++){ out.push(nodes[i]); if(nodes[i].children) flatten(nodes[i].children,out); }
    return out;
  }
  function renderSearch(kw){
    var all=flatten(cachedTree,[]), low=kw.toLowerCase();
    var m=[]; for(var i=0;i<all.length;i++){ if(all[i].path.toLowerCase().indexOf(low)!==-1) m.push(all[i]); }
    if(!m.length) return '<div class="ck-list-empty">无匹配结果</div>';
    m.sort(function(a,b){ if(a.type!==b.type) return a.type==='file'?-1:1; return a.path.localeCompare(b.path); });
    var html='';
    for(var j=0;j<m.length&&j<500;j++){
      var n=m[j], cls=n.type==='dir'?'ck-ft-dir':'ck-ft-file';
      html+='<div class="ck-ft-row '+cls+'" data-path="'+attr(n.path)+'" data-type="'+n.type+'" title="'+attr(n.path)+'">'+
        iconHtml(n.name,n.type)+'<span class="'+nameClass(n.name,n.type)+'">'+highlight(n.name,kw)+'</span>'+
        '<span class="ck-ft-path">'+highlight(n.path,kw)+'</span></div>';
    }
    if(m.length>500) html+='<div class="ck-ft-truncated">（结果过多，仅显示前 500 项）</div>';
    return html;
  }
  function currentKw(){ var s=document.getElementById('ft-search'); return s?String(s.value||'').trim():''; }
  function renderList(){
    var list=document.getElementById('ft-list'); if(!list) return;
    var kw=currentKw();
    if(kw){ list.innerHTML=renderSearch(kw); }
    else {
      if(!cachedTree.length){ list.innerHTML='<div class="ck-list-empty">空目录</div>'; }
      else list.innerHTML=renderNodes(cachedTree,0)+(cachedTruncated?'<div class="ck-ft-truncated">（节点过多，已截断）</div>':'');
    }
    bindRows(list);
  }
  function bindRows(list){
    var dirs=list.querySelectorAll('.ck-ft-dir');
    for(var i=0;i<dirs.length;i++){ (function(el){ el.addEventListener('click', function(){
      var p=el.dataset.path; if(expanded[p]) delete expanded[p]; else expanded[p]=true; renderList();
    }); })(dirs[i]); }
    var files=list.querySelectorAll('.ck-ft-file');
    for(var j=0;j<files.length;j++){ (function(el){ el.addEventListener('click', function(){
      var p=el.dataset.path; if(p) openPreview(p);
    }); })(files[j]); }
    // 右键菜单（所有行：文件可删/可复制，目录只可复制）
    var rows=list.querySelectorAll('.ck-ft-row');
    for(var k=0;k<rows.length;k++){ (function(el){ el.addEventListener('contextmenu', function(e){
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, el.dataset.path, el.dataset.type);
    }); })(rows[k]); }
  }

  // ===== 右键菜单 =====
  var ctxMenu = null;
  function closeContextMenu(){ if(ctxMenu){ ctxMenu.remove(); ctxMenu=null; } }
  function showContextMenu(x, y, path, type){
    closeContextMenu();
    var m = document.createElement('div');
    m.className = 'ck-ctx-menu';
    var items = [];
    // 目录：新建文件 / 新建文件夹（作为父目录）
    if (type === 'dir') {
      items.push({ label: '新建文件', act: 'newfile', icon: '\u002B' });
      items.push({ label: '新建文件夹', act: 'newdir', icon: '\u{1F4C1}' });
      items.push({ sep: true });
    }
    items.push({ label: '重命名', act: 'rename', icon: '\u270E' });
    items.push({ label: '复制绝对路径', act: 'copy', icon: '\u2398' });
    items.push({ sep: true });
    items.push({ label: '移到回收站', act: 'trash', icon: '\u267B' });
    items.push({ label: type === 'dir' ? '永久删除文件夹' : '永久删除', act: 'delete', icon: '\u2716', danger: true });
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'ck-ctx-sep'; m.appendChild(s); return; }
        var d = document.createElement('div');
        d.className = 'ck-ctx-item' + (it.danger ? ' danger' : '');
        d.innerHTML = '<span class="ck-ctx-ico">' + it.icon + '</span>' + it.label;
        d.addEventListener('click', function () { closeContextMenu(); doAction(it.act, path, type); });
        m.appendChild(d);
      })(items[i]);
    }
    document.body.appendChild(m);
    // 位置（防溢出）
    var rect = m.getBoundingClientRect();
    var px = Math.min(x, window.innerWidth - rect.width - 6);
    var py = Math.min(y, window.innerHeight - rect.height - 6);
    m.style.left = px + 'px';
    m.style.top = py + 'px';
    ctxMenu = m;
  }
  function doAction(act, path, type){
    if (act === 'newfile' || act === 'newdir') {
      var isDir = (act === 'newdir');
      promptInput(isDir ? '新建文件夹' : '新建文件', isDir ? '文件夹名' : '文件名（含扩展名）', '', function (name) {
        var fn = isDir ? window.shellAPI.createDir : window.shellAPI.createFile;
        fn(path, name).then(function (r) {
          if (r && r.success) { toast('已创建'); expanded[path] = true; loadFiles(); }
          else toast('创建失败: ' + ((r && r.error) || '?'));
        })['catch'](function (e) { toast('创建失败: ' + e.message); });
      });
      return;
    }
    if (act === 'rename') {
      var cur = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      promptInput('重命名', '新名称', cur, function (name) {
        window.shellAPI.rename(path, name).then(function (r) {
          if (r && r.success) { toast('已重命名'); loadFiles(); if (currentFile === path) { currentFile = r.newPath; openPreview(r.newPath); } }
          else toast('重命名失败: ' + ((r && r.error) || '?'));
        })['catch'](function (e) { toast('重命名失败: ' + e.message); });
      });
      return;
    }
    if (act === 'copy') {
      window.shellAPI.copyText(path).then(function (r) {
        if (r && r.success) toast('已复制路径');
        else toast('复制失败: ' + ((r && r.error) || '?'));
      })['catch'](function (e) { toast('复制失败: ' + e.message); });
    } else if (act === 'trash' || act === 'delete') {
      var useTrash = (act === 'trash');
      window.shellAPI.deleteFile(path, useTrash).then(function (r) {
        if (r && r.success) { toast(useTrash ? '已移到回收站' : '已永久删除'); loadFiles(); }
        else if (r && r.canceled) { /* 用户取消，不提示 */ }
        else toast('删除失败: ' + ((r && r.error) || '?'));
      })['catch'](function (e) { toast('删除失败: ' + e.message); });
    }
  }
  // ===== 输入弹窗（新建/重命名）=====
  var promptCb = null;
  function promptInput(title, placeholder, defVal, cb) {
    promptCb = cb;
    var mask = document.getElementById('ck-prompt-mask');
    var t = document.getElementById('ck-prompt-title');
    var inp = document.getElementById('ck-prompt-input');
    var err = document.getElementById('ck-prompt-err');
    if (!mask || !inp) return;
    if (t) t.textContent = title;
    inp.placeholder = placeholder || '';
    inp.value = defVal || '';
    if (err) err.textContent = '';
    mask.classList.add('show');
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  function closePrompt() {
    var mask = document.getElementById('ck-prompt-mask');
    if (mask) mask.classList.remove('show');
    promptCb = null;
  }
  function submitPrompt() {
    var inp = document.getElementById('ck-prompt-input');
    var err = document.getElementById('ck-prompt-err');
    if (!inp || !promptCb) return;
    var v = String(inp.value || '').trim();
    if (!v) { if (err) err.textContent = '名称不能为空'; return; }
    if (/[\\/:*?"<>|]/.test(v)) { if (err) err.textContent = '不能包含 \\ / : * ? " < > |'; return; }
    var cb = promptCb;
    closePrompt();
    try { cb(v); } catch (_) {}
  }

  function toast(msg){
    var t = document.getElementById('ck-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ck-toast'; t.className = 'ck-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }
  // 点击别处 / Esc 关闭菜单
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('contextmenu', function(e){ if(!e.target.closest('.ck-ft-row')) closeContextMenu(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeContextMenu(); });

  function loadFiles(){
    var list=document.getElementById('ft-list');
    if(!window.shellAPI||!window.shellAPI.getFileTree){ if(list) list.innerHTML='<div class="ck-list-empty">API 不可用</div>'; return; }
    window.shellAPI.getFileTree({}).then(function(r){
      if(!r||!r.success){ if(list) list.innerHTML='<div class="ck-list-empty">'+esc((r&&r.error)||'加载失败')+'</div>'; return; }
      var rootEl=document.getElementById('ft-root');
      if(rootEl&&r.root){ var base=String(r.root).replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'项目文件'; rootEl.textContent=base; rootEl.title=r.root; }
      cachedTree=r.tree||[]; cachedTruncated=!!r.truncated; renderList();
    })['catch'](function(){ if(list) list.innerHTML='<div class="ck-list-empty">加载失败</div>'; });
  }

  // ===== 预览 =====
  function fmtSize(n){ if(typeof n!=='number') return ''; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB'; }
  function openPreview(path){
    var pane=document.getElementById('ck-preview-pane');
    var nameEl=document.getElementById('ck-preview-name');
    var sizeEl=document.getElementById('ck-preview-size');
    var emptyEl=document.getElementById('ck-preview-empty');
    var pre=document.getElementById('ck-preview-pre');
    if(!pane) return;
    currentFile = path;
    exitEditMode(false);   // 切换文件时退出编辑（不保存）
    if(nameEl){ nameEl.textContent=path; nameEl.title=path; }
    if(sizeEl) sizeEl.textContent='';
    if(emptyEl){ emptyEl.style.display='block'; emptyEl.textContent='加载中…'; }
    if(pre) pre.style.display='none';
    if(!previewOpen){ previewOpen=true; pane.classList.add('open'); if(window.shellAPI&&window.shellAPI.toggleSidebar&&open) window.shellAPI.toggleSidebar(open, width)['catch'](function(){}); }
    window.shellAPI.readFilePreview(path).then(function(r){
      if(!r||!r.success){ if(emptyEl){ emptyEl.style.display='block'; emptyEl.textContent=(r&&r.error)||'读取失败'; } return; }
      if(sizeEl) sizeEl.textContent=fmtSize(r.size);
      if(emptyEl) emptyEl.style.display='none';
      if(pre){ pre.style.display='block'; pre.textContent=r.content||'(空文件)'; }
    })['catch'](function(e){ if(emptyEl){ emptyEl.style.display='block'; emptyEl.textContent='读取失败: '+e.message; } });
  }
  function closePreview(){ var p=document.getElementById('ck-preview-pane'); if(p) p.classList.remove('open'); previewOpen=false; }

  // ===== 预览区拖拽调宽（左边缘）=====
  (function () {
    var pane = document.getElementById('ck-preview-pane');
    if (!pane) return;
    var rz = document.createElement('div');
    rz.className = 'ck-preview-resizer';
    rz.title = '拖动调整预览宽度';
    pane.appendChild(rz);
    var PW_KEY = 'lingya-preview-width';
    // 恢复上次宽度
    try { var v = Number(localStorage.getItem(PW_KEY)); if (isFinite(v) && v >= 240 && v <= 1200) pane.style.width = v + 'px'; } catch (_) {}
    var dragging = false;
    rz.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      if (window.shellAPI && window.shellAPI.startSidebarDrag) window.shellAPI.startSidebarDrag();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      // 预览区右边缘固定（侧栏右侧），拖左边缘 → 宽度 = 侧栏右边 - 鼠标 x
      var sidebarRight = pane.getBoundingClientRect().right;
      var w = Math.round(sidebarRight - e.clientX);
      w = Math.max(240, Math.min(1200, w));
      pane.style.width = w + 'px';
      try { localStorage.setItem(PW_KEY, String(w)); } catch (_) {}
      if (window.shellAPI && window.shellAPI.resizeSidebar) window.shellAPI.resizeSidebar(width)['catch'](function(){});
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      if (window.shellAPI && window.shellAPI.endSidebarDrag) window.shellAPI.endSidebarDrag();
    });
  })();

  // ===== 编辑模式 =====
  function enterEditMode() {
    if (!currentFile) return;
    var area = document.getElementById('ck-preview-edit-area');
    var pre = document.getElementById('ck-preview-pre');
    var empty = document.getElementById('ck-preview-empty');
    var editBtn = document.getElementById('ck-preview-edit');
    var saveBtn = document.getElementById('ck-preview-save');
    var cancelBtn = document.getElementById('ck-preview-cancel');
    if (!area || !pre) return;
    area.value = pre.textContent || '';
    area.style.display = 'block';
    pre.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = '';
    if (cancelBtn) cancelBtn.style.display = '';
    editing = true;
    area.focus();
  }

  function exitEditMode(revert) {
    if (!editing) return;
    var area = document.getElementById('ck-preview-edit-area');
    var pre = document.getElementById('ck-preview-pre');
    var editBtn = document.getElementById('ck-preview-edit');
    var saveBtn = document.getElementById('ck-preview-save');
    var cancelBtn = document.getElementById('ck-preview-cancel');
    if (area) area.style.display = 'none';
    if (pre) pre.style.display = 'block';
    if (editBtn) editBtn.style.display = '';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    editing = false;
    // revert=true：丢弃改动（重新读盘）
    if (revert && currentFile) openPreview(currentFile);
  }

  function saveCurrentFile() {
    if (!currentFile) return;
    var area = document.getElementById('ck-preview-edit-area');
    if (!area) return;
    var content = area.value;
    window.shellAPI.writeFile(currentFile, content).then(function (r) {
      if (r && r.success) {
        toast('已保存 (' + r.bytes + ' 字节)');
        var pre = document.getElementById('ck-preview-pre');
        if (pre) pre.textContent = content;
        exitEditMode(false);
      } else {
        toast('保存失败: ' + ((r && r.error) || '?'));
      }
    })['catch'](function (e) { toast('保存失败: ' + e.message); });
  }

  document.getElementById('ft-refresh')&&document.getElementById('ft-refresh').addEventListener('click', loadFiles);

  // 编辑 / 保存 / 取消 按钮
  var _eb = document.getElementById('ck-preview-edit'); if (_eb) _eb.addEventListener('click', enterEditMode);
  var _sb = document.getElementById('ck-preview-save'); if (_sb) _sb.addEventListener('click', saveCurrentFile);
  var _cb = document.getElementById('ck-preview-cancel'); if (_cb) _cb.addEventListener('click', function(){ exitEditMode(true); });
  // 编辑区 Ctrl+S 保存 / Esc 取消
  var _ea = document.getElementById('ck-preview-edit-area');
  if (_ea) _ea.addEventListener('keydown', function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitEditMode(true); }
  });
  // 输入弹窗按钮
  var _pok = document.getElementById('ck-prompt-ok'); if (_pok) _pok.addEventListener('click', submitPrompt);
  var _pcancel = document.getElementById('ck-prompt-cancel'); if (_pcancel) _pcancel.addEventListener('click', closePrompt);
  var _pin = document.getElementById('ck-prompt-input');
  if (_pin) _pin.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePrompt(); }
  });
  var _pm = document.getElementById('ck-prompt-mask');
  if (_pm) _pm.addEventListener('click', function(e){ if (e.target === _pm) closePrompt(); });
  document.getElementById('ck-preview-close')&&document.getElementById('ck-preview-close').addEventListener('click', closePreview);
  var se=document.getElementById('ft-search');
  if(se){ var t=null; se.addEventListener('input', function(){ if(t)clearTimeout(t); t=setTimeout(renderList,150); });
    se.addEventListener('keydown', function(e){ if(e.key==='Escape'){ se.value=''; renderList(); } }); }

  // ===== 选择项目目录 =====
  var chooseDirBtn = document.getElementById('ft-choose-dir');
  if (chooseDirBtn) {
    chooseDirBtn.addEventListener('click', function () {
      if (!window.shellAPI || !window.shellAPI.chooseDir) return;
      chooseDirBtn.disabled = true;
      window.shellAPI.chooseDir().then(function (r) {
        chooseDirBtn.disabled = false;
        if (r && r.success) {
          var rootEl = document.getElementById('ft-root');
          if (r.dir && rootEl) { rootEl.textContent = String(r.dir).replace(/[\\/]+$/,'').split(/[\\/]/).pop() || '项目文件'; rootEl.title = r.dir; }
          cachedTree = []; expanded = {}; loadFiles();
        } else if (r && r.message) {
          console.log('[LingYa Shell] 选目录:', r.message);
        }
      })['catch'](function (e) { chooseDirBtn.disabled = false; console.error('[LingYa Shell] 选目录失败:', e.message); });
    });
  }
  // 初始读取当前目录（标题显示）
  if (window.shellAPI && window.shellAPI.getDir) {
    window.shellAPI.getDir().then(function (r) {
      if (r && r.success && r.dir) {
        var rootEl = document.getElementById('ft-root');
        if (rootEl) { rootEl.textContent = String(r.dir).replace(/[\\/]+$/,'').split(/[\\/]/).pop() || '项目文件'; rootEl.title = r.dir; }
      }
    })['catch'](function(){});
  }

  // ===== 侧栏背景色自定义 =====
  var BG_KEY = 'lingya-sidebar-bg';
  var PRESETS = ['#0c0e10', '#111827', '#1e1b4b', '#1a2e2a', '#2d1b2e', '#1c1917', '#0f172a', '#134e4a', '#fcfcfd', '#f1f5f9'];
  var bgPanel = document.getElementById('bg-panel');
  var bgColor = document.getElementById('bg-color');
  var bgPresets = document.getElementById('bg-presets');
  var bgReset = document.getElementById('bg-reset');

  function applySidebarBg(color) {
    if (!color) {
      slot.style.background = '';
      try { localStorage.removeItem(BG_KEY); } catch (_) {}
      return;
    }
    slot.style.background = color;
    try { localStorage.setItem(BG_KEY, color); } catch (_) {}
    // 同步到 activitybar 背景（略深/略亮）
    var ab = document.getElementById('lingya-activitybar');
    if (ab) ab.style.background = color;
  }

  // 预设色板
  if (bgPresets) {
    for (var pi = 0; pi < PRESETS.length; pi++) {
      (function (col) {
        var sw = document.createElement('div');
        sw.className = 'ck-bg-swatch';
        sw.style.background = col;
        sw.title = col;
        sw.addEventListener('click', function () {
          if (bgColor) bgColor.value = col;
          applySidebarBg(col);
          markActiveSwatch(col);
        });
        bgPresets.appendChild(sw);
      })(PRESETS[pi]);
    }
  }
  function markActiveSwatch(col) {
    var sws = bgPresets ? bgPresets.querySelectorAll('.ck-bg-swatch') : [];
    for (var i = 0; i < sws.length; i++) sws[i].classList.toggle('active', sws[i].title === col);
  }

  // 取色器
  if (bgColor) {
    bgColor.addEventListener('input', function () { applySidebarBg(bgColor.value); markActiveSwatch(bgColor.value); });
  }
  if (bgReset) {
    bgReset.addEventListener('click', function () {
      applySidebarBg('');
      if (bgColor) bgColor.value = '#0c0e10';
      markActiveSwatch('');
    });
  }
  // 面板开关
  var bgBtn = document.getElementById('ft-bg');
  if (bgBtn && bgPanel) {
    bgBtn.addEventListener('click', function () { bgPanel.classList.toggle('open'); });
  }
  // 恢复上次背景色
  (function () {
    var savedBg = '';
    try { savedBg = localStorage.getItem(BG_KEY) || ''; } catch (_) {}
    if (savedBg) {
      applySidebarBg(savedBg);
      if (bgColor) bgColor.value = savedBg;
      markActiveSwatch(savedBg);
    }
  })();

  // ===== 主题 =====
  function applyTheme(th){ document.documentElement.classList.toggle('lingya-theme-light', th==='light'); try{localStorage.setItem('lingya-theme',th);}catch(_){} }
  var theme='dark'; try{ theme=localStorage.getItem('lingya-theme')||'dark'; }catch(_){}
  applyTheme(theme);

  // ===== 恢复状态 =====
  var saved='0'; try{ saved=localStorage.getItem(OPEN_KEY)||'0'; }catch(_){}
  open = saved==='1';
  applyState(true);   // 初始恢复也通知主进程（open=true 恢复窗口宽）

  console.log('[LingYa Shell] renderer v4 (cuckoo port) 就绪, width='+width+', open='+open);

  // ===== 活动栏网格 + 拖拽排序（v0.6.37）=====
  var AB_W_BASE = 60;      // 单列基础宽度（52 格 + 8 padding）
  var AB_CELL = 54;        // 每增一列宽度（52 格 + 2 间距）
  var abCols = 1;
  var abOrder = [];
  try { var _ac = parseInt(localStorage.getItem('lingya-ab-cols'),10); if(_ac>=1&&_ac<=3) abCols=_ac; } catch(_e){}
  try { var _ao = JSON.parse(localStorage.getItem('lingya-ab-order')||'[]'); if(Array.isArray(_ao)) abOrder=_ao; } catch(_e){}

  function abWidth(){ return AB_W_BASE + (abCols-1)*AB_CELL; }
  function applyAbWidth(){
    document.documentElement.style.setProperty('--sh-ab-w', abWidth() + 'px');
    var slot=document.getElementById('lingya-sidebar-slot');
    if(slot && slot.classList.contains('collapsed')) slot.style.width = abWidth() + 'px';
  }
  function applyAbCols(){
    var grid=document.getElementById('sh-ab-grid');
    if(grid) grid.setAttribute('data-cols', String(abCols));
    applyAbWidth();
    var bs=document.querySelectorAll('.sh-cols-btn');
    for (var i=0;i<bs.length;i++) bs[i].classList.toggle('active', parseInt(bs[i].getAttribute('data-n'),10)===abCols);
    try { localStorage.setItem('lingya-ab-cols', String(abCols)); } catch(_e){}
    // 列数变化影响窗口宽度（通知主进程按当前 open 状态重算）
    if(window.shellAPI && window.shellAPI.toggleSidebar && open){ window.shellAPI.toggleSidebar(true, width)['catch'](function(){}); }
  }
  function applyAbOrder(){
    var grid=document.getElementById('sh-ab-grid');
    if(!grid) return;
    var items={};
    var all=grid.querySelectorAll('.sh-ab-item[data-view]');
    for (var i=0;i<all.length;i++) items[all[i].getAttribute('data-view')]=all[i];
    var names=Object.keys(items);
    // 按 abOrder 排序；不在 order 里的排后面
    names.sort(function(a,b){ var ia=abOrder.indexOf(a), ib=abOrder.indexOf(b); if(ia<0&&ib<0) return 0; if(ia<0) return 1; if(ib<0) return -1; return ia-ib; });
    for (var k=0;k<names.length;k++) grid.appendChild(items[names[k]]);
    // 插件视图图标固定插在「插件」图标之后，避免被排到列表末尾而不可见
    var pluginBtns = grid.querySelectorAll('.sh-ab-item[data-plugin-view]');
    var anchor = grid.querySelector('.sh-ab-item[data-view="plugins"]');
    for (var m=0;m<pluginBtns.length;m++){
      if(anchor) { if(anchor.nextSibling) grid.insertBefore(pluginBtns[m], anchor.nextSibling); else grid.appendChild(pluginBtns[m]); anchor = pluginBtns[m]; }
    }
    // 持久化完整顺序
    abOrder=names.slice();
    try { localStorage.setItem('lingya-ab-order', JSON.stringify(abOrder)); } catch(_e){}
  }
  function setupAbDrag(){
    var grid=document.getElementById('sh-ab-grid');
    if(!grid) return;
    var dragEl=null, startX=0, startY=0, moved=false;
    function onDown(e){
      if(e.button!==0) return;
      var el=e.target.closest?e.target.closest('.sh-ab-item[data-view]'):null;
      if(!el) return;
      dragEl=el; moved=false; startX=e.clientX; startY=e.clientY;
      // 注意：此处不加 sh-ab-dragging（它含 pointer-events:none，会吞掉 click）。
      // 只有真正开始拖动（onMove 超阈值）才加，保证普通点击仍能触发切换视图。
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
    }
    function onMove(e){
      if(!dragEl) return;
      if(!moved && Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)<5) return;
      if(!moved){ moved=true; dragEl.classList.add('sh-ab-dragging'); }
      e.preventDefault();
      // 找指针下的目标图标
      var over=document.elementFromPoint(e.clientX, e.clientY);
      var tgt=over && over.closest ? over.closest('.sh-ab-item[data-view]') : null;
      var all=grid.querySelectorAll('.sh-ab-item[data-view]');
      for(var i=0;i<all.length;i++) all[i].classList.remove('sh-ab-over');
      if(tgt && tgt!==dragEl){
        tgt.classList.add('sh-ab-over');
        var rect=tgt.getBoundingClientRect();
        var after=(e.clientX>rect.left+rect.width/2);
        if(after) grid.insertBefore(dragEl, tgt.nextSibling);
        else grid.insertBefore(dragEl, tgt);
      }
    }
    function onUp(e){
      if(!dragEl) return;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      dragEl.classList.remove('sh-ab-dragging');
      var all=grid.querySelectorAll('.sh-ab-item[data-view]');
      for(var i=0;i<all.length;i++) all[i].classList.remove('sh-ab-over');
      if(moved){
        // 从当前 DOM 顺序读出，持久化（不要再用旧 abOrder 重排，否则还原）
        var names=[];
        var els=grid.querySelectorAll('.sh-ab-item[data-view]');
        for(var k=0;k<els.length;k++) names.push(els[k].getAttribute('data-view'));
        abOrder=names.slice();
        try{ localStorage.setItem('lingya-ab-order', JSON.stringify(abOrder)); }catch(_e){}
      }
      dragEl=null;
    }
    grid.addEventListener('pointerdown', onDown, true);
  }

  // ===== 多视图框架（v0.6.36，v0.6.37 恢复）=====
  var rendered = {};
  function switchView(name){
    // 插件视图不单独占活动栏图标：高亮统一落在「插件」入口上
    var isPluginView = !!(typeof pluginViews !== 'undefined' && pluginViews && pluginViews[name]);
    var hlName = isPluginView ? 'plugins' : name;
    var tabs = document.querySelectorAll('.sh-ab-item[data-view]');
    for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view')===hlName);
    var vs = document.querySelectorAll('.sh-view');
    for (var j=0;j<vs.length;j++) vs[j].classList.toggle('sh-view-active', vs[j].getAttribute('data-view')===name);
    if (!rendered[name]) { rendered[name]=true; renderView(name); }
    try { localStorage.setItem('lingya-shell-view', name); } catch(_e){}
  }
  function panel(title, bodyHtml){
    return '<div class="sh-panel-head"><span class="sh-panel-title">'+title+'</span></div>'+'<div class="sh-panel-body">'+(bodyHtml||'')+'</div>';
  }
  // 注意：esc 已在文件顶部定义（委托给 shell-utils.js 的 U.esc，有单测覆盖）。
  // 这里曾有一份手写的重复实现，同作用域内函数声明后者覆盖前者 —— 虽然功能等价，
  // 但会让「改一处漏一处」：修了顶部那版，这里的旧实现继续生效。已删除。
  function toast2(m){ toast(m); }
  function renderView(name){
    var el = document.querySelector('.sh-view[data-view="'+name+'"]');
    if(!el) return;
    if(name==='plan') return renderPlanView(el);
    if(name==='memory') return renderMemoryView(el);
    if(name==='skill') return renderSkillView(el);
    if(name==='security') return renderSecurityView(el);
    if(name==='schedule') return renderScheduleView(el);
    if(name==='feishu') return renderFeishuView(el);
    if(name==='sessions') return renderSessionsView(el);
    if(name==='log') return renderLogView(el);
    if(name==='mcp') return renderMcpView(el);
    if(name==='plugins') return renderPluginsView(el);
    if(name==='windows') return renderWindowsView(el);
    if(name==='settings') return renderSettingsView(el);
    // 插件视图（动态 id 形如 pluginId:viewId）：顶部加「返回插件列表」栏
    if(pluginViews && pluginViews[name]) {
      var backBar = '<div style="flex-shrink:0;padding:8px 12px;border-bottom:1px solid var(--ck-border);display:flex;align-items:center;gap:8px;">'
        + '<button class="sh-btn" id="sh-plug-back" style="font-size:12px;">← 插件列表</button>'
        + '<span style="font-size:12px;color:var(--ck-text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(pluginViews[name].title || pluginViews[name].label || '') + '</span>'
        + '</div>';
      mountPluginHtml(el, backBar + '<div style="flex:1;min-height:0;overflow:auto;">' + pluginViews[name].html + '</div>');
      var bk = el.querySelector('#sh-plug-back');
      if(bk) bk.addEventListener('click', function(){ switchView('plugins'); });
      return;
    }
  }

  /**
   * 把插件视图 HTML 写入容器，并执行其中的 <script>。
   * 关键：innerHTML 不会执行脚本，且解析后的 <script> 元素 textContent 在部分情况下
   * 取不到内容 —— 所以先【用正则从原始 HTML 字符串】提取脚本，去掉 script 标签后再写入 DOM。
   */
  function mountPluginHtml(el, html){
    var scripts = [];
    var body = String(html).replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function(_m, code){ scripts.push(code); return ''; });
    el.innerHTML = body;
    for(var i=0;i<scripts.length;i++){
      try {
        var fn = new Function('window', 'document', scripts[i]);
        fn.call(window, window, document);
      } catch(err){
        console.error('[LingYa Shell] 插件视图脚本执行失败:', err && err.message);
        var errBox = document.createElement('div');
        errBox.style.cssText = 'color:#f87171;font-size:11px;padding:6px;white-space:pre-wrap;';
        errBox.textContent = '[插件脚本错误] ' + (err && err.message);
        el.appendChild(errBox);
      }
    }
  }

  // ===== 插件视图挂载（阶段2）=====
  var pluginViews = {};   // viewKey -> { html, ... }
  function mountPluginViews(){
    if(!window.shellAPI || !window.shellAPI.pluginViews) { console.warn('[LingYa Shell] pluginViews API 不可用'); return; }
    window.shellAPI.pluginViews().then(function(res){
      if(!res || !res.success) { console.warn('[LingYa Shell] pluginViews 返回失败', res); return; }
      var views = res.views || [];
      var content = document.getElementById('lingya-sidebar-content');
      if(!content) return;
      // 插件视图不单独占活动栏图标：容器建好，通过「插件」面板里的「打开面板」按钮进入
      var oldViews = content.querySelectorAll('.sh-view[data-plugin-view]');
      for(var j=0;j<oldViews.length;j++) oldViews[j].remove();
      pluginViews = {};
      for(var k=0;k<views.length;k++){
        var v = views[k];
        var key = v.viewId;
        pluginViews[key] = { html: v.html, label: v.label, title: v.title, pluginId: v.pluginId };
        var view = document.createElement('div');
        view.className = 'sh-view';
        view.setAttribute('data-view', key);
        view.setAttribute('data-plugin-view', '1');
        content.appendChild(view);
      }
      console.log('[LingYa Shell] 已挂载插件视图容器:', Object.keys(pluginViews).join(', '));
      // 若当前正停在插件面板，刷新它以显示最新「打开面板」按钮
      var cur = null; try { cur = localStorage.getItem('lingya-shell-view'); } catch(_e){}
      if(cur === 'plugins') { rendered['plugins'] = false; renderView('plugins'); }
    })['catch'](function(e){ console.error('[LingYa Shell] pluginViews 异常', e); });
  }

  // 市场状态提到面板外（重渲染时保留，避免安装后市场列表被清空）
  var dshMarketItems = [];
  var dshMarketCat = 'tool';
  var dshRenderMarket = null;   // 由 renderPluginsView 挂载（重绘函数）

  // ---- 插件管理面板 ----
  function renderPluginsView(el){
    el.innerHTML = panel('插件', '<div id="sh-plug-body" class="sh-empty">加载中…</div>');
    function draw(data){
      var box = document.getElementById('sh-plug-body');
      if(!box) return;
      if(!data || !data.success){ box.className='sh-empty'; box.textContent='加载失败：'+((data&&data.error)||'未知'); return; }
      var ps = data.plugins || [];
      box.className='';
      var html='';
      // 本地插件为空时显示提示，但**不 return** —— 否则下面的 DSH 区块/市场看不到
      if(!ps.length){
        html+='<div style="padding:8px;text-align:center;color:var(--ck-text-dim);font-size:11px;">暂无本地插件（放入目录：<span style="word-break:break-all;color:var(--ck-primary);">'+esc(data.dir||'')+'</span>）</div>';
      }
      for(var i=0;i<ps.length;i++){
        var p=ps[i];
        // 该插件是否有可打开的面板视图
        var viewKey = null;
        if(typeof pluginViews !== 'undefined' && pluginViews){
          for(var vk in pluginViews){ if(vk.indexOf(p.id+':')===0){ viewKey=vk; break; } }
        }
        html+='<div class="sh-card" style="margin-bottom:8px;" data-pid="'+esc(p.id)+'">'+
          '<div style="display:flex;align-items:center;gap:8px;">'+
            '<span style="font-size:18px;">'+esc(p.icon||'🔌')+'</span>'+
            '<div style="flex:1;min-width:0;">'+
              '<div style="font-size:12.5px;font-weight:600;color:var(--ck-title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+esc(p.name)+' <span style="font-weight:400;color:var(--ck-text-dim);font-size:10.5px;">v'+esc(p.version)+'</span></div>'+
              '<div style="font-size:11px;color:var(--ck-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+attr(p.id)+'">'+esc(p.id)+(p.loaded?' · 已加载':'')+'</div>'+
            '</div>'+
            '<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;flex-shrink:0;"><input type="checkbox" class="sh-plug-toggle" data-pid="'+esc(p.id)+'" '+(p.enabled?'checked':'')+' /> 启用</label>'+
          '</div>'+
          (p.description?('<div style="font-size:11px;color:var(--ck-text-dim);margin-top:6px;line-height:1.4;">'+esc(p.description)+'</div>'):'')+
          (viewKey?('<div style="margin-top:8px;"><button class="sh-btn primary sh-plug-open" data-view="'+esc(viewKey)+'" style="font-size:11.5px;width:100%;">打开面板</button></div>'):'')+
          '<div style="display:flex;gap:6px;margin-top:8px;">'+
            '<button class="sh-btn sh-plug-reload" data-pid="'+esc(p.id)+'" style="font-size:11px;">重载</button>'+
            '<button class="sh-btn sh-plug-export" data-pid="'+esc(p.id)+'" style="font-size:11px;">导出</button>'+
            '<button class="sh-btn sh-plug-delete" data-pid="'+esc(p.id)+'" style="font-size:11px;color:#f87171;">删除</button>'+
          '</div>'+
        '</div>';
      }
      html+='<div style="display:flex;gap:6px;margin-top:8px;">'+
        '<button class="sh-btn primary" id="sh-plug-import" style="flex:1;font-size:11.5px;">导入插件包</button>'+
        '<button class="sh-btn" id="sh-plug-opendir" style="flex:1;font-size:11.5px;">打开插件目录</button>'+
      '</div>'+
      '<div style="display:flex;gap:6px;margin-top:6px;">'+
        '<button class="sh-btn" id="sh-plug-refresh" style="flex:1;font-size:11.5px;">刷新列表</button>'+
      '</div>'+
      '<div class="sh-card" style="margin-top:12px;">'+
        '<div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:4px;">DSH 外部插件（npm）</div>'+
        '<div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:6px;line-height:1.4;">安装 DeepSeek Harness 生态的 npm 插件，如 <code style="color:var(--ck-primary);">@deepseek-ai/dsh-tool-todo</code></div>'+
        '<input id="sh-dsh-spec" placeholder="npm 包名（可带版本）" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:6px;color:var(--ck-text);font-size:12px;margin-bottom:6px;" />'+
        '<div style="display:flex;gap:6px;">'+
          '<button class="sh-btn primary" id="sh-dsh-install" style="flex:1;font-size:11.5px;">安装</button>'+
          '<button class="sh-btn" id="sh-dsh-refresh" style="font-size:11.5px;">刷新</button>'+
          '<button class="sh-btn" id="sh-dsh-opendir" style="font-size:11.5px;">目录</button>'+
        '</div>'+
        '<div id="sh-dsh-status" style="font-size:11px;margin-top:6px;white-space:pre-wrap;word-break:break-all;"></div>'+
        '<div id="sh-dsh-list" style="margin-top:8px;"></div>'+
        '<div style="margin-top:10px;border-top:1px solid var(--ck-border);padding-top:8px;">'+
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">'+
            '<span style="font-size:11.5px;font-weight:600;color:var(--ck-title);flex:1;">插件市场（npm）</span>'+
            '<button class="sh-btn" id="sh-dsh-market-refresh" style="font-size:10.5px;padding:2px 8px;">刷新</button>'+
          '</div>'+
          '<input id="sh-dsh-market-search" placeholder="搜索插件名 / 描述…" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px 8px;color:var(--ck-text);font-size:11.5px;margin-bottom:6px;" />'+
          '<div id="sh-dsh-market" style="font-size:11px;color:var(--ck-text-dim);">点「刷新」从 npm 拉取 DSH 插件列表</div>'+
        '</div>'+
      '</div>';
      box.innerHTML=html;

      var toggles=box.querySelectorAll('.sh-plug-toggle');
      for(var t=0;t<toggles.length;t++){ (function(cb){
        cb.addEventListener('change',function(){
          if(!window.shellAPI||!window.shellAPI.pluginSetEnabled) return;
          cb.disabled=true;
          window.shellAPI.pluginSetEnabled(cb.getAttribute('data-pid'), cb.checked).then(function(r){
            cb.disabled=false;
            if(r&&r.success){ toast2(cb.checked?'已启用':'已禁用'); draw({success:true,plugins:r.plugins,dir:data.dir}); }
            else toast2('操作失败：'+((r&&r.error)||'未知'));
          })['catch'](function(){ cb.disabled=false; toast2('操作失败'); });
        });
      })(toggles[t]); }
      var rls=box.querySelectorAll('.sh-plug-reload');
      for(var k=0;k<rls.length;k++){ (function(btn){
        btn.addEventListener('click',function(){
          if(!window.shellAPI||!window.shellAPI.pluginReload) return;
          window.shellAPI.pluginReload(btn.getAttribute('data-pid')).then(function(r){
            if(r&&r.success){ toast2('已重载'); draw({success:true,plugins:r.plugins,dir:data.dir}); }
            else toast2('重载失败：'+((r&&r.error)||'未知'));
          })['catch'](function(){ toast2('重载失败'); });
        });
      })(rls[k]); }
      var exps=box.querySelectorAll('.sh-plug-export');
      for(var e2=0;e2<exps.length;e2++){ (function(btn){
        btn.addEventListener('click',function(){
          if(!window.shellAPI||!window.shellAPI.pluginExport) return;
          btn.disabled=true;
          window.shellAPI.pluginExport(btn.getAttribute('data-pid')).then(function(r){
            btn.disabled=false;
            if(r&&r.success) toast2('已导出到：'+r.path); else toast2('导出失败：'+((r&&r.error)||'未知'));
          })['catch'](function(){ btn.disabled=false; toast2('导出失败'); });
        });
      })(exps[e2]); }
      var dels=box.querySelectorAll('.sh-plug-delete');
      for(var d2=0;d2<dels.length;d2++){ (function(btn){
        btn.addEventListener('click',function(){
          var pid=btn.getAttribute('data-pid');
          if(!confirm('确定删除插件 '+pid+' ？\n（会移除插件目录，不可恢复）')) return;
          if(!window.shellAPI||!window.shellAPI.pluginDelete) return;
          window.shellAPI.pluginDelete(pid).then(function(r){
            if(r&&r.success){ toast2('已删除'); draw({success:true,plugins:r.plugins,dir:data.dir}); }
            else toast2('删除失败：'+((r&&r.error)||'未知'));
          })['catch'](function(){ toast2('删除失败'); });
        });
      })(dels[d2]); }
      var opens=box.querySelectorAll('.sh-plug-open');
      for(var o2=0;o2<opens.length;o2++){ (function(btn){
        btn.addEventListener('click',function(){ switchView(btn.getAttribute('data-view')); });
      })(opens[o2]); }
      var im=document.getElementById('sh-plug-import');
      if(im) im.addEventListener('click',function(){
        if(!window.shellAPI||!window.shellAPI.pluginImport) return;
        im.disabled=true;
        window.shellAPI.pluginImport().then(function(r){
          im.disabled=false;
          if(r&&r.success){ toast2('已导入：'+(r.name||r.id)+(r.overwritten?'（覆盖）':'')); draw({success:true,plugins:r.plugins,dir:data.dir}); }
          else if(r&&r.error==='已取消'){ /* 用户取消，静默 */ }
          else toast2('导入失败：'+((r&&r.error)||'未知'));
        })['catch'](function(){ im.disabled=false; toast2('导入失败'); });
      });
      var od=document.getElementById('sh-plug-opendir');
      if(od) od.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.pluginOpenDir) window.shellAPI.pluginOpenDir()['catch'](function(){}); });
      var rf=document.getElementById('sh-plug-refresh');
      if(rf) rf.addEventListener('click',function(){ load(); toast2('已刷新'); });
      // ===== DSH 外部插件区块 =====
      function drawDsh(data){
        var box=document.getElementById('sh-dsh-list'); if(!box) return;
        var ps=(data&&data.plugins)||[];
        if(!ps.length){ box.innerHTML='<div style="font-size:11px;color:var(--ck-text-dim);text-align:center;padding:6px;">暂无 DSH 插件</div>'; return; }
        var h='';
        for(var i=0;i<ps.length;i++){ var p=ps[i];
          h+='<div style="border-top:1px solid var(--ck-border);padding:6px 0;font-size:11px;">'+
            '<div style="display:flex;align-items:center;gap:6px;">'+
              '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ck-text);" title="'+attr(p.name)+'">'+esc(p.name)+'</span>'+
              '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;flex-shrink:0;"><input type="checkbox" class="sh-dsh-toggle" data-id="'+esc(p.id)+'" '+(p.enabled?'checked':'')+' /> 启用</label>'+
            '</div>'+
            '<div style="color:var(--ck-text-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(p.id)+(p.loaded?(' · 工具: '+(p.toolNames||[]).join(',')):' · 未加载')+'</div>'+
            '<div style="display:flex;gap:4px;margin-top:4px;">'+
              '<button class="sh-btn sh-dsh-reload" data-id="'+esc(p.id)+'" style="font-size:10px;padding:2px 8px;">重载</button>'+
              '<button class="sh-btn sh-dsh-del" data-id="'+esc(p.id)+'" style="font-size:10px;padding:2px 8px;color:#f87171;">卸载</button>'+
            '</div>'+
          '</div>';
        }
        box.innerHTML=h;
        var tg=box.querySelectorAll('.sh-dsh-toggle');
        for(var t=0;t<tg.length;t++){ (function(cb){ cb.addEventListener('change',function(){
          cb.disabled=true;
          window.shellAPI.dshSetEnabled(cb.getAttribute('data-id'), cb.checked).then(function(r){ cb.disabled=false; toast2(cb.checked?'已启用':'已禁用'); drawDsh(r); })['catch'](function(){ cb.disabled=false; });
        }); })(tg[t]); }
        var rl=box.querySelectorAll('.sh-dsh-reload');
        for(var k=0;k<rl.length;k++){ (function(b){ b.addEventListener('click',function(){ window.shellAPI.dshReload(b.getAttribute('data-id')).then(function(r){ toast2('已重载'); drawDsh(r); })['catch'](function(){}); }); })(rl[k]); }
        var dl=box.querySelectorAll('.sh-dsh-del');
        for(var d=0;d<dl.length;d++){ (function(b){ b.addEventListener('click',function(){ if(!confirm('确定卸载该 DSH 插件？')) return; window.shellAPI.dshUninstall(b.getAttribute('data-id')).then(function(r){ toast2('已卸载'); drawDsh(r); })['catch'](function(){}); }); })(dl[d]); }
      }
      function loadDsh(){ if(window.shellAPI&&window.shellAPI.dshList) window.shellAPI.dshList().then(drawDsh)['catch'](function(){}); }
      loadDsh();
      var di=document.getElementById('sh-dsh-install');
      function setDshStatus(html){ var s=document.getElementById('sh-dsh-status'); if(s) s.innerHTML=html; }
      if(di) di.addEventListener('click',function(){
        var inp=document.getElementById('sh-dsh-spec'); var spec=inp?inp.value.trim():'';
        if(!spec){ toast2('请输入 npm 包名'); return; }
        di.disabled=true; di.textContent='安装中…';
        setDshStatus('<span style="color:var(--ck-text-dim);">正在安装 '+esc(spec)+'…（首次可能较慢，请稍候）</span>');
        window.shellAPI.dshInstall(spec).then(function(r){
          di.disabled=false; di.textContent='安装';
          if(r&&r.success){
            setDshStatus('<span style="color:#4ade80;">✓ 已安装 '+(r.loaded?'并加载成功':'（npm 装好，但插件加载失败: '+esc(r.loadError||'未知')+'）')+'</span>');
            if(inp) inp.value='';
            if(r.plugins) drawDsh(r); else loadDsh();
          } else {
            var err=(r&&r.error)||'未知';
            setDshStatus('<span style="color:#f87171;">✗ 安装失败：'+esc(err)+'</span>');
          }
        })['catch'](function(e){ di.disabled=false; di.textContent='安装'; setDshStatus('<span style="color:#f87171;">✗ 安装异常：'+esc(e&&e.message||String(e))+'</span>'); });
      });
      var dr=document.getElementById('sh-dsh-refresh');
      if(dr) dr.addEventListener('click',function(){ loadDsh(); toast2('已刷新'); });
      var doo=document.getElementById('sh-dsh-opendir');
      if(doo) doo.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.dshOpenDir) window.shellAPI.dshOpenDir()['catch'](function(){}); });
      // ===== 插件市场 =====
      var marketItems = dshMarketItems;      // 用面板外的缓存（重渲染时保留）
      var marketCat = dshMarketCat;
      var CATS = [['tool','工具'],['app','组合包'],['ui','界面'],['experimental','实验'],['service','服务'],['all','全部']];
      function drawMarket(data){
        var box=document.getElementById('sh-dsh-market'); if(!box) return;
        if(!data||!data.success){ box.innerHTML='<span style="color:#f87171;">加载失败：'+esc((data&&data.error)||'未知')+'</span>'; return; }
        marketItems = data.items||[];
        dshMarketItems = marketItems;        // 同步到面板外缓存
        renderMarketList(data);
      }
      // 暴露给 load()：面板重渲染后（box 已重建）用缓存重绘市场
      window.__dshRedrawMarket = function(){
        if(!dshMarketItems.length) return;
        try { drawMarket({ success: true, items: dshMarketItems, fromCache: true }); } catch (_) {}
      };
      function renderMarketList(data){
        var box=document.getElementById('sh-dsh-market'); if(!box) return;
        // 统计各分类
        var counts={all:marketItems.length};
        for(var i=0;i<marketItems.length;i++){ var c=marketItems[i].category||'service'; counts[c]=(counts[c]||0)+1; }
        // 分类标签
        var tabs='<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
        for(var t=0;t<CATS.length;t++){ var ck=CATS[t][0], cl=CATS[t][1];
          var on=(ck===marketCat);
          tabs+='<span class="sh-dsh-cat" data-cat="'+ck+'" style="cursor:pointer;font-size:10.5px;padding:2px 7px;border-radius:10px;'+(on?'background:var(--ck-primary);color:#fff;':'background:var(--ck-surface);color:var(--ck-text-dim);')+'">'+cl+' '+(counts[ck]||0)+'</span>';
        }
        tabs+='</div>';
        // 搜索关键词
        var kwEl = document.getElementById('sh-dsh-market-search');
        var kw = kwEl ? kwEl.value.trim().toLowerCase() : '';
        // 过滤：分类 + 关键词（匹配包名或描述）
        var filtered = marketCat==='all' ? marketItems : marketItems.filter(function(x){return (x.category||'service')===marketCat;});
        if(kw){ filtered = filtered.filter(function(x){
          return (x.name||'').toLowerCase().indexOf(kw)>=0
            || (x.description||'').toLowerCase().indexOf(kw)>=0
            || (x.descriptionZh||'').toLowerCase().indexOf(kw)>=0;
        }); }
        var h=tabs+'<div style="color:var(--ck-text-dim);font-size:10.5px;margin-bottom:4px;">共 '+filtered.length+' 个'+(kw?('（搜索：'+esc(kw)+'）'):'')+(data.fromCache?'（缓存）':'')+'</div>';
        for(var k=0;k<filtered.length && k<200;k++){ var it=filtered[k];
          // 优先中文描述，回退英文
          var desc = it.descriptionZh || it.description || '';
          var isZh = !!it.descriptionZh;
          h+='<div style="border-top:1px solid var(--ck-border);padding:5px 0;">'+
            '<div style="display:flex;align-items:center;gap:6px;">'+
              '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ck-text);" title="'+attr(it.name)+'">'+esc(it.name.replace('@deepseek-ai/',''))+'</span>'+
              '<span style="color:var(--ck-text-dim);font-size:10px;flex-shrink:0;">'+esc(it.version)+'</span>'+
              '<button class="sh-btn sh-dsh-mi-install" data-spec="'+attr(it.name)+'" style="font-size:10px;padding:1px 6px;flex-shrink:0;">安装</button>'+
            '</div>'+
            (desc?('<div style="color:'+(isZh?'var(--ck-text-2)':'var(--ck-text-dim)')+';font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+attr(desc)+'">'+esc(desc)+'</div>'):'')+
          '</div>';
        }
        box.innerHTML=h;
        // 分类点击
        var cs=box.querySelectorAll('.sh-dsh-cat');
        for(var m=0;m<cs.length;m++){ (function(el){ el.addEventListener('click',function(){ marketCat=el.getAttribute('data-cat'); dshMarketCat=marketCat; renderMarketList(data); }); })(cs[m]); }
        // 把市场重绘函数挂到模块级，供面板重渲染后复用（关键：避免安装后市场列表被清空）
        dshRenderMarket = renderMarketList;
        var ibs=box.querySelectorAll('.sh-dsh-mi-install');
        for(var k=0;k<ibs.length;k++){ (function(b){ b.addEventListener('click',function(){
          var spec=b.getAttribute('data-spec'); b.disabled=true; b.textContent='装中…';
          var st=document.getElementById('sh-dsh-status'); if(st) st.innerHTML='<span style="color:var(--ck-text-dim);">正在安装 '+esc(spec)+'…</span>';
          window.shellAPI.dshInstall(spec).then(function(r){
            b.disabled=false; b.textContent='安装';
            var st2=document.getElementById('sh-dsh-status');
            if(r&&r.success){
              if(st2) st2.innerHTML='<span style="color:#4ade80;">✓ 已安装 '+(r.loaded?'并加载成功':'（加载失败: '+esc(r.loadError||'')+'）')+'</span>';
              // 用返回值里的 plugins 直接刷新已装列表（避免二次拉取的时序问题）
              if(r.plugins) drawDsh(r); else loadDsh();
            } else if(st2) st2.innerHTML='<span style="color:#f87171;">✗ 安装失败：'+esc((r&&r.error)||'未知')+'</span>';
          })['catch'](function(e){ b.disabled=false; b.textContent='安装'; var st3=document.getElementById('sh-dsh-status'); if(st3) st3.innerHTML='<span style="color:#f87171;">✗ 异常：'+esc(e&&e.message||String(e))+'</span>'; });
        }); })(ibs[k]); }
      }
      var mr=document.getElementById('sh-dsh-market-refresh');
      if(mr) mr.addEventListener('click',function(){
        var box=document.getElementById('sh-dsh-market'); if(box) box.textContent='加载中…';
        mr.disabled=true;
        window.shellAPI.dshMarket(true).then(function(r){ mr.disabled=false; drawMarket(r); })['catch'](function(){ mr.disabled=false; });
      });
      // 搜索框：输入实时过滤（用已加载的 marketItems，不重新请求）
      var ms=document.getElementById('sh-dsh-market-search');
      if(ms) ms.addEventListener('input',function(){
        if(!marketItems.length) return;   // 市场还没加载，忽略
        renderMarketList({ success:true, items:marketItems, fromCache:true });
      });
    }
    function load(){
      if(!window.shellAPI||!window.shellAPI.pluginList){ var b=document.getElementById('sh-plug-body'); if(b){b.className='sh-empty';b.textContent='插件 API 不可用';} return; }
      window.shellAPI.pluginList().then(draw).then(function(){
        // draw() 重建了 box.innerHTML（含市场容器）→ 若已有市场缓存，立即重绘（不清空）
        if(dshMarketItems.length && typeof window.__dshRedrawMarket==='function') window.__dshRedrawMarket();
      })['catch'](function(e){ var b=document.getElementById('sh-plug-body'); if(b){b.className='sh-empty';b.textContent='加载失败：'+e.message;} });
    }
    load();
  }

  // ---- 计划面板 ----
  function renderPlanView(el){
    el.innerHTML = panel('任务计划',
      // ===== 任务状态条（AI 视图上报，见 ui.js 的 reportTaskState）=====
      // 侧边栏与 AI 视图是两个独立 webContents，状态真相源在 AI 视图侧，
      // 这里只负责显示主进程转发过来的内容。
      '<div id="sh-taskbar" style="display:none;margin-bottom:10px;padding:6px 10px;border-radius:8px;font-size:11.5px;line-height:16px;background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.28);color:var(--ck-text);align-items:center;gap:6px;">'+
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="sh-taskbar-text">处理中</span>'+
        '<span style="flex-shrink:0;font-family:monospace;color:var(--ck-text-dim);" id="sh-taskbar-elapsed"></span>'+
      '</div>'+
      // ===== Agent 模式切换（Plan / Build）=====
      // 放在计划视图顶部：模式决定「AI 能不能动手改东西」，和计划是同一件事的两面
      // —— 在 Plan 里排好步骤，切到 Build 立刻执行，不用再跑去设置页翻。
      '<div style="margin-bottom:10px;">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'+
          '<span style="font-size:12px;font-weight:700;color:var(--ck-title);">Agent 模式</span>'+
          '<span id="sh-agent-hint" style="font-size:10px;color:var(--ck-text-dim);max-width:60%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>'+
        '</div>'+
        '<div id="sh-agent-switch" style="display:flex;gap:4px;">'+
          '<button class="sh-btn" data-agent="build" style="flex:1;padding:5px 0;font-size:12px;">🔨 Build</button>'+
          '<button class="sh-btn" data-agent="plan" style="flex:1;padding:5px 0;font-size:12px;">📋 Plan</button>'+
        '</div>'+
      '</div>'+
      '<div style="margin-bottom:10px;">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'+
          '<span style="font-size:12px;font-weight:700;color:var(--ck-title);">我的待办</span>'+
          '<span id="sh-utodo-count" style="font-size:11px;color:var(--ck-primary);font-weight:700;">0/0</span>'+
        '</div>'+
        '<div id="sh-utodo-list" style="display:flex;flex-direction:column;gap:2px;margin-bottom:6px;"></div>'+
        '<div style="display:flex;gap:4px;">'+
          '<textarea id="sh-utodo-input" placeholder="添加待办…（支持 1. xxx 多行）" rows="1" style="flex:1;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px 7px;color:var(--ck-text);font-size:12px;outline:none;resize:vertical;min-height:28px;max-height:80px;font-family:inherit;"></textarea>'+
          '<button id="sh-utodo-add" class="sh-btn primary" style="flex-shrink:0;width:28px;padding:0;font-size:15px;font-weight:700;">+</button>'+
        '</div>'+
      '</div>'+
      '<div style="font-size:12px;font-weight:700;color:var(--ck-title);margin-bottom:6px;">任务计划</div>'+
      '<div id="sh-plan-body" class="sh-empty">加载中…</div>');

    // ===== 我的待办（用户手动，与 AI 计划完全独立）=====
    var userTodos = [];
    var editingId = null;

    function drawUserTodos(items){
      if(editingId) return;   // 编辑期间不重渲染，防焦点丢失
      userTodos = Array.isArray(items)?items:[];
      var box = document.getElementById('sh-utodo-list');
      var cnt = document.getElementById('sh-utodo-count');
      if(!box) return;
      var done = 0; for(var i=0;i<userTodos.length;i++) if(userTodos[i].done) done++;
      if(cnt) cnt.textContent = done+'/'+userTodos.length;
      if(!userTodos.length){ box.innerHTML='<div class="sh-empty" style="padding:6px 0;">暂无待办</div>'; return; }
      var h='';
      for(var k=0;k<userTodos.length;k++){
        var t=userTodos[k];
        var deco = t.done?'text-decoration:line-through;opacity:.55;':'';
        h+='<div class="sh-utodo-item" data-id="'+esc(t.id)+'" style="display:flex;gap:6px;align-items:flex-start;padding:3px 2px;border-radius:4px;">'+
             '<span class="sh-utodo-check" data-act="toggle" style="flex-shrink:0;width:13px;height:13px;margin-top:2px;border:1.5px solid '+(t.done?'#4ade80':'var(--ck-text-dim)')+';border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:'+(t.done?'#0b0e10':'transparent')+';background:'+(t.done?'#4ade80':'transparent')+';">✓</span>'+
             '<span class="sh-utodo-text" data-act="edit" style="flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-word;font-size:12px;cursor:text;'+deco+'">'+esc(t.text)+'</span>'+
             '<span class="sh-utodo-start" data-act="start" style="flex-shrink:0;cursor:pointer;color:var(--ck-primary);font-size:11px;padding:0 3px;opacity:.6;">▶</span>'+
             '<span class="sh-utodo-del" data-act="del" style="flex-shrink:0;cursor:pointer;color:var(--ck-text-dim);font-size:13px;opacity:.5;">×</span>'+
           '</div>';
      }
      box.innerHTML=h;

      var rows = box.querySelectorAll('.sh-utodo-item');
      for(var j=0;j<rows.length;j++){
        (function(row){
          var id = row.getAttribute('data-id');
          var item = null; for(var m=0;m<userTodos.length;m++) if(userTodos[m].id===id){ item=userTodos[m]; break; }
          if(!item) return;
          var ck = row.querySelector('[data-act="toggle"]');
          if(ck) ck.addEventListener('click', function(e){
            e.stopPropagation();
            if(!window.shellAPI) return;
            window.shellAPI.userTodosUpdate(id, {done:!item.done}).then(function(r){
              // 失败必须有反馈：原实现静默吞掉，用户点了没反应也不知道为什么
              if(r && !r.success) toast2('操作失败：' + (r.error || '待办不存在（可能属于其他会话）'));
            })['catch'](function(err){ toast2('操作失败：' + ((err && err.message) || '未知错误')); });
          });
          var tx = row.querySelector('[data-act="edit"]');
          if(tx) tx.addEventListener('dblclick', function(e){ e.stopPropagation(); startEdit(row, item); });
          var st = row.querySelector('[data-act="start"]');
          if(st) st.addEventListener('click', function(e){
            e.stopPropagation();
            if(st.getAttribute('data-busy')==='1') return;
            st.setAttribute('data-busy','1');
            st.style.opacity='0.3';
            var msg = '【待办任务】' + item.text + String.fromCharCode(10) + String.fromCharCode(10) + '请开始处理这个任务。';
            var p = (window.shellAPI && window.shellAPI.sendToChat)
              ? window.shellAPI.sendToChat(msg, '待办任务')
              : Promise.reject(new Error('sendToChat 不可用'));
            p.then(function(r){
              if (r && r.success) toast2('已发送给 AI');
              else toast2('发送失败');
            })['catch'](function(){ toast2('发送失败'); })
             .then(function(){ setTimeout(function(){ st.setAttribute('data-busy',''); st.style.opacity='0.6'; }, 3000); });
          });
          var dl = row.querySelector('[data-act="del"]');
          if(dl) dl.addEventListener('click', function(e){
            e.stopPropagation();
            if(!window.shellAPI) return;
            window.shellAPI.userTodosDelete(id).then(function(r){
              if(r && !r.success) toast2('删除失败：' + (r.error || '待办不存在（可能属于其他会话）'));
            })['catch'](function(err){ toast2('删除失败：' + ((err && err.message) || '未知错误')); });
          });
        })(rows[j]);
      }
    }

    function startEdit(row, item){
      if(editingId) return;
      editingId = item.id;
      var tx = row.querySelector('[data-act="edit"]');
      if(!tx){ editingId=null; return; }
      var inp = document.createElement('input');
      inp.type='text'; inp.value=item.text; inp.maxLength=500;
      inp.style.cssText='flex:1;background:var(--ck-surface);border:1px solid var(--ck-primary);border-radius:4px;padding:1px 5px;color:var(--ck-text);font-size:12px;outline:none;font-family:inherit;';
      tx.replaceWith(inp); inp.focus(); inp.select();
      var settled=false;
      function finish(save){
        if(settled) return; settled=true; editingId=null;
        var v=inp.value.trim();
        if(save && v && v!==item.text && window.shellAPI) window.shellAPI.userTodosUpdate(item.id,{text:v})['catch'](function(){});
        drawUserTodos(userTodos);
      }
      inp.addEventListener('keydown', function(e){
        if(e.key==='Enter'){ e.preventDefault(); finish(true); }
        else if(e.key==='Escape'){ e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', function(){ finish(true); });
    }

    function reloadUserTodos(){
      if(!window.shellAPI || !window.shellAPI.userTodosList) return;
      window.shellAPI.userTodosList().then(function(r){
        if(r && r.success){
          // 【关键】同步本窗口的会话 ID。
          //
          // 原实现只渲染不记录 sessionId，导致 window.__lingyaShellSessionId 长期为 null：
          //   - 广播过滤条件 `p.sessionId && window.__lingyaShellSessionId && ...` 短路 → 不过滤
          //   - 结果：别的窗口/别的会话的待办串到当前窗口显示
          //   - 更糟：这些"外来"待办属于另一个 sessionId，用户点删除时主进程用当前
          //     sessionId 查不到，返回"待办不存在" → 点了没反应
          // 与 reloadPlan() 保持一致，查询结果里带 sessionId 就记下来。
          if(r.sessionId) window.__lingyaShellSessionId = r.sessionId;
          drawUserTodos(r.todos);
        }
      })['catch'](function(){});
    }

    // 系统消息前缀（与 tools/UserTodoStore.js 保持一致，前端只为友好提示）
    var SYSTEM_PREFIXES_UI = ['【监督续跑】','【自动续跑】','【系统提示】','【工具执行结果】','【JS 执行结果','【计划续跑】','【兜底续跑】','【中断续跑】'];

    function submitUserTodo(){
      var inp = document.getElementById('sh-utodo-input');
      if(!inp || !window.shellAPI || !window.shellAPI.userTodosAdd) return;
      var text = String(inp.value||'').trim();
      if(!text) return;
      // 预检：避免把系统消息当待办（存储层也会拒，这里给出更友好的提示）
      for(var si=0; si<SYSTEM_PREFIXES_UI.length; si++){
        if(text.indexOf(SYSTEM_PREFIXES_UI[si])===0){
          toast2('这看起来是系统消息，不能作为待办');
          return;
        }
      }
      window.shellAPI.userTodosAdd(text).then(function(r){
        if(r && r.success){ inp.value=''; inp.rows=1; if(Array.isArray(r.todos)) drawUserTodos(r.todos); }
        else if(r && r.error){ toast2('添加失败：' + r.error); }
      })['catch'](function(){});
    }

    // 用户待办广播订阅：**全局只注册一次**。
    // renderPlanView 每次切到「计划」视图都会重建 DOM 并重新执行本函数，
    // 若无守卫，监听器会随切换次数累积（每次广播触发 N 次渲染 + 内存泄漏）。
    // 用 window 级标记 + 模块级回调转发实现幂等注册。
    window.__lingyaUserTodoDraw = drawUserTodos;
    window.__lingyaUserTodoReload = reloadUserTodos;
    reloadUserTodos();
    if(!window.__lingyaUserTodoSubscribed && window.shellAPI && window.shellAPI.onUserTodosUpdated){
      window.__lingyaUserTodoSubscribed = true;
      window.shellAPI.onUserTodosUpdated(function(p){
        if(!p) return;
        // 【严格过滤】避免别的会话/窗口的待办串到当前面板。
        //
        // 原条件是 `p.sessionId && cur && p.sessionId !== cur` —— 三个都必须为真才过滤。
        // 当 cur 为 null（本地还没查到会话 ID）时条件短路 → 任何广播都渲染，
        // 于是别的窗口的待办就显示在这里，且点删除会因会话不匹配而失败。
        //
        // 改为：只要广播带 sessionId，且它不等于本地已知的 sessionId（含 null），就忽略。
        // 本地 sessionId 未知时不渲染外来数据，宁可等 reloadUserTodos 拉到自己的。
        if(p.sessionId && p.sessionId !== window.__lingyaShellSessionId) return;
        // 转发到当前活跃视图的回调（切视图后旧回调会失效，这里始终用最新的）
        if(typeof window.__lingyaUserTodoDraw !== 'function') return;
        if(Array.isArray(p.todos)) window.__lingyaUserTodoDraw(p.todos);
        else if(typeof window.__lingyaUserTodoReload === 'function') window.__lingyaUserTodoReload();
      });
    }

    var utInput = document.getElementById('sh-utodo-input');
    if(utInput){
      utInput.addEventListener('keydown', function(e){
        if(e.key==='Enter' && !e.shiftKey){
          // 【最后一道防线】只接受真实用户触发的 Enter。
          // 程序合成的 KeyboardEvent（如 chat-input 的 triggerSend 误把本框当聊天框）
          // isTrusted 为 false —— 直接忽略，防止消息被误提交成待办。
          if(!e.isTrusted){
            console.warn('[LingYa] 忽略合成的 Enter（非用户输入），避免误提交待办');
            return;
          }
          e.preventDefault();
          submitUserTodo();
        }
      });
      utInput.addEventListener('input', function(){
        var n = String(utInput.value||'').split('\n').length;
        utInput.rows = Math.max(1, Math.min(3, n));
      });
    }
    var utBtn = document.getElementById('sh-utodo-add');
    if(utBtn) utBtn.addEventListener('click', submitUserTodo);
    function draw(todos){
      var box = document.getElementById('sh-plan-body');
      if(!box) return;
      var items = Array.isArray(todos)?todos:[];
      if(!items.length){ box.innerHTML='<div class="sh-empty">暂无计划。AI 用 todoWrite 时显示。</div>'; return; }
      var done=0; for(var i=0;i<items.length;i++) if(items[i].status==='completed') done++;
      var pct=Math.round(done/items.length*100);
      var h='<div style="height:4px;border-radius:999px;background:rgba(255,255,255,.08);margin-bottom:8px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:var(--ck-primary);"></div></div>';
      h+='<div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:6px;">进度 '+done+'/'+items.length+'</div>';
      for(var k=0;k<items.length;k++){
        var t=items[k], st=t.status||'pending';
        var ico= st==='completed'?'✔': st==='in_progress'?'◐':'○';
        var col= st==='completed'?'#4ade80': st==='in_progress'?'var(--ck-primary)':'var(--ck-text-dim)';
        var deco= st==='completed'?'text-decoration:line-through;opacity:.6;':'';
        h+='<div class="sh-list-item" style="display:flex;gap:6px;align-items:flex-start;"><span style="color:'+col+';flex-shrink:0;">'+ico+'</span><span style="flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-word;'+deco+'">'+esc(t.content)+'</span></div>';
      }
      box.innerHTML=h;
    }
    // 本窗口当前会话 id：用于过滤其它窗口的 todo 广播，避免跨窗串扰
    if (typeof window.__lingyaShellSessionId === 'undefined') window.__lingyaShellSessionId = null;
    // 主动查询（会话切换、首次加载时用）
    function reloadPlan(){
      if(window.shellAPI&&window.shellAPI.getTodos){
        window.shellAPI.getTodos().then(function(r){
          if (r && r.sessionId) window.__lingyaShellSessionId = r.sessionId;
          draw(r&&r.todos);
        })['catch'](function(){});
      }
    }
    // todoWrite 变更：直接用事件 payload 里的 todos 渲染，不再多发一次 get-todos IPC。
    // 原实现每次计划更新侧边栏都多跑一趟 IPC 往返 + 主进程会话解析，计划更新频繁时累积成卡顿。
    function onTodosUpdate(payload){
      if(!payload) return;
      // 带 sessionId 且与当前会话不符 → 忽略（避免多窗口串扰）
      if(payload.sessionId && window.__lingyaShellSessionId && payload.sessionId !== window.__lingyaShellSessionId) return;
      if(Array.isArray(payload.todos)) draw(payload.todos);
      else reloadPlan();
    }
    // ===== 订阅注册（必须幂等）=====
    // renderPlanView 每次切到「计划」视图都会重建 DOM 并重新执行本函数。
    // 虽然 rendered[name] 缓存挡住了常规重复渲染，但 line 728 存在显式重置
    // rendered['plugins']=false 的模式 —— 一旦有类似重置作用于 plan 视图，
    // 无守卫会导致监听器累积（广播触发 N 次渲染 + 内存泄漏）。
    // 用 window 级标记 + 回调转发实现幂等，与 user-todos 的处理保持一致。
    window.__lingyaPlanDraw = draw;
    window.__lingyaPlanReload = reloadPlan;
    reloadPlan();

    if(!window.__lingyaPlanSubscribed && window.shellAPI && window.shellAPI.onTodosUpdated){
      window.__lingyaPlanSubscribed = true;
      window.shellAPI.onTodosUpdated(function(payload){
        if(!payload) return;
        // 带 sessionId 且与当前会话不符 → 忽略（避免多窗口串扰）
        if(payload.sessionId && window.__lingyaShellSessionId && payload.sessionId !== window.__lingyaShellSessionId) return;
        // 转发到当前活跃视图的回调（切视图后旧闭包指向失效 DOM，必须用最新的）
        if(Array.isArray(payload.todos)){
          if(typeof window.__lingyaPlanDraw === 'function') window.__lingyaPlanDraw(payload.todos);
        } else {
          if(typeof window.__lingyaPlanReload === 'function') window.__lingyaPlanReload();
        }
      });
    }

    // 会话切换 → 更新本窗口 sessionId 并重新查询
    if(!window.__lingyaSessionChangedSubscribed && window.shellAPI && window.shellAPI.onSessionChanged){
      window.__lingyaSessionChangedSubscribed = true;
      window.shellAPI.onSessionChanged(function(p){
        window.__lingyaShellSessionId = (p && p.sessionId) || null;
        if(typeof window.__lingyaPlanReload === 'function') window.__lingyaPlanReload();
        if(typeof window.__lingyaUserTodoReload === 'function') window.__lingyaUserTodoReload();
      });
    }

    // ===== Agent 模式切换（Plan / Build）=====
    // 状态由主进程 agent-store 持久化（per-profile），这里只做展示与切换。
    // 不做广播订阅：切换入口就在本视图，切完自己重绘即可；跨入口同步成本高于收益。
    // 放在函数末尾：面板 HTML 与 user-todos 渲染代码需保持连续（测试按固定窗口切片断言 esc() 用量）。
    (function(){
      var box = document.getElementById('sh-agent-switch');
      if(!box || !window.shellAPI) return;
      var curAgent = 'build';
      var defs = [];

      function hl(){
        var bs = box.querySelectorAll('button[data-agent]');
        for(var i=0;i<bs.length;i++){
          var on = bs[i].getAttribute('data-agent') === curAgent;
          bs[i].style.background = on ? 'var(--ck-primary)' : '';
          bs[i].style.color = on ? '#fff' : '';
          bs[i].style.borderColor = on ? 'var(--ck-primary)' : 'var(--ck-border)';
        }
        var hint = document.getElementById('sh-agent-hint');
        if(hint){
          var d = null;
          for(var k=0;k<defs.length;k++) if(defs[k].id === curAgent){ d = defs[k]; break; }
          hint.textContent = d ? d.description : '';
          hint.title = d ? d.description : '';
        }
      }

      function load(){
        if(!window.shellAPI.listAgents) return;
        window.shellAPI.listAgents().then(function(r){
          if(r && r.success){
            defs = r.agents || [];
            curAgent = r.current || 'build';
            hl();
          }
        })['catch'](function(){});
      }

      function pick(aid){
        if(aid === curAgent) return;
        if(!window.shellAPI.setAgent){ toast2('接口不可用'); return; }
        window.shellAPI.setAgent(aid).then(function(r){
          if(r && r.success){
            curAgent = r.agentId || aid;
            hl();
            toast2('已切换到 ' + (curAgent === 'plan' ? 'Plan 模式（只读规划）' : 'Build 模式（可执行）'));
          } else {
            toast2('切换失败：' + ((r && r.error) || '未知错误'));
          }
        })['catch'](function(){ toast2('切换失败'); });
      }

      var bs = box.querySelectorAll('button[data-agent]');
      for(var i=0;i<bs.length;i++){
        (function(b){
          b.addEventListener('click', function(){ pick(b.getAttribute('data-agent')); });
        })(bs[i]);
      }
      load();
    })();

    // ===== 任务状态条订阅（AI 视图 → 主进程 → 这里）=====
    // 全局只注册一次：renderPlanView 每次切视图都会重执行，无守卫会累积监听器。
    // 用 window 级回调转发，让订阅始终指向当前活跃视图的 DOM。
    window.__lingyaTaskbarDraw = function(p){
      var bar = document.getElementById('sh-taskbar');
      var tx = document.getElementById('sh-taskbar-text');
      var el2 = document.getElementById('sh-taskbar-elapsed');
      if(!bar) return;
      if(!p || !p.visible){
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'flex';
      // 配色随类型变化：执行中偏暖，后台任务偏紫
      var kind = p.kind || 'busy';
      if(kind === 'executing'){
        bar.style.background = 'rgba(245,158,11,.10)';
        bar.style.borderColor = 'rgba(245,158,11,.30)';
      } else if(kind === 'background'){
        bar.style.background = 'rgba(168,85,247,.10)';
        bar.style.borderColor = 'rgba(168,85,247,.30)';
      } else {
        bar.style.background = 'rgba(59,130,246,.10)';
        bar.style.borderColor = 'rgba(59,130,246,.28)';
      }
      if(tx) tx.textContent = p.text || '处理中';
      if(el2){
        var ms = Number(p.elapsedMs) || 0;
        var s = Math.floor(ms / 1000);
        el2.textContent = s < 60 ? (s + 's')
          : (s < 3600 ? (Math.floor(s/60) + 'm' + String(s%60).padStart(2,'0') + 's')
          : (Math.floor(s/3600) + 'h' + String(Math.floor(s%3600/60)).padStart(2,'0') + 'm'));
      }
    };
    if(!window.__lingyaTaskStateSubscribed && window.shellAPI && window.shellAPI.onTaskStateUpdated){
      window.__lingyaTaskStateSubscribed = true;
      window.shellAPI.onTaskStateUpdated(function(p){
        if(typeof window.__lingyaTaskbarDraw === 'function') window.__lingyaTaskbarDraw(p);
      });
    }
  }

  // ---- 记忆面板 ----

  function renderMemoryView(el){
    el.innerHTML = panel('长期记忆',
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">'+
        '<select id="sh-mem-filter" style="background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:11px;flex:1;"><option value="">全部类型</option><option value="user">用户画像</option><option value="feedback">行为反馈</option><option value="topic">话题上下文</option><option value="reference">参考资料</option></select>'+
        '<button class="sh-btn" id="sh-mem-new">新建</button>'+
        '<button class="sh-btn" id="sh-mem-insertall">全部插入</button>'+
        '<button class="sh-btn" id="sh-mem-import">导入</button>'+
        '<button class="sh-btn" id="sh-mem-export">导出</button>'+
      '</div>'+
      '<input id="sh-mem-search" placeholder="搜索记忆…" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px 8px;color:var(--ck-text);font-size:12px;outline:none;margin-bottom:6px;" />'+
      '<div id="sh-mem-editor" class="sh-card" style="display:none;margin-bottom:8px;">'+
        '<input id="sh-mem-ed-name" placeholder="标题" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<select id="sh-mem-ed-type" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;"><option value="user">用户画像</option><option value="feedback">行为反馈</option><option value="topic">话题上下文</option><option value="reference">参考资料</option></select>'+
        '<textarea id="sh-mem-ed-content" placeholder="内容" rows="4" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;resize:vertical;"></textarea>'+
        '<input id="sh-mem-ed-tags" placeholder="标签（逗号分隔）" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<label style="font-size:11px;color:var(--ck-text-dim);display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="checkbox" id="sh-mem-ed-pinned" /> 置顶</label>'+
        '<div style="display:flex;gap:6px;"><button class="sh-btn primary" id="sh-mem-ed-save">保存</button><button class="sh-btn" id="sh-mem-ed-cancel">取消</button></div>'+
      '</div>'+
      '<div id="sh-mem-body" class="sh-empty">加载中…</div>');
    var mems=[], editingId=null;
    function tlabel(t){ var M={user:'用户画像',feedback:'行为反馈',topic:'话题上下文',reference:'参考资料'}; return M[t]||t||''; }
    function showEditor(m){ editingId=m?m.id:null; var ed=document.getElementById('sh-mem-editor'); if(ed) ed.style.display='block'; var n=document.getElementById('sh-mem-ed-name'); if(n) n.value=m?m.name:''; var ty=document.getElementById('sh-mem-ed-type'); if(ty) ty.value=m?(m.type||'user'):'user'; var c=document.getElementById('sh-mem-ed-content'); if(c) c.value=m?m.content:''; var tg=document.getElementById('sh-mem-ed-tags'); if(tg) tg.value=(m&&m.tags)?m.tags.join(', '):''; var pn=document.getElementById('sh-mem-ed-pinned'); if(pn) pn.checked=!!(m&&m.pinned); }
    function hideEditor(){ editingId=null; var ed=document.getElementById('sh-mem-editor'); if(ed) ed.style.display='none'; }
    function draw(){
      var box=document.getElementById('sh-mem-body'); if(!box) return;
      var f=(document.getElementById('sh-mem-filter')||{}).value||'';
      var kw=((document.getElementById('sh-mem-search')||{}).value||'').toLowerCase();
      var list=mems.filter(function(m){ if(f&&m.type!==f) return false; if(!kw) return true; return (String(m.name||'')+String(m.content||'')+(m.tags||[]).join(' ')).toLowerCase().indexOf(kw)>=0; });
      if(!list.length){ box.innerHTML='<div class="sh-empty">'+(mems.length?'无匹配':'暂无记忆')+'</div>'; return; }
      var h='';
      for(var i=0;i<list.length;i++){ var m=list[i];
        h+='<div class="sh-list-item"><div style="display:flex;align-items:center;gap:6px;">';
        h+='<span style="font-size:10px;color:var(--ck-primary);">'+esc(tlabel(m.type))+'</span>';
        if(m.pinned) h+='<span style="font-size:10px;">📌</span>';
        h+='<span style="font-weight:600;color:var(--ck-title);flex:1;overflow:hidden;text-overflow:ellipsis;">'+esc(m.name||'(未命名)')+'</span></div>';
        h+='<div style="font-size:11px;color:var(--ck-text-dim);margin-top:4px;max-height:60px;overflow:hidden;">'+esc(m.content||'')+'</div>';
        h+='<div style="display:flex;gap:10px;margin-top:6px;font-size:11px;">';
        h+='<span class="sh-mem-insert" data-id="'+esc(m.id)+'" style="cursor:pointer;color:var(--ck-primary);">插入</span>';
        h+='<span class="sh-mem-edit" data-id="'+esc(m.id)+'" style="cursor:pointer;color:var(--ck-text);">编辑</span>';
        h+='<span class="sh-mem-del" data-id="'+esc(m.id)+'" style="cursor:pointer;color:#f87171;">删除</span></div></div>';
      }
      box.innerHTML=h;
      var byId=function(id){ for(var k=0;k<mems.length;k++) if(String(mems[k].id)===String(id)) return mems[k]; return null; };
      var q=function(cls,fn){ var els=box.querySelectorAll(cls); for(var x=0;x<els.length;x++){ (function(e2){ e2.addEventListener('click',function(){ fn(byId(e2.getAttribute('data-id'))); }); })(els[x]); } };
      q('.sh-mem-insert',function(m){ if(!m) return; if(window.shellAPI&&window.shellAPI.insertToChat) window.shellAPI.insertToChat('【记忆】'+m.name+'：'+m.content,'插入记忆').then(function(r){ toast2(r&&r.success?'已插入':'插入失败'); })['catch'](function(){}); });
      q('.sh-mem-edit',function(m){ showEditor(m); });
      q('.sh-mem-del',function(m){ if(!m) return; if(window.shellAPI&&window.shellAPI.deleteMemory) window.shellAPI.deleteMemory(m.id).then(function(){ toast2('已删除'); load(); })['catch'](function(){}); });
    }
    function load(){ if(!window.shellAPI||!window.shellAPI.listMemories) return; window.shellAPI.listMemories().then(function(r){ mems=(r&&r.memories)||[]; draw(); })['catch'](function(){}); }
    var edSave=document.getElementById('sh-mem-ed-save');
    if(edSave) edSave.addEventListener('click',function(){
      var name=((document.getElementById('sh-mem-ed-name')||{}).value||'').trim();
      var content=((document.getElementById('sh-mem-ed-content')||{}).value||'').trim();
      if(!name){ toast2('标题不能为空'); return; }
      if(!content){ toast2('内容不能为空'); return; }
      var mem={ type:((document.getElementById('sh-mem-ed-type')||{}).value||'user'), name:name, content:content, tags:(((document.getElementById('sh-mem-ed-tags')||{}).value||'').split(',').map(function(x){return x.trim();}).filter(Boolean)), pinned:!!((document.getElementById('sh-mem-ed-pinned')||{}).checked) };
      var pr = (editingId!=null) ? window.shellAPI.updateMemory(Object.assign({id:editingId},mem)) : window.shellAPI.saveMemory(mem);
      pr.then(function(r){ if(r&&r.success){ toast2(editingId!=null?'已更新':'已保存'); hideEditor(); load(); } else toast2('保存失败'); })['catch'](function(){ toast2('保存失败'); });
    });
    var edCancel=document.getElementById('sh-mem-ed-cancel'); if(edCancel) edCancel.addEventListener('click',hideEditor);
    var nw=document.getElementById('sh-mem-new'); if(nw) nw.addEventListener('click',function(){ showEditor(null); });
    var ia=document.getElementById('sh-mem-insertall'); if(ia) ia.addEventListener('click',function(){ if(!mems.length){ toast2('没有记忆'); return; } var nl=String.fromCharCode(10); var txt='【长期记忆】'+nl+mems.map(function(m){return '- ['+tlabel(m.type)+'] '+m.name+'：'+m.content;}).join(nl); if(window.shellAPI&&window.shellAPI.insertToChat) window.shellAPI.insertToChat(txt,'插入全部记忆').then(function(r){ toast2(r&&r.success?('已插入 '+mems.length+' 条'):'插入失败'); })['catch'](function(){}); });
    var im=document.getElementById('sh-mem-import'); if(im) im.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.importMemories) window.shellAPI.importMemories().then(function(r){ if(r&&r.success){ toast2('导入完成：新增 '+r.imported); load(); } else if(r&&!r.canceled) toast2('导入失败'); })['catch'](function(){}); });
    var ex=document.getElementById('sh-mem-export'); if(ex) ex.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.exportMemories) window.shellAPI.exportMemories().then(function(r){ if(r&&r.success) toast2('已导出 '+r.count+' 条'); })['catch'](function(){}); });
    var se=document.getElementById('sh-mem-search'); if(se) se.addEventListener('input',draw);
    var fl=document.getElementById('sh-mem-filter'); if(fl) fl.addEventListener('change',draw);
    load();
  }


  function renderSkillView(el){
    el.innerHTML = panel('技能库',
      '<div style="display:flex;gap:4px;margin-bottom:6px;">'+
        '<button class="sh-btn primary" id="sh-sk-new">新建</button>'+
        '<button class="sh-btn" id="sh-sk-import">本地导入</button>'+
      '</div>'+
      '<input id="sh-sk-search" placeholder="搜索技能…" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px 8px;color:var(--ck-text);font-size:12px;outline:none;margin-bottom:6px;" />'+
      '<div id="sh-sk-editor" class="sh-card" style="display:none;margin-bottom:8px;">'+
        '<input id="sh-sk-ed-name" placeholder="技能名称" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<input id="sh-sk-ed-desc" placeholder="简介" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<textarea id="sh-sk-ed-instructions" placeholder="指令内容（插入到对话）" rows="4" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;resize:vertical;"></textarea>'+
        '<label style="font-size:11px;color:var(--ck-text-dim);display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="checkbox" id="sh-sk-ed-memory" checked /> 会话记忆</label>'+
        '<div style="display:flex;gap:6px;"><button class="sh-btn primary" id="sh-sk-ed-save">保存</button><button class="sh-btn" id="sh-sk-ed-cancel">取消</button></div>'+
      '</div>'+
      '<div id="sh-sk-body" class="sh-empty">加载中…</div>');
    var skills=[], editingName=null;
    function srcLabel(x){ var M={custom:'自定义',local:'本地导入'}; return M[x]||x||'自定义'; }
    function showEditor(sk){ editingName=sk?sk.name:null; var ed=document.getElementById('sh-sk-editor'); if(ed) ed.style.display='block'; var n=document.getElementById('sh-sk-ed-name'); if(n) n.value=sk?sk.name:''; var d=document.getElementById('sh-sk-ed-desc'); if(d) d.value=sk?sk.description:''; var it=document.getElementById('sh-sk-ed-instructions'); if(it) it.value=sk?sk.instructions:''; var m=document.getElementById('sh-sk-ed-memory'); if(m) m.checked=sk?(sk.memoryEnabled!==false):true; }
    function hideEditor(){ editingName=null; var ed=document.getElementById('sh-sk-editor'); if(ed) ed.style.display='none'; }
    function draw(){
      var box=document.getElementById('sh-sk-body'); if(!box) return;
      var kw=((document.getElementById('sh-sk-search')||{}).value||'').toLowerCase();
      var list=skills.filter(function(s){ if(!kw) return true; return (String(s.name||'')+String(s.description||'')+String(s.instructions||'')).toLowerCase().indexOf(kw)>=0; });
      if(!list.length){ box.innerHTML='<div class="sh-empty">'+(skills.length?'无匹配':'暂无技能')+'</div>'; return; }
      var h='';
      for(var i=0;i<list.length;i++){ var s=list[i]; var on=s.enabled!==false;
        h+='<div class="sh-list-item"><div style="display:flex;align-items:center;gap:6px;">';
        h+='<span class="sh-sk-toggle" data-name="'+esc(s.name)+'" style="cursor:pointer;color:'+(on?'#4ade80':'var(--ck-text-dim)')+';">'+(on?'●':'○')+'</span>';
        h+='<span style="font-weight:600;color:var(--ck-title);flex:1;overflow:hidden;text-overflow:ellipsis;">'+esc(s.name)+'</span>';
        h+='<span style="font-size:10px;color:var(--ck-text-dim);">'+esc(srcLabel(s.source))+'</span></div>';
        if(s.description) h+='<div style="font-size:11px;color:var(--ck-text-dim);margin-top:4px;max-height:50px;overflow:hidden;">'+esc(s.description)+'</div>';
        h+='<div style="display:flex;gap:10px;margin-top:6px;font-size:11px;">';
        h+='<span class="sh-sk-insert" data-name="'+esc(s.name)+'" style="cursor:pointer;color:var(--ck-primary);">插入</span>';
        h+='<span class="sh-sk-edit" data-name="'+esc(s.name)+'" style="cursor:pointer;color:var(--ck-text);">编辑</span>';
        h+='<span class="sh-sk-del" data-name="'+esc(s.name)+'" style="cursor:pointer;color:#f87171;">删除</span></div></div>';
      }
      box.innerHTML=h;
      var byName=function(nm){ for(var k=0;k<skills.length;k++) if(skills[k].name===nm) return skills[k]; return null; };
      var q=function(cls,fn){ var els=box.querySelectorAll(cls); for(var x=0;x<els.length;x++){ (function(e2){ e2.addEventListener('click',function(){ fn(e2.getAttribute('data-name')); }); })(els[x]); } };
      q('.sh-sk-toggle',function(nm){ var s=byName(nm); if(!s) return; var next=!(s.enabled!==false); window.shellAPI.setSkillEnabled(nm,next).then(function(){ load(); })['catch'](function(){}); });
      q('.sh-sk-insert',function(nm){ var s=byName(nm); if(!s) return; if(window.shellAPI&&window.shellAPI.insertToChat) window.shellAPI.insertToChat(s.instructions||'','插入技能').then(function(r){ toast2(r&&r.success?'已插入':'插入失败'); })['catch'](function(){}); });
      q('.sh-sk-edit',function(nm){ showEditor(byName(nm)); });
      q('.sh-sk-del',function(nm){ window.shellAPI.deleteSkill(nm).then(function(){ toast2('已删除'); load(); })['catch'](function(){}); });
    }
    function load(){ if(!window.shellAPI||!window.shellAPI.listSkills) return; window.shellAPI.listSkills().then(function(r){ skills=(r&&r.skills)||[]; draw(); })['catch'](function(){}); }
    var sv=document.getElementById('sh-sk-ed-save');
    if(sv) sv.addEventListener('click',function(){
      var skill={ name:((document.getElementById('sh-sk-ed-name')||{}).value||'').trim(), description:((document.getElementById('sh-sk-ed-desc')||{}).value||'').trim(), instructions:((document.getElementById('sh-sk-ed-instructions')||{}).value||'').trim(), memoryEnabled:!!((document.getElementById('sh-sk-ed-memory')||{}).checked), source:'custom' };
      if(!skill.name){ toast2('技能名称不能为空'); return; }
      if(!skill.instructions){ toast2('指令内容不能为空'); return; }
      window.shellAPI.saveSkill(skill).then(function(r){ if(r&&r.success){ toast2(editingName!=null?'已更新':'已保存'); hideEditor(); load(); } else toast2('保存失败'); })['catch'](function(){ toast2('保存失败'); });
    });
    var cn=document.getElementById('sh-sk-ed-cancel'); if(cn) cn.addEventListener('click',hideEditor);
    var nwb=document.getElementById('sh-sk-new'); if(nwb) nwb.addEventListener('click',function(){ showEditor(null); });
    var im=document.getElementById('sh-sk-import'); if(im) im.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.importSkillFolder) window.shellAPI.importSkillFolder().then(function(r){ if(r&&r.success){ toast2('已导入 '+(r.imported||0)+' 个技能'); load(); } else if(r&&!r.canceled) toast2('导入失败'); })['catch'](function(){}); });
    var se=document.getElementById('sh-sk-search'); if(se) se.addEventListener('input',draw);
    load();
  }


  function renderSecurityView(el){
    el.innerHTML = panel('安全增强', '<div id="sh-sec-body" class="sh-empty">加载中…</div>');
    if(!window.shellAPI||!window.shellAPI.getSecurityConfig) return;
    window.shellAPI.getSecurityConfig().then(function(c){
      var box=document.getElementById('sh-sec-body'); if(!box) return;
      c=c||{};
      function chk(id,label,key){ return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;"><input type="checkbox" id="'+id+'" '+(c[key]?'checked':'')+' /> '+label+'</label>'; }
      function inp(id,label,val,ph){ return '<div style="margin-top:6px;font-size:11px;color:var(--ck-text-dim);">'+label+'</div><input id="'+id+'" value="'+esc(val||'')+'" placeholder="'+esc(ph||'')+'" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;" />'; }
      function num(id,label,val){ return '<div style="margin-top:6px;font-size:11px;color:var(--ck-text-dim);">'+label+'</div><input type="number" id="'+id+'" value="'+esc(val)+'" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;" />'; }
      function ta(id,label,val){ return '<div style="margin-top:6px;font-size:11px;color:var(--ck-text-dim);">'+label+'</div><textarea id="'+id+'" rows="4" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;resize:vertical;">'+esc(val||'')+'</textarea>'; }
      var h='<div class="sh-card">';
      h+=chk('sh-sec-ctf','CTF 提示词注入','ctfInjectionEnabled');
      h+=ta('sh-sec-ctfprompt','CTF 提示词',c.ctfPrompt);
      h+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--ck-border);font-size:12px;font-weight:600;color:var(--ck-title);">自动逆向改写</div>';
      h+=chk('sh-sec-refusal','启用自动改写（检测到 AI 拒绝时自动重写并重发）','refusalEnabled');
      h+=chk('sh-sec-local','优先本地规则改写（零成本零延迟）','localRewriteEnabled');
      h+=chk('sh-sec-ai','失败时用 AI 改写','aiRewriteEnabled');
      h+='<div style="margin-left:20px;padding-left:8px;border-left:2px solid var(--ck-border);">';
      h+=inp('sh-sec-endpoint','AI 接口地址',c.aiEndpoint,'https://api.openai.com/v1');
      h+=inp('sh-sec-key','AI Key','',c.aiKeyConfigured?'已配置（留空不修改）':'sk-...');
      h+=inp('sh-sec-model','模型',c.aiModel);
      h+='</div>';
      h+=chk('sh-sec-aichat','用当前对话改写（免 API）','aiRewriteViaChat');
      h+='<div style="margin-top:8px;"><button class="sh-btn" id="sh-sec-manual" style="width:100%;">立即改写上一条回复（手动触发）</button></div>';
      h+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--ck-border);font-size:12px;font-weight:600;color:var(--ck-title);">自动续跑</div>';
      h+=chk('sh-sec-autoc','自动续写','autoContinueEnabled');
      h+=inp('sh-sec-autotext','续写文本',c.autoContinueText);
      h+=num('sh-sec-automax','自动续写次数上限',c.autoContinueMax!=null?c.autoContinueMax:5);
      h+=num('sh-sec-planmax','计划续跑次数上限',c.planContinueMax!=null?c.planContinueMax:5);
      h+=chk('sh-sec-unplanned','无计划兜底续跑','unplannedContinueEnabled');
      h+=chk('sh-sec-stall','停滞监督者','stallSupervisorEnabled');
      h+=num('sh-sec-stallth','停滞阈值(秒)',c.stallThresholdMs!=null?Math.round(c.stallThresholdMs/1000):120);
      h+=num('sh-sec-stallmax','停滞续跑上限',c.stallContinueMax!=null?c.stallContinueMax:5);
      h+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--ck-border);font-size:12px;font-weight:600;color:var(--ck-title);">初始提示分片</div>';
      h+=num('sh-sec-chunksize','单段字符上限（2000~100000，默认 15000）',c.promptChunkSize!=null?c.promptChunkSize:15000);
      h+='<div style="font-size:10.5px;color:var(--ck-text-dim);margin-top:2px;line-height:1.5;">系统提示词太长会拆成多段依次发送，每段不超过此值。调大=段数少但可能被平台拒收；调小=更保险但初始化变慢。下次初始化项目时生效。</div>';
      h+=ta('sh-sec-mock','模拟响应（调试用）',c.mockResponse);
      h+='</div>';
      h+='<div style="display:flex;gap:6px;margin-top:8px;"><button class="sh-btn primary" id="sh-sec-save">保存</button><button class="sh-btn" id="sh-sec-reset">重置</button><button class="sh-btn" id="sh-sec-inject">立即注入CTF</button></div>';
      box.innerHTML=h;
      var sv=document.getElementById('sh-sec-save');
      if(sv) sv.addEventListener('click',function(){
        function v(id){ var e=document.getElementById(id); return e?e.value:''; }
        function ck(id){ var e=document.getElementById(id); return !!(e&&e.checked); }
        var patch={ ctfInjectionEnabled:ck('sh-sec-ctf'), ctfPrompt:v('sh-sec-ctfprompt'), refusalEnabled:ck('sh-sec-refusal'), localRewriteEnabled:ck('sh-sec-local'), aiRewriteEnabled:ck('sh-sec-ai'), aiRewriteViaChat:ck('sh-sec-aichat'), aiEndpoint:v('sh-sec-endpoint'), aiModel:v('sh-sec-model'), autoContinueEnabled:ck('sh-sec-autoc'), autoContinueText:v('sh-sec-autotext'), autoContinueMax:v('sh-sec-automax'), planContinueMax:v('sh-sec-planmax'), unplannedContinueEnabled:ck('sh-sec-unplanned'), stallSupervisorEnabled:ck('sh-sec-stall'), stallThresholdMs:(function(){ var s=Math.floor(Number(v('sh-sec-stallth'))); return s>0?s*1000:''; })(), stallContinueMax:v('sh-sec-stallmax'), promptChunkSize:v('sh-sec-chunksize'), mockResponse:v('sh-sec-mock') };
        var ky=v('sh-sec-key'); if(ky) patch.aiKey=ky;
        window.shellAPI.updateSecurityConfig(patch).then(function(){ toast2('已保存'); })['catch'](function(){ toast2('保存失败'); });
      });
      var rb=document.getElementById('sh-sec-reset');
      if(rb) rb.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.resetSecurityConfig) window.shellAPI.resetSecurityConfig().then(function(){ toast2('已重置，请重开此面板'); })['catch'](function(){ toast2('重置失败'); }); });
      var mb=document.getElementById('sh-sec-manual');
      if(mb) mb.addEventListener('click',function(){
        if(!window.shellAPI||!window.shellAPI.triggerManualRewrite){ toast2('API 不可用'); return; }
        mb.disabled=true;
        var oldTxt=mb.textContent; mb.textContent='改写中…';
        window.shellAPI.triggerManualRewrite().then(function(r){
          mb.disabled=false; mb.textContent=oldTxt;
          if(r&&r.success){ toast2('已触发改写'); } else { toast2('改写失败：'+((r&&r.error)||'未知错误')); }
        })['catch'](function(){ mb.disabled=false; mb.textContent=oldTxt; toast2('改写异常'); });
      });
      var ib2=document.getElementById('sh-sec-inject');
      if(ib2) ib2.addEventListener('click',function(){ if(!window.shellAPI||!window.shellAPI.getCtfPrompt) return; window.shellAPI.getCtfPrompt().then(function(r){ if(!r||!r.success||!r.prompt){ toast2('CTF 提示词为空'); return; } var text='【CTF 沙箱上下文 — 请在本次对话中遵循以下规则】'+String.fromCharCode(10,10)+r.prompt+String.fromCharCode(10,10)+'【以上为本次对话的安全测试上下文，请据此继续】'; return window.shellAPI.insertToChat(text,'CTF注入'); }).then(function(r2){ if(r2&&r2.success) toast2('已注入当前对话'); })['catch'](function(){ toast2('注入失败'); }); });
    })['catch'](function(){});
  }


  function renderScheduleView(el){
    el.innerHTML = panel('定时任务',
      '<button class="sh-btn primary" id="sh-sc-new" style="margin-bottom:6px;">新建任务</button>'+
      '<div id="sh-sc-form" class="sh-card" style="display:none;margin-bottom:8px;">'+
        '<div id="sh-sc-ftitle" style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">新建任务</div>'+
        '<input id="sh-sc-name" placeholder="任务名" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<textarea id="sh-sc-prompt" placeholder="给 AI 的指令" rows="3" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;resize:vertical;"></textarea>'+
        '<div style="display:flex;gap:4px;margin-bottom:4px;"><select id="sh-sc-mode" style="flex:1;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;"><option value="daily">每天</option><option value="weekly">每周</option><option value="cron">自定义 cron</option></select></div>'+
        '<div id="sh-sc-time-row" style="display:flex;gap:4px;margin-bottom:4px;align-items:center;"><input id="sh-sc-hour" type="number" min="0" max="23" value="3" style="width:60px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;" /><span style="font-size:11px;color:var(--ck-text-dim);">时</span><input id="sh-sc-minute" type="number" min="0" max="59" value="0" style="width:60px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;" /><span style="font-size:11px;color:var(--ck-text-dim);">分</span><select id="sh-sc-weekday" style="display:none;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select></div>'+
        '<input id="sh-sc-cron" placeholder="分 时 日 月 周" style="display:none;width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<div id="sh-sc-cron-hint" style="font-size:11px;margin-bottom:4px;"></div>'+
        '<select id="sh-sc-window" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;"></select>'+
        '<input id="sh-sc-project" placeholder="项目目录（可选）" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<label style="font-size:11px;color:var(--ck-text-dim);display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="checkbox" id="sh-sc-enabled" checked /> 启用</label>'+
        '<div style="display:flex;gap:6px;"><button class="sh-btn primary" id="sh-sc-save">保存</button><button class="sh-btn" id="sh-sc-cancel" style="display:none;">取消</button></div>'+
      '</div>'+
      '<div id="sh-sc-body" class="sh-empty">加载中…</div>');
    var tasks=[], editingId=null;
    function ev(id){ return document.getElementById(id); }
    function modeVis(){ var mode=(ev('sh-sc-mode')||{}).value||'daily'; var tr=ev('sh-sc-time-row'); if(tr) tr.style.display=(mode==='cron')?'none':'flex'; var ci=ev('sh-sc-cron'); if(ci) ci.style.display=(mode==='cron')?'block':'none'; var wk=ev('sh-sc-weekday'); if(wk) wk.style.display=(mode==='weekly')?'block':'none'; }
    function collectCron(){ var mode=(ev('sh-sc-mode')||{}).value||'daily'; if(mode==='cron') return (ev('sh-sc-cron')||{}).value.trim(); var h=(ev('sh-sc-hour')||{}).value||'0'; var m=(ev('sh-sc-minute')||{}).value||'0'; if(mode==='weekly'){ var wd=(ev('sh-sc-weekday')||{}).value||'0'; return (Number(m)||0)+' '+(Number(h)||0)+' * * '+(Number(wd)||0); } return (Number(m)||0)+' '+(Number(h)||0)+' * * *'; }
    function resetForm(){ editingId=null; var t=ev('sh-sc-ftitle'); if(t) t.textContent='新建任务'; ['sh-sc-name','sh-sc-prompt','sh-sc-cron','sh-sc-project'].forEach(function(id){ var e=ev(id); if(e) e.value=''; }); var md=ev('sh-sc-mode'); if(md) md.value='daily'; var h=ev('sh-sc-hour'); if(h) h.value='3'; var mi=ev('sh-sc-minute'); if(mi) mi.value='0'; var en=ev('sh-sc-enabled'); if(en) en.checked=true; var cn=ev('sh-sc-cancel'); if(cn) cn.style.display='none'; modeVis(); }
    function loadWindows(){ if(!window.shellAPI||!window.shellAPI.listScheduleWindows) return; window.shellAPI.listScheduleWindows().then(function(r){ var sel=ev('sh-sc-window'); if(!sel) return; var wins=(r&&r.success&&r.windows)||[]; sel.innerHTML='<option value="">— 当前活跃窗口 —</option>'+wins.map(function(w){ return '<option value="'+esc(w.id)+'">'+esc(w.name)+(w.open?'':'（未打开）')+'</option>'; }).join(''); })['catch'](function(){}); }
    function draw(){ var box=ev('sh-sc-body'); if(!box) return; if(!tasks.length){ box.innerHTML='<div class="sh-empty">暂无定时任务</div>'; return; } var h=''; for(var i=0;i<tasks.length;i++){ var t=tasks[i]; h+='<div class="sh-list-item"><div style="display:flex;align-items:center;gap:6px;"><span style="font-weight:600;color:var(--ck-title);flex:1;">'+esc(t.name)+'</span><span style="font-size:10px;color:var(--ck-primary);">'+esc(t.cron)+'</span>'+(t.enabled?'':'<span style="font-size:10px;color:var(--ck-text-dim);">停用</span>')+'</div>'; h+='<div style="font-size:11px;color:var(--ck-text-dim);margin-top:4px;max-height:40px;overflow:hidden;">'+esc(t.prompt)+'</div>'; h+='<div style="display:flex;gap:10px;margin-top:6px;font-size:11px;"><span class="sh-sc-run" data-id="'+esc(t.id)+'" style="cursor:pointer;color:var(--ck-primary);">立即执行</span><span class="sh-sc-edit" data-id="'+esc(t.id)+'" style="cursor:pointer;color:var(--ck-text);">编辑</span><span class="sh-sc-toggle" data-id="'+esc(t.id)+'" style="cursor:pointer;color:var(--ck-text);">'+(t.enabled?'停用':'启用')+'</span><span class="sh-sc-del" data-id="'+esc(t.id)+'" style="cursor:pointer;color:#f87171;">删除</span></div></div>'; } box.innerHTML=h; var byId=function(id){ for(var k=0;k<tasks.length;k++) if(String(tasks[k].id)===String(id)) return tasks[k]; return null; }; var q=function(cls,fn){ var els=box.querySelectorAll(cls); for(var x=0;x<els.length;x++){ (function(e2){ e2.addEventListener('click',function(){ fn(byId(e2.getAttribute('data-id'))); }); })(els[x]); } }; q('.sh-sc-run',function(t){ if(!t) return; window.shellAPI.runScheduleNow(t.id).then(function(){ toast2('已触发'); })['catch'](function(){}); }); q('.sh-sc-toggle',function(t){ if(!t) return; window.shellAPI.updateSchedule(t.id,{enabled:!t.enabled}).then(function(){ load(); })['catch'](function(){}); }); q('.sh-sc-del',function(t){ if(!t) return; if(!confirm('确定删除「'+t.name+'」？')) return; window.shellAPI.deleteSchedule(t.id).then(function(){ toast2('已删除'); load(); })['catch'](function(){}); }); q('.sh-sc-edit',function(t){ if(!t) return; editingId=t.id; var ft=ev('sh-sc-ftitle'); if(ft) ft.textContent='编辑：'+t.name; if(ev('sh-sc-name')) ev('sh-sc-name').value=t.name; if(ev('sh-sc-prompt')) ev('sh-sc-prompt').value=t.prompt; if(ev('sh-sc-enabled')) ev('sh-sc-enabled').checked=!!t.enabled; if(ev('sh-sc-window')) ev('sh-sc-window').value=t.profileId||''; if(ev('sh-sc-project')) ev('sh-sc-project').value=t.projectDir||''; var parts=String(t.cron).split(/\s+/); if(parts.length===5&&parts[2]==='*'&&parts[3]==='*'){ if(ev('sh-sc-hour')) ev('sh-sc-hour').value=parts[1]; if(ev('sh-sc-minute')) ev('sh-sc-minute').value=parts[0]; if(parts[4]==='*'){ if(ev('sh-sc-mode')) ev('sh-sc-mode').value='daily'; } else { if(ev('sh-sc-mode')) ev('sh-sc-mode').value='weekly'; if(ev('sh-sc-weekday')) ev('sh-sc-weekday').value=parts[4]; } } else { if(ev('sh-sc-mode')) ev('sh-sc-mode').value='cron'; if(ev('sh-sc-cron')) ev('sh-sc-cron').value=t.cron; } var cn=ev('sh-sc-cancel'); if(cn) cn.style.display='inline-block'; var fm=ev('sh-sc-form'); if(fm) fm.style.display='block'; modeVis(); }); }
    function load(){ if(!window.shellAPI||!window.shellAPI.listSchedules) return; window.shellAPI.listSchedules().then(function(r){ tasks=(r&&r.success&&r.tasks)||[]; draw(); })['catch'](function(){}); }
    var nwb=ev('sh-sc-new'); if(nwb) nwb.addEventListener('click',function(){ resetForm(); var fm=ev('sh-sc-form'); if(fm) fm.style.display='block'; });
    var cb=ev('sh-sc-cancel'); if(cb) cb.addEventListener('click',function(){ resetForm(); var fm=ev('sh-sc-form'); if(fm) fm.style.display='none'; });
    var md2=ev('sh-sc-mode'); if(md2) md2.addEventListener('change',modeVis);
    var ci2=ev('sh-sc-cron'); if(ci2) ci2.addEventListener('input',function(){ var hint=ev('sh-sc-cron-hint'); if(!hint) return; var cr=collectCron(); if(!cr){ hint.textContent=''; return; } if(window.shellAPI&&window.shellAPI.validateScheduleCron) window.shellAPI.validateScheduleCron(cr).then(function(r){ hint.textContent=(r&&r.valid)?'✅ 有效':'❌ 无效'; hint.style.color=(r&&r.valid)?'#4ade80':'#f87171'; })['catch'](function(){}); });
    var svb=ev('sh-sc-save'); if(svb) svb.addEventListener('click',function(){ var name=((ev('sh-sc-name')||{}).value||'').trim(); var prompt=((ev('sh-sc-prompt')||{}).value||'').trim(); var cron=collectCron(); var enabled=!!((ev('sh-sc-enabled')||{}).checked); var profileId=(ev('sh-sc-window')||{}).value||''; var projectDir=((ev('sh-sc-project')||{}).value||'').trim(); if(!name){ toast2('请填任务名'); return; } if(!prompt){ toast2('请填指令'); return; } if(window.shellAPI&&window.shellAPI.validateScheduleCron){ window.shellAPI.validateScheduleCron(cron).then(function(v){ if(!v||!v.valid){ toast2('调度表达式无效'); return; } doSave(name,cron,prompt,enabled,profileId,projectDir); })['catch'](function(){ doSave(name,cron,prompt,enabled,profileId,projectDir); }); } else doSave(name,cron,prompt,enabled,profileId,projectDir); });
    function doSave(name,cron,prompt,enabled,profileId,projectDir){ var data={name:name,cron:cron,prompt:prompt,enabled:enabled,profileId:profileId,projectDir:projectDir}; var pr=editingId?window.shellAPI.updateSchedule(editingId,data):window.shellAPI.addSchedule(data); pr.then(function(r){ if(r&&r.success){ toast2(editingId?'已更新':'已创建'); resetForm(); var fm=ev('sh-sc-form'); if(fm) fm.style.display='none'; load(); } else toast2('保存失败：'+((r&&r.error)||'')); })['catch'](function(){ toast2('保存失败'); }); }
    loadWindows(); load();
  }


  function renderFeishuView(el){
    el.innerHTML = panel('飞书同步',
      '<div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:6px;">连接状态：<span id="sh-fs-status">—</span></div>'+
      '<div class="sh-card" style="margin-bottom:8px;">'+
        '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px;"><input type="checkbox" id="sh-fs-enabled" /> 启用飞书同步</label>'+
        '<div style="font-size:11px;color:var(--ck-text-dim);">App ID</div><input id="sh-fs-appid" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<div style="font-size:11px;color:var(--ck-text-dim);">App Secret</div><input id="sh-fs-secret" type="password" placeholder="留空不修改" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<div style="font-size:11px;color:var(--ck-text-dim);">目标 OpenID</div><input id="sh-fs-target" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;" />'+
        '<div style="font-size:11px;color:var(--ck-text-dim);margin-top:6px;">推送选项</div>'+
        '<label style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;"><input type="checkbox" id="sh-fs-push-user" /> 用户消息</label>'+
        '<label style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;"><input type="checkbox" id="sh-fs-push-ai" /> AI 回复</label>'+
        '<label style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;"><input type="checkbox" id="sh-fs-push-tool" /> 工具状态</label>'+
        '<label style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;"><input type="checkbox" id="sh-fs-push-toolname" /> 带上工具名</label>'+
        '<label style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;"><input type="checkbox" id="sh-fs-push-done" /> 完成标志</label>'+
        '<div style="font-size:11px;color:var(--ck-text-dim);margin-top:4px;">卡住超时(秒)</div><input id="sh-fs-stall" type="number" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;" />'+
      '</div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:4px;">群绑定</div><div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:4px;">当前：<span id="sh-fs-chat-cur">—</span></div><select id="sh-fs-chat" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:4px;"></select><button class="sh-btn" id="sh-fs-bind">绑定此群</button></div>'+
      '<div style="display:flex;gap:6px;margin-bottom:8px;"><button class="sh-btn primary" id="sh-fs-save">保存配置</button><button class="sh-btn" id="sh-fs-reconnect">重连</button><button class="sh-btn" id="sh-fs-disconnect">断开</button><button class="sh-btn" id="sh-fs-refresh">刷新群列表</button></div>');
    var ev=function(id){ return document.getElementById(id); };
    function setSt(status,detail){ var b=ev('sh-fs-status'); if(!b) return; var M={connected:['已连接','#4ade80'],connecting:['连接中…','#fbbf24'],error:['错误','#f87171'],disconnected:['未连接','#7c8798']}; var it=M[status]||M.disconnected; b.textContent=it[0]+(detail?('（'+detail+'）'):''); b.style.color=it[1]; }
    function loadFsConfig(){
      if(!window.shellAPI||!window.shellAPI.getFeishuConfig) return;
      window.shellAPI.getFeishuConfig().then(function(r){ if(!r||!r.success) return; var c=r.config||{};
        if(ev('sh-fs-appid')) ev('sh-fs-appid').value=c.appId||'';
        if(ev('sh-fs-secret')){ ev('sh-fs-secret').value=''; ev('sh-fs-secret').placeholder=c.hasSecret?'已配置（留空不修改）':'App Secret'; }
        if(ev('sh-fs-enabled')) ev('sh-fs-enabled').checked=!!c.enabled;
        if(ev('sh-fs-target')) ev('sh-fs-target').value=c.targetOpenId||'';
        function sc(id,v,d){ var e=ev(id); if(e) e.checked=(v===undefined?d:!!v); }
        sc('sh-fs-push-user',c.pushUserMessage,true); sc('sh-fs-push-ai',c.pushAiReply,true); sc('sh-fs-push-tool',c.pushToolStatus,true); sc('sh-fs-push-toolname',c.pushToolName,false); sc('sh-fs-push-done',c.pushTaskDone,true);
        if(ev('sh-fs-stall')) ev('sh-fs-stall').value=(typeof c.stallTimeoutSec==='number'?c.stallTimeoutSec:660);
        setSt(r.status,r.statusDetail);
      })['catch'](function(){});
    }
    function loadFsBinding(){
      if(!window.shellAPI||!window.shellAPI.getFeishuBinding) return;
      window.shellAPI.getFeishuBinding().then(function(b){ if(ev('sh-fs-chat-cur')) ev('sh-fs-chat-cur').textContent=(b&&b.chatName)?(b.chatName+'（已绑定）'):'未绑定'; })['catch'](function(){});
    }
    function loadFsChats(){
      if(!window.shellAPI||!window.shellAPI.listFeishuChats) return;
      var sel=ev('sh-fs-chat'); if(sel) sel.innerHTML='<option value="">加载群列表中…</option>';
      window.shellAPI.listFeishuChats().then(function(r){
        var sel2=ev('sh-fs-chat'); if(!sel2) return;
        if(!r || !r.success){ var msg=(r&&r.error)||'查询失败'; sel2.innerHTML='<option value="">（'+esc(msg)+'）</option>'; return; }
        var chats=r.chats||[];
        if(!chats.length){ sel2.innerHTML='<option value="">（机器人未加入任何群，请把应用加入目标群）</option>'; return; }
        sel2.innerHTML=chats.map(function(ch){ return '<option value="'+esc(ch.chatId||ch.id||'')+'">'+esc(ch.name||ch.chatId||'')+'</option>'; }).join('');
      })['catch'](function(){ var sel3=ev('sh-fs-chat'); if(sel3) sel3.innerHTML='<option value="">（群列表加载异常）</option>'; });
    }
    function loadFsAll(){ loadFsConfig(); loadFsBinding(); loadFsChats(); }
    loadFsAll();
    var sv=ev('sh-fs-save'); if(sv) sv.addEventListener('click',function(){ var _s=(ev('sh-fs-secret')||{}).value||''; var data={ enabled:!!((ev('sh-fs-enabled')||{}).checked), appId:(ev('sh-fs-appid')||{}).value||'', targetOpenId:(ev('sh-fs-target')||{}).value||'', pushUserMessage:!!((ev('sh-fs-push-user')||{}).checked), pushAiReply:!!((ev('sh-fs-push-ai')||{}).checked), pushToolStatus:!!((ev('sh-fs-push-tool')||{}).checked), pushToolName:!!((ev('sh-fs-push-toolname')||{}).checked), pushTaskDone:!!((ev('sh-fs-push-done')||{}).checked), stallTimeoutSec:Number((ev('sh-fs-stall')||{}).value)||660 }; if(_s && _s!=='••••••') data.appSecret=_s; if(window.shellAPI&&window.shellAPI.saveFeishuConfig) window.shellAPI.saveFeishuConfig(data).then(function(r){ toast2(r&&r.success?'已保存':'保存失败'); })['catch'](function(){ toast2('保存失败'); }); });
    var rc=ev('sh-fs-reconnect'); if(rc) rc.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.feishuReconnect) window.shellAPI.feishuReconnect().then(function(){ toast2('重连中'); })['catch'](function(){}); });
    var dc=ev('sh-fs-disconnect'); if(dc) dc.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.feishuDisconnect) window.shellAPI.feishuDisconnect().then(function(){ toast2('已断开'); })['catch'](function(){}); });
    var rf=ev('sh-fs-refresh'); if(rf) rf.addEventListener('click',function(){ loadFsAll(); toast2('已刷新'); });
    var bd=ev('sh-fs-bind'); if(bd) bd.addEventListener('click',function(){ var sel=ev('sh-fs-chat'); if(!sel||!sel.value){ toast2('请选择群'); return; } var nm=sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:''; if(window.shellAPI&&window.shellAPI.bindFeishuChat) window.shellAPI.bindFeishuChat(sel.value,nm).then(function(r){ toast2(r&&r.success?'已绑定':'绑定失败'); })['catch'](function(){}); });
  }

  // ---- 设置面板 ----

  function renderSettingsView(el){
    el.innerHTML = panel('设置', 
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">主题</div><button class="sh-btn" id="sh-set-theme">切换深色/浅色</button></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">Agent 模式</div><div id="sh-set-agent"><button class="sh-btn" data-agent="build">🔨 Build</button> <button class="sh-btn" data-agent="plan">📋 Plan</button></div></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">项目</div><button class="sh-btn" id="sh-set-init">初始化项目</button> <button class="sh-btn" id="sh-set-choose">选择目录</button> <button class="sh-btn" id="sh-set-gendoc">生成说明文档</button></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">窗口</div><button class="sh-btn" id="sh-set-newwin">新建窗口</button></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">对话</div><button class="sh-btn" id="sh-set-compact">压缩上下文</button> <button class="sh-btn" id="sh-set-export">导出对话(.md)</button> <button class="sh-btn" id="sh-set-immersive">沉浸式交流</button> <button class="sh-btn" id="sh-set-parse">手动解析</button> <button class="sh-btn" id="sh-set-stop">停止任务</button></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">悬浮元素</div><label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;"><input type="checkbox" id="sh-set-hidefloat" /> 隐藏悬浮球与覆盖层面板</label><label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;"><input type="checkbox" id="sh-set-hideplan" /> 隐藏计划悬浮卡</label></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">自动注入</div><label style="display:flex;gap:6px;align-items:center;font-size:12px;"><input type="checkbox" id="sh-set-autoinject" /> 新会话自动注入记忆与技能</label><label style="display:flex;gap:6px;align-items:center;font-size:12px;padding-top:4px;"><input type="checkbox" id="sh-set-autorename" /> 初始化项目后自动 AI 重命名</label></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">自动压缩</div><label style="display:flex;gap:6px;align-items:center;font-size:12px;"><input type="checkbox" id="sh-set-acen" /> 开启自动压缩</label><div style="display:flex;gap:4px;align-items:center;margin-top:4px;font-size:12px;"><span style="color:var(--ck-text-dim);">超过</span><input id="sh-set-acth" type="number" value="80" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">万 tokens</span><button class="sh-btn" id="sh-set-acsave">保存</button></div></div>'+
      '<div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">AI 回复后的发送延迟</div><div style="display:flex;gap:4px;align-items:center;font-size:12px;margin-bottom:4px;"><span style="color:var(--ck-text-dim);">判定阈值</span><input id="sh-set-dual-th" type="number" step="1000" min="0" value="20000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">ms（上一次 AI 回复耗时）</span></div><div style="display:flex;gap:4px;align-items:center;font-size:12px;margin-bottom:4px;"><span style="color:var(--ck-text-dim);">≤ 阈值 → 随机等</span><input id="sh-set-dual-delay-min" type="number" step="500" min="0" value="3000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">~</span><input id="sh-set-dual-delay-max" type="number" step="500" min="0" value="3000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">ms</span></div><div style="display:flex;gap:4px;align-items:center;font-size:12px;"><span style="color:var(--ck-text-dim);">> 阈值 → 等「耗时 ×</span><input id="sh-set-think-ratio" type="number" step="0.05" min="0" max="5" value="0.2" style="width:60px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">」，最多</span><input id="sh-set-think-max" type="number" step="1000" min="0" value="60000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">ms</span><button class="sh-btn" id="sh-set-think-save">保存</button></div></div>'+
      '');
    var ev=function(id){ return document.getElementById(id); };
    var tb=ev('sh-set-theme');
    (function(){ var ag=document.getElementById('sh-set-agent'); if(ag&&window.shellAPI&&window.shellAPI.listAgents){ var cur='build'; function hl(){ var bs=ag.querySelectorAll('button[data-agent]'); for(var x=0;x<bs.length;x++){ bs[x].style.background=(bs[x].getAttribute('data-agent')===cur)?'var(--ck-primary)':''; bs[x].style.color=(bs[x].getAttribute('data-agent')===cur)?'#fff':''; } } window.shellAPI.listAgents().then(function(r){ cur=(r&&r.current)||'build'; hl(); })['catch'](function(){}); var bs2=ag.querySelectorAll('button[data-agent]'); for(var y=0;y<bs2.length;y++){ (function(b){ b.addEventListener('click',function(){ var aid=b.getAttribute('data-agent'); if(window.shellAPI&&window.shellAPI.setAgent) window.shellAPI.setAgent(aid).then(function(r2){ if(r2&&r2.success){ cur=r2.agentId||aid; hl(); toast2('已切换到 '+cur+' 模式'); } })['catch'](function(){}); }); })(bs2[y]); } } })(); if(tb) tb.addEventListener('click',function(){ var cur=document.documentElement.classList.contains('lingya-theme-light')?'light':'dark'; applyTheme(cur==='light'?'dark':'light'); });
    var ib=ev('sh-set-init'); if(ib) ib.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.initProject) window.shellAPI.initProject().then(function(){ toast2('已触发初始化'); })['catch'](function(){}); });
    var cb=ev('sh-set-choose'); if(cb) cb.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.chooseDir) window.shellAPI.chooseDir().then(function(){ toast2('已选择'); })['catch'](function(){}); });
    var gd=ev('sh-set-gendoc'); if(gd) gd.addEventListener('click',function(){ act('gen-doc'); });
    var nb=ev('sh-set-newwin'); if(nb) nb.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.createProfileWindow) window.shellAPI.createProfileWindow().then(function(){ toast2('已新建'); })['catch'](function(){}); });
    function act(a){ if(window.shellAPI&&window.shellAPI.runAction) window.shellAPI.runAction(a).then(function(r){ toast2(r&&r.success?'已触发':'执行失败'); })['catch'](function(){ toast2('执行失败'); }); }
    var cp=ev('sh-set-compact'); if(cp) cp.addEventListener('click',function(){ act('compact'); });
    var ex=ev('sh-set-export'); if(ex) ex.addEventListener('click',function(){ act('export-md'); });
    var im=ev('sh-set-immersive'); if(im) im.addEventListener('click',function(){ act('immersive'); });
    var pa=ev('sh-set-parse'); if(pa) pa.addEventListener('click',function(){ act('manual-parse'); });
    var st=ev('sh-set-stop'); if(st) st.addEventListener('click',function(){ act('stop'); });
    var ai=ev('sh-set-autoinject'); if(ai) ai.addEventListener('change',function(){ try{ localStorage.setItem('sh-autoinject', ai.checked?'1':'0'); }catch(_e){} if(window.shellAPI&&window.shellAPI.setSetting) window.shellAPI.setSetting('auto-inject', ai.checked); });
    // 自动重命名开关（默认开启；只有显式设为 '0' 才关闭）
    (function(){
      var ar=ev('sh-set-autorename');
      if(!ar) return;
      try { ar.checked = localStorage.getItem('lingya-auto-rename-enabled') !== '0'; } catch(_e) { ar.checked = true; }
      ar.addEventListener('change', function(){
        try { localStorage.setItem('lingya-auto-rename-enabled', ar.checked ? '1' : '0'); } catch(_e) {}
        if(window.shellAPI&&window.shellAPI.setSetting) window.shellAPI.setSetting('auto-rename-enabled', ar.checked);
        toast2(ar.checked ? '已开启自动 AI 重命名' : '已关闭自动 AI 重命名');
      });
    })();
    function loadFloatCb(){ try{ var hf=localStorage.getItem('lingya-hide-floating')==='1'; var hp=localStorage.getItem('lingya-hide-plan-float')==='1'; var e1=ev('sh-set-hidefloat'); if(e1) e1.checked=hf; var e2=ev('sh-set-hideplan'); if(e2) e2.checked=hp; }catch(_e){} }
    loadFloatCb();
    (function loadSettingsCb(){ try{ var v; var e3=ev('sh-set-autoinject'); if(e3) e3.checked=(localStorage.getItem('sh-autoinject')==='1'); var e4=ev('sh-set-acen'); if(e4) e4.checked=(localStorage.getItem('sh-acen')==='1'); v=localStorage.getItem('sh-acth'); var e5=ev('sh-set-acth'); if(v&&e5) e5.value=v; v=localStorage.getItem('lingya-think-ratio'); var e6=ev('sh-set-think-ratio'); if(v&&e6) e6.value=v; v=localStorage.getItem('lingya-think-max-delay'); var e7=ev('sh-set-think-max'); if(v&&e7) e7.value=v; v=localStorage.getItem('lingya-adaptive-threshold'); var e8=ev('sh-set-dual-th'); if(v&&e8) e8.value=v; v=localStorage.getItem('lingya-global-send-delay-min'); var e9=ev('sh-set-dual-delay-min'); if(v&&e9) e9.value=v; v=localStorage.getItem('lingya-global-send-delay-max'); var e10=ev('sh-set-dual-delay-max'); if(v&&e10) e10.value=v; }catch(_e){} })();
    var hf=ev('sh-set-hidefloat'); if(hf) hf.addEventListener('change',function(){ try{localStorage.setItem('lingya-hide-floating', hf.checked?'1':'0');}catch(_e){} if(window.shellAPI&&window.shellAPI.setSetting) window.shellAPI.setSetting('hide-floating', hf.checked); toast2(hf.checked?'已隐藏悬浮元素':'已显示悬浮元素'); });
    var hp=ev('sh-set-hideplan'); if(hp) hp.addEventListener('change',function(){ try{localStorage.setItem('lingya-hide-plan-float', hp.checked?'1':'0');}catch(_e){} if(window.shellAPI&&window.shellAPI.setSetting) window.shellAPI.setSetting('hide-plan-float', hp.checked); toast2(hp.checked?'已隐藏计划卡':'已显示计划卡'); });
    var acs=ev('sh-set-acsave'); if(acs) acs.addEventListener('click',function(){ if(!window.shellAPI||!window.shellAPI.setSetting) return; var en=!!((ev('sh-set-acen')||{}).checked); var th=Number((ev('sh-set-acth')||{}).value)||80; try{ localStorage.setItem('sh-acen', en?'1':'0'); localStorage.setItem('sh-acth', String(th)); }catch(_e){} window.shellAPI.setSetting('auto-compact-enabled',en); window.shellAPI.setSetting('auto-compact-threshold',th); toast2('自动压缩已保存'); });
    var tss=ev('sh-set-think-save'); if(tss) tss.addEventListener('click',function(){
      var th=parseInt((ev('sh-set-dual-th')||{}).value,10);
      var glMin=parseInt((ev('sh-set-dual-delay-min')||{}).value,10);
      var glMax=parseInt((ev('sh-set-dual-delay-max')||{}).value,10);
      var ratio=parseFloat((ev('sh-set-think-ratio')||{}).value);
      var maxDelay=parseInt((ev('sh-set-think-max')||{}).value,10);
      if(!isFinite(th)||th<0||th>600000){ toast2('阈值需在 0 - 600000ms 之间'); return; }
      if(!isFinite(glMin)||glMin<0||glMin>600000){ toast2('延迟最小值需在 0 - 600000ms 之间'); return; }
      if(!isFinite(glMax)||glMax<0||glMax>600000){ toast2('延迟最大值需在 0 - 600000ms 之间'); return; }
      if(glMin>glMax){ toast2('延迟最小值不能大于最大值'); return; }
      if(!isFinite(ratio)||ratio<0||ratio>5){ toast2('比例需在 0 - 5 之间'); return; }
      if(!isFinite(maxDelay)||maxDelay<0||maxDelay>600000){ toast2('延迟上限需在 0 - 600000ms 之间'); return; }
      try{
        localStorage.setItem('lingya-adaptive-threshold',String(th));
        localStorage.setItem('lingya-global-send-delay-min',String(glMin));
        localStorage.setItem('lingya-global-send-delay-max',String(glMax));
        localStorage.setItem('lingya-think-ratio',String(ratio));
        localStorage.setItem('lingya-think-max-delay',String(maxDelay));
      }catch(_e){}
      if(window.shellAPI&&window.shellAPI.setSetting){
        window.shellAPI.setSetting('adaptive-threshold',th);
        window.shellAPI.setSetting('global-send-delay-min',glMin);
        window.shellAPI.setSetting('global-send-delay-max',glMax);
        window.shellAPI.setSetting('think-ratio',ratio);
        window.shellAPI.setSetting('think-max-delay',maxDelay);
      }
      toast2('已保存：≤' + th + 'ms 时在 ' + glMin + '~' + glMax + 'ms 内随机；超过则等「耗时×' + ratio + '」（最多 ' + maxDelay + 'ms）');
    });
  }

  // 绑定视图按钮 + 活动栏网格/拖拽
  (function(){
    var tabs=document.querySelectorAll('.sh-ab-item[data-view]');
    for(var i=0;i<tabs.length;i++){ (function(btn){ btn.addEventListener('click',function(){
      var v=btn.getAttribute('data-view');
      if(open && btn.classList.contains('active')) { setOpen(false); return; }
      if(!open){ setOpen(true); }
      switchView(v);
    }); })(tabs[i]); }
    var cbs=document.querySelectorAll('.sh-cols-btn');
    for(var k=0;k<cbs.length;k++){ (function(b){ b.addEventListener('click',function(){ abCols=parseInt(b.getAttribute('data-n'),10)||1; applyAbCols(); }); })(cbs[k]); }
    var abSetBtn=document.getElementById('sh-ab-settings');
    var abPopup=document.getElementById('sh-ab-popup');
    if(abSetBtn && abPopup){
      abSetBtn.addEventListener('click', function(e){ e.stopPropagation();
        // 若侧栏收起，先展开（否则窗口太窄，弹窗会超出右边界不可见）
        if(!open){ try{ setOpen(true); }catch(_e){} }
        abPopup.classList.toggle('sh-ab-popup-hidden');
        // 弹窗位置：优先活动栏右侧，超出窗口则 clamp 到窗口内
        var reposition = function(){
          try {
            var abw = abWidth();
            var popupW = abPopup.offsetWidth || 200;
            var winW = window.innerWidth;
            var left = abw + 10;
            if(left + popupW > winW - 8) left = Math.max(8, winW - popupW - 8);
            abPopup.style.left = left + 'px';
          } catch(_e){}
        };
        reposition();
        setTimeout(reposition, 260);
      });
      document.addEventListener('click', function(e){ if(!abPopup.classList.contains('sh-ab-popup-hidden') && !abPopup.contains(e.target) && e.target!==abSetBtn){ abPopup.classList.add('sh-ab-popup-hidden'); } });
    }
    applyAbOrder();
    setupAbDrag();
    applyAbCols();
    var savedV='files'; try{ savedV=localStorage.getItem('lingya-shell-view')||'files'; }catch(_){}
    switchView(savedV);
  })();


  // ===== v2 面板（会话/日志/MCP/窗口）=====

  function renderSessionsView(el){
    el.innerHTML = panel('会话列表',
      '<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;"><button class="sh-btn" id="sh-ss-refresh">刷新</button><button class="sh-btn" id="sh-ss-init">初始化项目</button><button class="sh-btn" id="sh-ss-ai-rename" title="让 AI 回顾完整上下文后重新命名当前对话">AI 重命名</button></div>'+
      '<div id="sh-ss-body" class="sh-empty">加载中…</div>');
    function load(){
      if(!window.shellAPI||!window.shellAPI.listSessions) return;
      window.shellAPI.listSessions().then(function(r){
        var box=document.getElementById('sh-ss-body'); if(!box) return;
        var list=(r&&r.success&&r.sessions)||[];
        if(!list.length){ box.innerHTML='<div class="sh-empty">暂无会话（先选择项目目录）</div>'; return; }
        // 分组：未归档 / 已归档
        var active=[], archived=[];
        for(var z=0;z<list.length;z++){
          var zz=list[z];
          if(typeof zz==='object' && zz.archivedAt) archived.push(zz); else active.push(zz);
        }
        function renderOne(it, isArch){
          var sid=String(typeof it==='string'?it:(it.sessionId||''));
          var title=typeof it==='object'?(it.title||''):'';
          var shortId=sid.length>14?(sid.slice(0,14)+'…'):sid;
          var main=title?(esc(title)+' <span style="color:var(--ck-text-dim);font-size:10px;">('+esc(shortId)+')</span>'):esc(shortId);
          var archBtn = isArch
            ? '<span class="sh-ss-unarchive" title="取消归档" style="font-size:11px;color:var(--ck-primary);cursor:pointer;">取消归档</span>'
            : '<span class="sh-ss-archive" title="归档（从列表隐藏）" style="font-size:11px;color:var(--ck-text-dim);cursor:pointer;">归档</span>';
          var op = isArch ? '0.62' : '1';
          return '<div class="sh-list-item sh-ss-item" data-id="'+esc(sid)+'" data-title="'+esc(title)+'" data-arch="'+(isArch?'1':'0')+'" style="cursor:pointer;display:flex;align-items:center;gap:6px;opacity:'+op+';"><span style="flex:1;font-size:11px;color:var(--ck-text);overflow:hidden;text-overflow:ellipsis;">'+main+'</span><span class="sh-ss-rename" title="重命名" style="font-size:11px;color:var(--ck-text-dim);cursor:pointer;">改名</span>'+archBtn+'<span class="sh-ss-nav" style="font-size:11px;color:var(--ck-primary);">跳转</span></div>';
        }
        var h='';
        if(!active.length) h+='<div class="sh-empty" style="padding:6px 0;">暂无进行中的会话</div>';
        else for(var i=0;i<active.length;i++) h+=renderOne(active[i], false);
        if(archived.length){
          var KEY='lingya-shell-archived-open';
          var opened=false; try{ opened=(localStorage.getItem(KEY)==='1'); }catch(_e){}
          h+='<div class="sh-ss-archhead" data-open="'+(opened?'1':'0')+'" style="display:flex;align-items:center;gap:6px;padding:6px 4px;margin-top:6px;font-size:11.5px;color:var(--ck-text-dim);cursor:pointer;border-radius:6px;background:rgba(255,255,255,0.03);"><span class="sh-ss-archcaret">'+(opened?'▾':'▸')+'</span><span>📦 已归档 ('+archived.length+')</span></div>';
          h+='<div class="sh-ss-archlist" style="display:'+(opened?'flex':'none')+';flex-direction:column;gap:4px;margin-top:4px;">';
          for(var m=0;m<archived.length;m++) h+=renderOne(archived[m], true);
          h+='</div>';
        }
        box.innerHTML=h;
        var items=box.querySelectorAll('.sh-ss-item');
        for(var j=0;j<items.length;j++){ (function(el){ el.addEventListener('click',function(){
          if(!window.shellAPI.navigateSession) return;
          window.shellAPI.navigateSession(el.getAttribute('data-id')).then(function(r2){ if(r2&&r2.success) toast2('已跳转'); else toast2('跳转失败'); })['catch'](function(){});
        }); })(items[j]); }
        // 改名按钮
        var renames=box.querySelectorAll('.sh-ss-rename');
        for(var k=0;k<renames.length;k++){ (function(btn){ btn.addEventListener('click',function(ev){
          ev.stopPropagation();
          var item=btn.closest('.sh-ss-item'); if(!item) return;
          var sid=item.getAttribute('data-id'); if(!sid) return;
          var cur=item.getAttribute('data-title')||'';
          var nn=prompt('重命名对话',cur); if(nn==null) return;
          nn=String(nn).trim(); if(!nn) return;
          if(!window.shellAPI.setSessionTitle){ toast2('接口不可用'); return; }
          window.shellAPI.setSessionTitle(nn,sid).then(function(r3){
            if(r3&&r3.success){ toast2('已改名'); load(); } else toast2('改名失败');
          })['catch'](function(){ toast2('改名失败'); });
        }); })(renames[k]); }
        // 归档按钮
        var archs=box.querySelectorAll('.sh-ss-archive');
        for(var a1=0;a1<archs.length;a1++){ (function(btn){ btn.addEventListener('click',function(ev){
          ev.stopPropagation();
          var item=btn.closest('.sh-ss-item'); if(!item) return;
          var sid=item.getAttribute('data-id'); if(!sid) return;
          if(!window.shellAPI.setSessionArchived){ toast2('接口不可用'); return; }
          window.shellAPI.setSessionArchived(sid, true).then(function(rr){
            if(rr&&rr.success){ toast2('已归档'); load(); } else toast2('归档失败');
          })['catch'](function(){ toast2('归档失败'); });
        }); })(archs[a1]); }
        // 取消归档按钮
        var unarchs=box.querySelectorAll('.sh-ss-unarchive');
        for(var a2=0;a2<unarchs.length;a2++){ (function(btn){ btn.addEventListener('click',function(ev){
          ev.stopPropagation();
          var item=btn.closest('.sh-ss-item'); if(!item) return;
          var sid=item.getAttribute('data-id'); if(!sid) return;
          if(!window.shellAPI.setSessionArchived){ toast2('接口不可用'); return; }
          window.shellAPI.setSessionArchived(sid, false).then(function(rr){
            if(rr&&rr.success){ toast2('已取消归档'); load(); } else toast2('操作失败');
          })['catch'](function(){ toast2('操作失败'); });
        }); })(unarchs[a2]); }
        // 折叠头
        var ach=box.querySelector('.sh-ss-archhead');
        var acl=box.querySelector('.sh-ss-archlist');
        if(ach && acl){
          ach.addEventListener('click', function(ev){
            ev.stopPropagation();
            var nowOpen = acl.style.display === 'none';
            acl.style.display = nowOpen ? 'flex' : 'none';
            var caret = ach.querySelector('.sh-ss-archcaret');
            if(caret) caret.textContent = nowOpen ? '▾' : '▸';
            try { localStorage.setItem('lingya-shell-archived-open', nowOpen ? '1' : '0'); } catch(_e){}
          });
        }
      })['catch'](function(){});
    }
    var rf=document.getElementById('sh-ss-refresh'); if(rf) rf.addEventListener('click',load);
    var airen=document.getElementById('sh-ss-ai-rename');
    if(airen) airen.addEventListener('click',function(){
      if(!window.shellAPI||!window.shellAPI.runAction){ toast2('接口不可用'); return; }
      window.shellAPI.runAction('ai-rename').then(function(r){ toast2(r&&r.success?'已请求 AI 重新命名':'失败'); })['catch'](function(){ toast2('失败'); });
    });
    var ini=document.getElementById('sh-ss-init'); if(ini) ini.addEventListener('click',function(){ if(window.shellAPI&&window.shellAPI.initProject) window.shellAPI.initProject().then(function(){ toast2('已触发初始化'); })['catch'](function(){}); });
    load();
  }

  function renderLogView(el){
    el.innerHTML = panel('执行日志',
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">'+
      '<button class="sh-btn" id="sh-lg-clear">清空历史</button>'+
      '<button class="sh-btn" id="sh-lg-parse">手动解析</button>'+
      '<button class="sh-btn" id="sh-lg-stop">停止任务</button>'+
      '<button class="sh-btn" id="sh-lg-export">导出对话</button>'+
      '</div>'+
      '<div id="sh-lg-list" class="sh-empty" style="margin-bottom:8px;">暂无执行记录（AI 执行工具后显示）</div>'+
      '<div class="sh-card"><div style="font-size:12px;font-weight:600;color:var(--ck-title);margin-bottom:6px;">说明</div>'+
      '<div style="font-size:11px;color:var(--ck-text-dim);line-height:1.6;">命令历史、执行结果、工具调用卡片实时显示在主界面（AI 网页右侧的覆盖层「日志」页签）。此面板提供常用操作入口：清空历史、手动解析、停止任务、导出对话。</div></div>');
    var ev=function(id){ return document.getElementById(id); };
    function act(a){ if(window.shellAPI&&window.shellAPI.runAction) window.shellAPI.runAction(a).then(function(r){ toast2(r&&r.success?'已触发':'失败'); })['catch'](function(){ toast2('失败'); }); }
    var c1=ev('sh-lg-clear'); if(c1) c1.addEventListener('click',function(){ act('clear-history'); });
    var p1=ev('sh-lg-parse'); if(p1) p1.addEventListener('click',function(){ act('manual-parse'); });
    var s1=ev('sh-lg-stop'); if(s1) s1.addEventListener('click',function(){ act('stop'); });
    var e1=ev('sh-lg-export'); if(e1) e1.addEventListener('click',function(){ act('export-md'); });
    var hist=[];
    function drawHist(){ var box=document.getElementById('sh-lg-list'); if(!box) return; if(!hist.length){ box.innerHTML='暂无执行记录'; return; } var h=''; for(var i=0;i<Math.min(hist.length,30);i++){ var en=hist[i]||{}; var ok=en.success; h+='<div class="sh-list-item" style="display:flex;gap:6px;align-items:center;"><span style="color:'+(ok?'#4ade80':'#f87171')+';flex-shrink:0;">'+(ok?'✔':'✖')+'</span><span style="flex:1;font-size:11px;color:var(--ck-text);overflow:hidden;text-overflow:ellipsis;">'+esc(en.command||'')+'</span></div>'; } box.innerHTML=h; }
    if(window.shellAPI&&window.shellAPI.onHistoryUpdated){ window.shellAPI.onHistoryUpdated(function(p){ if(p&&p.entry){ hist.unshift(p.entry); if(hist.length>50) hist.pop(); drawHist(); } }); }
    var hs=ev('sh-lg-stop');
  }


  function renderMcpView(el){
    el.innerHTML = panel('MCP 工具',
      '<div style="display:flex;gap:4px;margin-bottom:6px;"><button class="sh-btn" id="sh-mcp-refresh">刷新</button></div>'+
      '<div id="sh-mcp-list" class="sh-empty" style="margin-bottom:8px;">加载中…</div>'+
      '<div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:4px;">配置（mcpServers JSON）</div>'+
      '<textarea id="sh-mcp-json" rows="8" placeholder=\'{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/proj"]}}}\' style="width:100%;box-sizing:border-box;background:var(--ck-code-bg);border:1px solid var(--ck-border);border-radius:6px;padding:6px;color:var(--ck-text);font-size:11px;font-family:Consolas,monospace;resize:vertical;margin-bottom:6px;"></textarea>'+
      '<button class="sh-btn primary" id="sh-mcp-save">保存配置</button>');
    function loadJson(){
      if(!window.shellAPI||!window.shellAPI.listMcpServers) return;
      window.shellAPI.listMcpServers().then(function(r){
        var servers=(r&&r.success&&r.servers)||[];
        var ms={};
        for(var i=0;i<servers.length;i++){ var s=servers[i]; var def={};
          if(s.type==='http'){ if(s.url) def.url=s.url; if(s.headers) def.headers=s.headers; }
          else { if(s.command) def.command=s.command; if(s.args&&s.args.length) def.args=s.args; if(s.env) def.env=s.env; }
          ms[s.name]=def;
        }
        var ta=document.getElementById('sh-mcp-json'); if(ta) ta.value=JSON.stringify({mcpServers:ms},null,2);
      })['catch'](function(){});
    }
    function draw(){
      if(!window.shellAPI||!window.shellAPI.listMcpServers) return;
      window.shellAPI.listMcpServers().then(function(r){
        var box=document.getElementById('sh-mcp-list'); if(!box) return;
        var servers=(r&&r.success&&r.servers)||[];
        if(!servers.length){ box.innerHTML='<div class="sh-empty">暂无 MCP Server</div>'; return; }
        var h='';
        for(var i=0;i<servers.length;i++){ var s=servers[i]; var st=s.connected?'已连接':(s.enabled?'未连接':'已禁用'); var col=s.connected?'#4ade80':(s.enabled?'#ffc107':'#5d6280');
          h+='<div class="sh-list-item sh-mcp-item" data-name="'+esc(s.name)+'" style="cursor:pointer;display:flex;align-items:center;gap:6px;"><span style="flex:1;font-size:12px;color:var(--ck-text);">'+esc(s.name)+'</span><span style="width:8px;height:8px;border-radius:50%;background:'+col+';flex-shrink:0;"></span><span style="font-size:10px;color:var(--ck-text-dim);">'+st+'</span></div>';
        }
        box.innerHTML=h;
        var items=box.querySelectorAll('.sh-mcp-item');
        for(var j=0;j<items.length;j++){ (function(it){ it.addEventListener('click',function(){
          var nm=it.getAttribute('data-name'); var srv=null; for(var k=0;k<servers.length;k++) if(servers[k].name===nm) srv=servers[k];
          if(!srv) return;
          var pr=(srv.connected||srv.enabled)?window.shellAPI.disableMcpServer(nm):window.shellAPI.enableMcpServer(nm);
          pr.then(function(){ draw(); loadJson(); })['catch'](function(){});
        }); })(items[j]); }
      })['catch'](function(){});
    }
    var rf=document.getElementById('sh-mcp-refresh'); if(rf) rf.addEventListener('click',function(){ draw(); loadJson(); });
    var sv=document.getElementById('sh-mcp-save'); if(sv) sv.addEventListener('click',function(){
      var ta=document.getElementById('sh-mcp-json'); if(!ta||!ta.value.trim()){ toast2('请输入配置'); return; }
      var parsed; try{ parsed=JSON.parse(ta.value); }catch(e){ toast2('JSON 解析失败'); return; }
      if(!parsed.mcpServers||typeof parsed.mcpServers!=='object'){ toast2('需要 mcpServers 对象'); return; }
      window.shellAPI.listMcpServers().then(function(r){
        var old=(r&&r.success&&r.servers)||[];
        var newNames=Object.keys(parsed.mcpServers);
        var chain=Promise.resolve();
        for(var i=0;i<old.length;i++){ if(newNames.indexOf(old[i].name)<0){ (function(nm){ chain=chain.then(function(){ return window.shellAPI.removeMcpServer(nm); }); })(old[i].name); } }
        newNames.forEach(function(name){ var def=parsed.mcpServers[name]||{}; var server={ name:name, type:def.url?'http':'stdio', command:def.command, args:def.args||[], url:def.url, headers:def.headers, env:def.env }; chain=chain.then(function(){ return window.shellAPI.upsertMcpServer(server); }); });
        chain.then(function(){ toast2('配置已保存'); draw(); loadJson(); })['catch'](function(){ toast2('保存失败'); });
      })['catch'](function(){ toast2('保存失败'); });
    });
    draw(); loadJson();
  }


  function renderWindowsView(el){
    el.innerHTML = panel('窗口管理',
      '<button class="sh-btn primary" id="sh-win-new" style="margin-bottom:6px;">新建窗口</button>'+
      '<div id="sh-win-body" class="sh-empty">加载中…</div>');
    function load(){
      if(!window.shellAPI||!window.shellAPI.listProfiles) return;
      window.shellAPI.listProfiles().then(function(r){
        var box=document.getElementById('sh-win-body'); if(!box) return;
        var list=(r&&r.success&&r.profiles)||[];
        if(!list.length){ box.innerHTML='<div class="sh-empty">暂无窗口</div>'; return; }
        var h='';
        for(var i=0;i<list.length;i++){ var w=list[i];
          h+='<div class="sh-list-item"><div style="display:flex;align-items:center;gap:6px;"><span class="sh-win-open" data-id="'+esc(w.id)+'" style="font-weight:600;color:var(--ck-title);flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">'+esc(w.name)+'</span>';
          h+='<span style="font-size:10px;color:var(--ck-text-dim);">'+esc(w.providerId||'平台')+'</span>';
          h+='<span class="sh-win-rename" data-id="'+esc(w.id)+'" data-name="'+esc(w.name)+'" style="cursor:pointer;font-size:11px;color:var(--ck-text);">改名</span>';
          h+='<span class="sh-win-del" data-id="'+esc(w.id)+'" data-name="'+esc(w.name)+'" style="cursor:pointer;font-size:11px;color:#f87171;">删除</span></div></div>';
        }
        box.innerHTML=h;
        var q=function(cls,fn){ var els=box.querySelectorAll(cls); for(var x=0;x<els.length;x++){ (function(e2){ e2.addEventListener('click',function(){ fn(e2.getAttribute('data-id'),e2.getAttribute('data-name')); }); })(els[x]); } };
        q('.sh-win-open',function(id){ window.shellAPI.openProfileWindow(id).then(function(r2){ toast2(r2&&r2.success?(r2.focused?'已切换':'已打开'):'打开失败'); })['catch'](function(){}); });
        q('.sh-win-rename',function(id,name){ var nn=prompt('新名称',name); if(nn==null) return; window.shellAPI.updateWindowName(nn).then(function(){ toast2('已改名'); load(); })['catch'](function(){}); });
        q('.sh-win-del',function(id,name){ if(!confirm('确定删除窗口「'+name+'」？')) return; window.shellAPI.deleteProfileWindow(id).then(function(){ toast2('已删除'); load(); })['catch'](function(){}); });
      })['catch'](function(){});
    }
    var nb=document.getElementById('sh-win-new'); if(nb) nb.addEventListener('click',function(){ window.shellAPI.createProfileWindow().then(function(){ toast2('已新建'); load(); })['catch'](function(){}); });
    load();
  }

  // 会话标题更新 → 若正停在会话面板则刷新（AI 命名对话后实时更新列表）
  if (window.shellAPI && window.shellAPI.onSessionTitleUpdated) {
    try { window.shellAPI.onSessionTitleUpdated(function(){ try { if(rendered['sessions']){ rendered['sessions']=false; renderView('sessions'); } } catch(_){} }); } catch(_){}
  if (window.shellAPI && window.shellAPI.onSessionArchivedUpdated) {
    try { window.shellAPI.onSessionArchivedUpdated(function(){ try { if(rendered['sessions']){ rendered['sessions']=false; renderView('sessions'); } } catch(_){} }); } catch(_){}
  }
  }

  // ===== 插件视图挂载（阶段2）=====
  // 启动时挂一次；插件启停/重载后由 lingya-tools-changed 事件触发刷新
  try { mountPluginViews(); } catch(_e){}
  if(window.shellAPI && window.shellAPI.onPluginsChanged){
    try { window.shellAPI.onPluginsChanged(function(){ try { mountPluginViews(); } catch(_){} }); } catch(_e){}
  }

  // ===== 顶部标签栏 + 地址栏 =====
  (function initTabbar() {
    // 横向标签列表已改为下拉列表，这里不再获取 tabsEl（保留变量仅为安全防护）
    var tabsEl = document.getElementById('lingya-tabs');
    var newBtn = document.getElementById('lingya-tab-new');
    var urlInput = document.getElementById('lingya-url-input');
    var backBtn = document.getElementById('lingya-url-back');
    var fwdBtn = document.getElementById('lingya-url-forward');
    var reloadBtn = document.getElementById('lingya-url-reload');
    if (!tabsEl || !window.shellAPI) return;

    var lastTabs = [];
    var lastActive = null;

    function renderTabs(payload) {
      var tabs = (payload && payload.tabs) || [];
      var activeId = payload && payload.activeTabId;
      lastTabs = tabs;
      lastActive = activeId;
      var h = '';
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var cls = 'ly-tab' + (t.active ? ' active' : '') + (t.isMain ? ' main' : '');
        h += '<div class="' + cls + '" data-tab-id="' + attr(t.id) + '" title="' + attr(t.url || '') + '">'
          + '<span class="ly-tab-title">' + esc(t.title || '新标签') + '</span>'
          + '<span class="ly-tab-close" data-close-id="' + attr(t.id) + '" title="关闭">×</span>'
          + '</div>';
      }
      // ===== 更新标签数量徽章（不含主标签）=====
      try {
        var cntEl = document.getElementById('lingya-tabs-count');
        if (cntEl) {
          var otherCount = 0;
          for (var ci = 0; ci < tabs.length; ci++) { if (!tabs[ci].isMain) otherCount++; }
          cntEl.textContent = String(otherCount);
          cntEl.classList.toggle('empty', otherCount === 0);
        }
      } catch (_) {}

      // ===== 顶部横向：只渲染主标签（LingYa 对话）=====
      if (tabsEl) {
        var mainTab = null;
        for (var mi = 0; mi < tabs.length; mi++) {
          if (tabs[mi].isMain) { mainTab = tabs[mi]; break; }
        }
        if (mainTab) {
          tabsEl.innerHTML = '<div class="ly-tab main" data-tab-id="' + attr(mainTab.id) + '" title="' + attr(mainTab.url || '') + '">'
            + '<span class="ly-tab-ico">💬</span>'
            + '<span class="ly-tab-title">' + esc(mainTab.title || 'LingYa') + '</span>'
            + '</div>';
          var mel = tabsEl.querySelector('.ly-tab.main');
          if (mel) {
            mel.addEventListener('click', function(){
              if (mainTab.id && mainTab.id !== lastActive) {
                window.shellAPI.tabSwitch(mainTab.id)['catch'](function(){});
              }
            });
          }
          tabsEl.style.display = 'flex';
        } else {
          tabsEl.innerHTML = '';
        }
      }

      // 同步地址栏
      var activeTab = null;
      for (var k = 0; k < tabs.length; k++) if (tabs[k].active) { activeTab = tabs[k]; break; }
      if (activeTab && document.activeElement !== urlInput) {
        urlInput.value = activeTab.url || '';
      }

      // 标签列表下拉开着时实时刷新
      try {
        var _dd = document.getElementById('lingya-tabs-dropdown');
        if (_dd && _dd.style.display !== 'none' && typeof window.__lyRenderTabsDropdown === 'function') {
          window.__lyRenderTabsDropdown();
        }
      } catch (_) {}
    }

    // 初始加载 + 订阅变更
    window.shellAPI.tabList().then(function(r){
      if (r && r.success) renderTabs({ tabs: r.tabs, activeTabId: r.activeTabId });
    })['catch'](function(){});
    try {
      window.shellAPI.onTabsUpdated(function(payload){ renderTabs(payload); });
    } catch (_) {}

    // 新建标签
    if (newBtn) newBtn.addEventListener('click', function(){
      window.shellAPI.tabNew('about:blank').then(function(r){
        if (r && !r.success) toast2(r.error || '新建失败');
        else if (urlInput) urlInput.focus();
      })['catch'](function(){});
    });

    // 地址栏回车导航
    if (urlInput) {
      urlInput.addEventListener('keydown', function(ev){
        if (ev.key !== 'Enter') return;
        var u = String(urlInput.value || '').trim();
        if (!u) return;
        window.shellAPI.tabNavigate(u).then(function(r){
          if (r && !r.success) toast2(r.error || '导航失败');
        })['catch'](function(){});
      });
      urlInput.addEventListener('focus', function(){ urlInput.select(); });
    }

    if (backBtn) backBtn.addEventListener('click', function(){ window.shellAPI.tabBack()['catch'](function(){}); });
    if (fwdBtn) fwdBtn.addEventListener('click', function(){ window.shellAPI.tabForward()['catch'](function(){}); });
    if (reloadBtn) reloadBtn.addEventListener('click', function(){ window.shellAPI.tabReload()['catch'](function(){}); });

    // ===== 标签列表下拉 =====
    var tabsMenuBtn = document.getElementById('lingya-tabs-menu');
    var tabsDd = document.getElementById('lingya-tabs-dropdown');
    var tabsDdBody = document.getElementById('lingya-tabs-dd-body');
    var tabsDdCount = document.getElementById('lingya-tabs-count');
    var tabsDdClose = document.getElementById('lingya-tabs-dd-close');
    var bmBtn = document.getElementById('lingya-bookmark-btn');
    var bmDd = document.getElementById('lingya-bookmarks-dropdown');
    var bmDdBody = document.getElementById('lingya-bm-dd-body');
    var bmDdClose = document.getElementById('lingya-bm-dd-close');
    var bmAddUrl = document.getElementById('lingya-bm-add-url');
    var bmAddName = document.getElementById('lingya-bm-add-name');
    var bmAddBtn = document.getElementById('lingya-bm-add-btn');

    function closeAllDropdowns() {
      if (tabsDd) tabsDd.style.display = 'none';
      if (bmDd) bmDd.style.display = 'none';
      if (tabsMenuBtn) tabsMenuBtn.classList.remove('active');
      if (bmBtn) bmBtn.classList.remove('active');
    }

    // 点击面板外部关闭
    document.addEventListener('mousedown', function(ev){
      if (!tabsDd || !bmDd) return;
      var inTabs = tabsDd.contains(ev.target) || (tabsMenuBtn && tabsMenuBtn.contains(ev.target));
      var inBm = bmDd.contains(ev.target) || (bmBtn && bmBtn.contains(ev.target));
      if (!inTabs && !inBm) closeAllDropdowns();
    });

    function renderTabsDropdown() {
      if (!tabsDdBody) return;
      // 下拉只列其他网站的标签（主标签 LingYa 对话固定在顶部横向）
      var allTabs = lastTabs || [];
      var tabs = [];
      for (var ai = 0; ai < allTabs.length; ai++) {
        if (!allTabs[ai].isMain) tabs.push(allTabs[ai]);
      }
      if (tabsDdCount) tabsDdCount.textContent = String(tabs.length);
      if (!tabs.length) {
        tabsDdBody.innerHTML = '<div class="ly-dd-empty">暂无其他标签<br/><span style="font-size:10px;opacity:.7;">点 + 新建或让 AI 打开网址</span></div>';
        return;
      }
      var h = '';
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var cls = 'ly-dd-item' + (t.active ? ' active' : '');
        h += '<div class="' + cls + '" data-tab-id="' + attr(t.id) + '">'
          + '<span class="ly-dd-item-icon">🌐</span>'
          + '<span class="ly-dd-item-main">'
          +   '<span class="ly-dd-item-title">' + esc(t.title || '新标签') + '</span>'
          +   '<span class="ly-dd-item-url">' + esc(t.url || 'about:blank') + '</span>'
          + '</span>'
          + '<span class="ly-dd-item-act" data-close-id="' + attr(t.id) + '" title="关闭标签">×</span>'
          + '</div>';
      }
      tabsDdBody.innerHTML = h;
      var items = tabsDdBody.querySelectorAll('.ly-dd-item');
      for (var j = 0; j < items.length; j++) {
        (function(el){
          el.addEventListener('click', function(ev){
            var closeEl = ev.target.closest('.ly-dd-item-act');
            if (closeEl) {
              ev.stopPropagation();
              var cid = closeEl.getAttribute('data-close-id');
              window.shellAPI.tabClose(cid)['catch'](function(){});
              return;
            }
            var id = el.getAttribute('data-tab-id');
            if (id) {
              window.shellAPI.tabSwitch(id).then(function(){
                closeAllDropdowns();
              })['catch'](function(){});
            }
          });
        })(items[j]);
      }
    }

    /** 把下拉面板定位到按钮正下方（垂直展开，左边缘与按钮对齐） */
    function positionDropdown(panel, btn) {
      if (!panel || !btn) return;
      var rect = btn.getBoundingClientRect();
      panel.style.top = (rect.bottom + 4) + 'px';
      // 左边缘对齐按钮；若右侧超出视口，则贴右边
      var maxLeft = window.innerWidth - panel.offsetWidth - 8;
      var left = Math.min(Math.max(8, rect.left), Math.max(8, maxLeft));
      panel.style.left = left + 'px';
    }

    /** 取按钮的屏幕坐标（主进程用它定位独立下拉窗口） */
    function screenRect(btn) {
      var r = btn.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    /** 当前主题（供下拉窗口跟随） */
    function currentTheme() {
      try { return document.documentElement.classList.contains('lingya-theme-light') ? 'light' : 'dark'; } catch (_) { return 'dark'; }
    }

    if (tabsMenuBtn && window.shellAPI && window.shellAPI.openDropdown) {
      tabsMenuBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        closeAllDropdowns();
        window.shellAPI.openDropdown({
          type: 'tabs',
          anchor: screenRect(tabsMenuBtn),
          theme: currentTheme(),
        }).then(function(r){
          if (r && !r.success) toast2(r.error || '打开标签列表失败');
        })['catch'](function(){});
      });
    }

    // ===== 收藏夹 =====
    var BM_KEY = 'lingya-bookmarks';
    function readBookmarks() {
      try {
        var raw = localStorage.getItem(BM_KEY);
        if (!raw) return [];
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (_) { return []; }
    }
    function writeBookmarks(list) {
      try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch (_) {}
    }
    function normalizeUrl(u) {
      var s = String(u || '').trim();
      if (!s) return '';
      if (/^[a-z]+:\/\//i.test(s)) return s;
      return 'https://' + s;
    }
    function domainOf(u) {
      try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; }
    }

    function renderBookmarksDropdown() {
      if (!bmDdBody) return;
      var list = readBookmarks();
      if (!list.length) {
        bmDdBody.innerHTML = '<div class="ly-dd-empty">暂无收藏<br/>在上方输入网址点「添加」</div>';
        return;
      }
      var h = '';
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        h += '<div class="ly-dd-item" data-url="' + attr(b.url) + '">'
          + '<span class="ly-dd-item-icon">★</span>'
          + '<span class="ly-dd-item-main">'
          +   '<span class="ly-dd-item-title">' + esc(b.title || domainOf(b.url)) + '</span>'
          +   '<span class="ly-dd-item-url">' + esc(b.url) + '</span>'
          + '</span>'
          + '<span class="ly-dd-item-act" data-del-url="' + attr(b.url) + '" title="删除收藏">×</span>'
          + '</div>';
      }
      bmDdBody.innerHTML = h;
      var items = bmDdBody.querySelectorAll('.ly-dd-item');
      for (var j = 0; j < items.length; j++) {
        (function(el){
          el.addEventListener('click', function(ev){
            var delEl = ev.target.closest('.ly-dd-item-act');
            if (delEl) {
              ev.stopPropagation();
              var du = delEl.getAttribute('data-del-url');
              var nl = readBookmarks().filter(function(x){ return x.url !== du; });
              writeBookmarks(nl);
              renderBookmarksDropdown();
              return;
            }
            var url = el.getAttribute('data-url');
            if (url) {
              // 当前标签导航过去（若当前是主标签也允许，用户主动操作）
              window.shellAPI.tabNavigate(url).then(function(r){
                if (r && !r.success) toast2(r.error || '打开失败');
                closeAllDropdowns();
              })['catch'](function(){});
            }
          });
        })(items[j]);
      }
    }

    if (bmBtn && window.shellAPI && window.shellAPI.openDropdown) {
      bmBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        closeAllDropdowns();
        window.shellAPI.openDropdown({
          type: 'bookmarks',
          anchor: screenRect(bmBtn),
          bookmarks: readBookmarks(),
          theme: currentTheme(),
        }).then(function(r){
          if (r && !r.success) toast2(r.error || '打开收藏夹失败');
        })['catch'](function(){});
      });
    }

    // 主进程下拉窗口回来的收藏增删 → 写 localStorage
    try {
      if (window.shellAPI.onBookmarkAdd) {
        window.shellAPI.onBookmarkAdd(function(p){
          var url = String((p && p.url) || '').trim();
          if (!url) return;
          var title = String((p && p.title) || '').trim() || domainOf(url);
          var list = readBookmarks();
          if (list.some(function(x){ return x.url === url; })) { toast2('已收藏过'); return; }
          list.unshift({ url: url, title: title, addedAt: Date.now() });
          writeBookmarks(list);
          toast2('已添加收藏：' + title);
        });
      }
      if (window.shellAPI.onBookmarkRemove) {
        window.shellAPI.onBookmarkRemove(function(p){
          var url = String((p && p.url) || '').trim();
          if (!url) return;
          var list = readBookmarks().filter(function(x){ return x.url !== url; });
          writeBookmarks(list);
          toast2('已删除收藏');
        });
      }
    } catch (_) {}

    function addBookmark() {
      var rawUrl = (bmAddUrl && bmAddUrl.value) || '';
      var url = normalizeUrl(rawUrl);
      if (!url || url === 'https://') { toast2('请输入网址'); return; }
      var name = (bmAddName && bmAddName.value || '').trim() || domainOf(url);
      var list = readBookmarks();
      if (list.some(function(x){ return x.url === url; })) { toast2('已收藏过'); return; }
      list.unshift({ url: url, title: name, addedAt: Date.now() });
      writeBookmarks(list);
      if (bmAddUrl) bmAddUrl.value = '';
      if (bmAddName) bmAddName.value = '';
      renderBookmarksDropdown();
      toast2('已添加收藏：' + name);
    }
    if (bmAddBtn) bmAddBtn.addEventListener('click', addBookmark);
    if (bmAddUrl) bmAddUrl.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') { ev.preventDefault(); addBookmark(); } });
    if (bmAddName) bmAddName.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') { ev.preventDefault(); addBookmark(); } });

    // 供 renderTabs 内部回调刷新下拉（避免覆写函数声明）
    window.__lyRenderTabsDropdown = renderTabsDropdown;
  })();

})();
