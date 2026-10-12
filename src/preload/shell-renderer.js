/**
 * 壳页面渲染 —— 照搬 cuckoo-code files.ts + preview.ts 的实现
 * 项目文件树（SVG 图标 / 语言角标 / 搜索高亮）+ 分栏预览 + 拖拽调宽
 */
(function () {
  // ===== 常量 =====
  var CARET_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
  var FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  var IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

  var EXT_COLOR = { ts:'ts',tsx:'ts',mts:'ts',cts:'ts', js:'js',jsx:'js',mjs:'js',cjs:'js', json:'json',json5:'json', md:'md',markdown:'md',mdx:'md', css:'css',scss:'css',less:'css',sass:'css', html:'html',htm:'html',vue:'html',svelte:'html', py:'py',pyw:'py', java:'java',kt:'java',kts:'java', go:'go', rs:'rs', rb:'rb', php:'php', c:'c',h:'c',cc:'c',cpp:'c',hpp:'c',cxx:'c', cs:'cs', sh:'sh',bash:'sh',zsh:'sh',bat:'sh',cmd:'sh',ps1:'sh', yml:'yml',yaml:'yml',toml:'yml',ini:'yml',conf:'yml',env:'yml', xml:'xml',svg:'xml', sql:'sql', png:'img',jpg:'img',jpeg:'img',gif:'img',webp:'img',bmp:'img',ico:'img',avif:'img',mp4:'img',mp3:'img',wav:'img',mov:'img',webm:'img', txt:'txt',log:'txt',text:'txt', lock:'lock' };
  var EXT_BADGE = { ts:'TS',tsx:'TS',mts:'TS',cts:'TS', js:'JS',jsx:'JS',mjs:'JS',cjs:'JS', json:'{}',json5:'{}', md:'MD',markdown:'MD',mdx:'MD', css:'CSS',scss:'CSS',less:'CSS',sass:'CSS', html:'<>',htm:'<>',vue:'VUE',svelte:'SVE', py:'PY',pyw:'PY', java:'JV',kt:'KT',kts:'KT', go:'GO',rs:'RS',rb:'RB',php:'PHP', c:'C',h:'H',cc:'C+',cpp:'C+',hpp:'C+',cxx:'C+', cs:'C#', sh:'>_',bash:'>_',zsh:'>_',bat:'>_',cmd:'>_',ps1:'>_', yml:'YML',yaml:'YML',toml:'TML',ini:'INI',conf:'CFG',env:'ENV', xml:'XML',svg:'SVG',sql:'SQL', txt:'TXT',log:'LOG',text:'TXT',lock:'LCK' };
  var MEDIA_EXTS = { png:1,jpg:1,jpeg:1,gif:1,webp:1,bmp:1,ico:1,avif:1,mp4:1,mp3:1,wav:1,mov:1,webm:1 };

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

  var width = (function () { try { var v=Number(localStorage.getItem(WIDTH_KEY)); if(isFinite(v)&&v>=MIN_W&&v<=MAX_W) return Math.round(v);}catch(_){} return DEFAULT_W; })();

  function esc(t){ var d=document.createElement('div'); d.textContent=t==null?'':String(t); return d.innerHTML; }
  function attr(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function extOf(name){ var i=name.lastIndexOf('.'); return i>=0?name.slice(i+1).toLowerCase():''; }
  function highlight(text, kw){
    var e = esc(text);
    if (!kw) return e;
    var ek = esc(kw).replace(/[.*+?^$^{}()|[\]\\]/g,'\\$&');
    try { return e.replace(new RegExp('('+ek+')','gi'), '<mark class="ck-ft-hl">$1</mark>'); } catch(_){ return e; }
  }
  function colorClass(name, type){ if(type==='dir') return ''; var ex=extOf(name); return EXT_COLOR[ex] ? 'ck-ft-c-'+EXT_COLOR[ex] : 'ck-ft-c-file'; }
  function nameClass(name, type){ return type==='dir' ? 'ck-ft-name' : 'ck-ft-name '+colorClass(name,type); }
  function iconHtml(name, type){
    if(type==='dir') return '<span class="ck-ft-icon ck-ft-i-dir">'+FOLDER_SVG+'</span>';
    var ex=extOf(name);
    if(MEDIA_EXTS[ex]) return '<span class="ck-ft-icon ck-ft-i-media">'+IMG_SVG+'</span>';
    var b=EXT_BADGE[ex];
    if(b) return '<span class="ck-ft-icon ck-ft-badge '+colorClass(name,'file')+'">'+b+'</span>';
    return '<span class="ck-ft-icon ck-ft-i-file">'+FILE_SVG+'</span>';
  }

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

  // 图标条按钮
  var abItems = document.querySelectorAll('.sh-ab-item[data-tab]');
  for (var ai=0; ai<abItems.length; ai++) {
    (function(btn){ btn.addEventListener('click', function(){
      if (open) { setOpen(false); }
      else {
        var all=document.querySelectorAll('.sh-ab-item[data-tab]');
        for(var j=0;j<all.length;j++) all[j].classList.toggle('active', all[j]===btn);
        setOpen(true);
      }
    }); })(abItems[ai]);
  }

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
  function renderNodes(nodes, depth) {
    var html='';
    for (var k=0;k<nodes.length;k++){
      var n=nodes[k], pad=6+depth*14;
      if(n.type==='dir'){
        var op=!!expanded[n.path];
        html+='<div class="ck-ft-row ck-ft-dir'+(op?' open':'')+'" data-path="'+attr(n.path)+'" data-type="dir" style="padding-left:'+pad+'px">'+
          '<span class="ck-ft-caret">'+CARET_SVG+'</span>'+iconHtml(n.name,'dir')+
          '<span class="'+nameClass(n.name,'dir')+'">'+esc(n.name)+'</span></div>';
        if(op&&n.children) html+=renderNodes(n.children,depth+1);
      } else {
        html+='<div class="ck-ft-row ck-ft-file" data-path="'+attr(n.path)+'" data-type="file" title="'+attr(n.path)+'" style="padding-left:'+pad+'px">'+
          '<span class="ck-ft-caret"></span>'+iconHtml(n.name,'file')+
          '<span class="'+nameClass(n.name,'file')+'">'+esc(n.name)+'</span></div>';
      }
    }
    return html;
  }
  function flatten(nodes,out){ for(var i=0;i<nodes.length;i++){ out.push(nodes[i]); if(nodes[i].children) flatten(nodes[i].children,out); } return out; }
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
    var items = [
      { label: '复制绝对路径', act: 'copy', icon: '\u2398' },
    ];
    if (type === 'file') {
      items.push({ label: '移到回收站', act: 'trash', icon: '\u267B' });
      items.push({ label: '永久删除', act: 'delete', icon: '\u2716', danger: true });
    }
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var d = document.createElement('div');
        d.className = 'ck-ctx-item' + (it.danger ? ' danger' : '');
        d.innerHTML = '<span class="ck-ctx-ico">' + it.icon + '</span>' + it.label;
        d.addEventListener('click', function () { closeContextMenu(); doAction(it.act, path); });
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
  function doAction(act, path){
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

  document.getElementById('ft-refresh')&&document.getElementById('ft-refresh').addEventListener('click', loadFiles);
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
})();
