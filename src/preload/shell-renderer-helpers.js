/**
 * 工作区渲染纯函数（可在 Node 下测试）
 *
 * 从 shell-renderer.js 里抽出来的部分：会话项 HTML 生成 + 搜索过滤。
 * 保持与 shell-renderer 内联逻辑等价。
 */
'use strict';

/** HTML 转义 */
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function attr(t) { return esc(t); }

/**
 * 生成单个会话项的 HTML
 * @param {{sessionId:string, title?:string, profileId?:string, profileName?:string}} s
 * @param {{currentSessionId?:string, currentProfileId?:string, timeText?:string, archived?:boolean, icons?:object}} opts
 */
function renderSessionItemHtml(s, opts) {
  const o = opts || {};
  const label = s.title || s.sessionId;
  const time = o.timeText || '';
  const isCur = s.sessionId === o.currentSessionId;
  const curPid = o.currentProfileId || null;
  const isOtherWin = !!(s.profileId && curPid && s.profileId !== curPid);
  const badge = isOtherWin
    ? '<span class="ck-ws-badge" title="该会话来自另一个窗口">' + esc(s.profileName || s.profileId) + '</span>'
    : '';
  const icons = o.icons || {};
  const renameBtn = '<span class="ck-ws-act" data-act="rename" title="重命名">' + (icons.rename || '') + '</span>';
  const exportBtn = '<span class="ck-ws-act" data-act="export" title="导出为 .md">' + (icons.export || '') + '</span>';
  const delBtn = '<span class="ck-ws-act" data-act="delete" title="删除会话">' + (icons.trash || '') + '</span>';
  const act = o.archived
    ? '<span class="ck-ws-act" data-act="unarchive" title="取消归档">' + (icons.unarchive || '') + '</span>'
    : '<span class="ck-ws-act" data-act="archive" title="归档">' + (icons.archive || '') + '</span>';
  const caret = '<span class="ck-ws-expand ck-ws-expand-hidden">' + (icons.expand || '') + '</span>';
  return '<div class="ck-ws-item' + (isCur ? ' current' : '') + (isOtherWin ? ' other-win' : '') + '"' +
    ' data-session-id="' + attr(s.sessionId) + '"' +
    ' data-profile-id="' + attr(s.profileId || '') + '"' +
    ' data-name="' + attr(label) + '"' +
    ' title="' + attr(s.sessionId) + '">' +
    caret +
    '<span class="ck-ws-name">' + esc(label) + '</span>' +
    badge +
    (time ? '<span class="ck-ws-time">' + esc(time) + '</span>' : '') +
    '<span class="ck-ws-acts">' + renameBtn + exportBtn + act + delBtn + '</span>' +
    '</div>';
}

/**
 * 按关键词过滤会话（项目路径 + 标题，字面匹配、大小写不敏感）
 */
function filterSessions(sessions, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return Array.isArray(sessions) ? sessions.slice() : [];
  const list = Array.isArray(sessions) ? sessions : [];
  return list.filter(function (s) {
    const hay = ((s.projectDir || '') + ' ' + (s.title || '')).toLowerCase();
    return hay.indexOf(kw) !== -1;
  });
}

module.exports = { renderSessionItemHtml, filterSessions, esc, attr };
