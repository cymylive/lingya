/**
 * 壳页面渲染的纯函数工具
 *
 * 从 shell-renderer.js 提取（审计发现该文件 2127 行、零测试覆盖）。
 * 这些都是无副作用的纯函数，可独立单测 —— 提取出来是为了：
 *   1. 降低 shell-renderer.js 的体积与耦合
 *   2. 让易错的转义/递归逻辑有测试保护
 *
 * 注意：本模块不依赖 DOM，可在 Node 环境直接 require。
 */

// ===== SVG 图标 =====//
var CARET_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
var FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
var FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
var IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

// ===== 扩展名映射 =====
var EXT_COLOR = { ts:'ts',tsx:'ts',mts:'ts',cts:'ts', js:'js',jsx:'js',mjs:'js',cjs:'js', json:'json',json5:'json', md:'md',markdown:'md',mdx:'md', css:'css',scss:'css',less:'css',sass:'css', html:'html',htm:'html',vue:'html',svelte:'html', py:'py',pyw:'py', java:'java',kt:'java',kts:'java', go:'go', rs:'rs', rb:'rb', php:'php', c:'c',h:'c',cc:'c',cpp:'c',hpp:'c',cxx:'c', cs:'cs', sh:'sh',bash:'sh',zsh:'sh',bat:'sh',cmd:'sh',ps1:'sh', yml:'yml',yaml:'yml',toml:'yml',ini:'yml',conf:'yml',env:'yml', xml:'xml',svg:'xml', sql:'sql', png:'img',jpg:'img',jpeg:'img',gif:'img',webp:'img',bmp:'img',ico:'img',avif:'img',mp4:'img',mp3:'img',wav:'img',mov:'img',webm:'img', txt:'txt',log:'txt',text:'txt', lock:'lock' };
var EXT_BADGE = { ts:'TS',tsx:'TS',mts:'TS',cts:'TS', js:'JS',jsx:'JS',mjs:'JS',cjs:'JS', json:'{}',json5:'{}', md:'MD',markdown:'MD',mdx:'MD', css:'CSS',scss:'CSS',less:'CSS',sass:'CSS', html:'<>',htm:'<>',vue:'VUE',svelte:'SVE', py:'PY',pyw:'PY', java:'JV',kt:'KT',kts:'KT', go:'GO',rs:'RS',rb:'RB',php:'PHP', c:'C',h:'H',cc:'C+',cpp:'C+',hpp:'C+',cxx:'C+', cs:'C#', sh:'>_',bash:'>_',zsh:'>_',bat:'>_',cmd:'>_',ps1:'>_', yml:'YML',yaml:'YML',toml:'TML',ini:'INI',conf:'CFG',env:'ENV', xml:'XML',svg:'SVG',sql:'SQL', txt:'TXT',log:'LOG',text:'TXT',lock:'LCK' };
var MEDIA_EXTS = { png:1,jpg:1,jpeg:1,gif:1,webp:1,bmp:1,ico:1,avif:1,mp4:1,mp3:1,wav:1,mov:1,webm:1 };

/** HTML 转义（& < > "） */
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 属性值转义（比 esc 多一层：不含 > 但含 "，用于 data-* 属性） */
function attr(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 取扩展名（小写，无扩展名返回空串） */
function extOf(name) {
  var s = String(name == null ? '' : name);
  var i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

/** 搜索关键词高亮（先转义再包裹 mark 标签） */
function highlight(text, kw) {
  var e = esc(text);
  if (!kw) return e;
  var ek = esc(kw).replace(/[.*+?^$^{}()|[\]\\]/g, '\\$&');
  try {
    return e.replace(new RegExp('(' + ek + ')', 'gi'), '<mark class="ck-ft-hl">$1</mark>');
  } catch (_) {
    return e;
  }
}

/** 文件类型对应的颜色 class */
function colorClass(name, type) {
  if (type === 'dir') return '';
  var ex = extOf(name);
  return EXT_COLOR[ex] ? 'ck-ft-c-' + EXT_COLOR[ex] : 'ck-ft-c-file';
}

/** 文件名对应的 class（目录 / 文件） */
function nameClass(name, type) {
  return type === 'dir' ? 'ck-ft-name' : 'ck-ft-name ' + colorClass(name, type);
}

/** 图标 HTML（目录 / 媒体 / 语言角标 / 普通文件） */
function iconHtml(name, type) {
  if (type === 'dir') return '<span class="ck-ft-icon ck-ft-i-dir">' + FOLDER_SVG + '</span>';
  var ex = extOf(name);
  if (MEDIA_EXTS[ex]) return '<span class="ck-ft-icon ck-ft-i-media">' + IMG_SVG + '</span>';
  var b = EXT_BADGE[ex];
  if (b) return '<span class="ck-ft-icon ck-ft-badge ' + colorClass(name, 'file') + '">' + b + '</span>';
  return '<span class="ck-ft-icon ck-ft-i-file">' + FILE_SVG + '</span>';
}

/** 递归渲染文件树节点 */
function renderNodes(nodes, depth, expanded) {
  expanded = expanded || {};
  var html = '';
  if (!Array.isArray(nodes)) return html;
  for (var k = 0; k < nodes.length; k++) {
    var n = nodes[k], pad = 6 + depth * 14;
    if (n.type === 'dir') {
      var op = !!expanded[n.path];
      html += '<div class="ck-ft-row ck-ft-dir' + (op ? ' open' : '') + '" data-path="' + attr(n.path) + '" data-type="dir" style="padding-left:' + pad + 'px">' +
        '<span class="ck-ft-caret">' + CARET_SVG + '</span>' + iconHtml(n.name, 'dir') +
        '<span class="' + nameClass(n.name, 'dir') + '">' + esc(n.name) + '</span></div>';
      if (op && n.children) html += renderNodes(n.children, depth + 1, expanded);
    } else {
      html += '<div class="ck-ft-row ck-ft-file" data-path="' + attr(n.path) + '" data-type="file" title="' + attr(n.path) + '" style="padding-left:' + pad + 'px">' +
        '<span class="ck-ft-caret"></span>' + iconHtml(n.name, 'file') +
        '<span class="' + nameClass(n.name, 'file') + '">' + esc(n.name) + '</span></div>';
    }
  }
  return html;
}

/** 把树拍平成数组（深度优先） */
function flatten(nodes, out) {
  out = out || [];
  if (!Array.isArray(nodes)) return out;
  for (var i = 0; i < nodes.length; i++) {
    out.push(nodes[i]);
    if (nodes[i].children) flatten(nodes[i].children, out);
  }
  return out;
}

var __API = {
  CARET_SVG, FOLDER_SVG, FILE_SVG, IMG_SVG,
  EXT_COLOR, EXT_BADGE, MEDIA_EXTS,
  esc, attr, extOf, highlight, colorClass, nameClass, iconHtml, renderNodes, flatten,
};

// UMD 尾巴：同时支持 Node require 与浏览器 <script src>
// shell-renderer.js 是普通浏览器脚本（<script src> 加载），不能用 require，
// 所以必须挂到 window 上供它取用。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = __API;
}
if (typeof window !== 'undefined') {
  window.__lyShellUtils = __API;
}
