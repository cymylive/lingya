const fs = require('fs');
const jsPath = 'src/main/remote/pwa/app.js';
let content = fs.readFileSync(jsPath, 'utf8');

const newRenderLogic = `var currentDrawerTab = 'workspace';

function onSessionsData(msg) {
  var list = $('session-list');
  if (!list) return;
  var sessions = msg.sessions || [];
  var archivedProjects = msg.archivedProjects || [];
  
  var isProjArchived = {};
  archivedProjects.forEach(function(dir) { isProjArchived[dir] = true; });

  var projects = {};
  sessions.forEach(function(s) {
    var pDir = s.projectDir || '未分类项目';
    if (!projects[pDir]) projects[pDir] = { dir: pDir, sessions: [] };
    projects[pDir].sessions.push(s);
  });

  var html = '';
  var pKeys = Object.keys(projects).sort();
  
  pKeys.forEach(function(pDir) {
    var proj = projects[pDir];
    var projArchived = isProjArchived[pDir] === true;

    // 根据顶部 Tab 过滤项目
    if (currentDrawerTab === 'workspace' && projArchived) return;
    if (currentDrawerTab === 'archived' && !projArchived) return;

    var pName = pDir.split(/[\\\\/]/).pop();
    var isOpen = proj.sessions.some(function(s) { return s.sessionId === currentProfileId; });
    var openCls = isOpen ? 'open' : '';

    var activeSessions = proj.sessions.filter(function(s) { return !s.archived; });
    var archSessions = proj.sessions.filter(function(s) { return !!s.archived; });

    html += '<div class="project-group ' + openCls + '">';
    html += '<div class="project-header">' +
            '<div class="project-title">📁 ' + escapeHtml(pName) + '</div>' +
            '<div class="project-actions" data-pdir="' + escapeHtml(pDir) + '" data-arch="' + projArchived + '">⋮</div>' +
            '<div class="todo-chevron" style="margin-left:8px;">▾</div>' +
            '</div>';
    
    html += '<div class="project-sessions">';
    // 渲染活跃会话
    activeSessions.forEach(function(s) {
      html += renderItem(s);
    });

    // 渲染已归档折叠
    if (archSessions.length > 0) {
      html += '<div class="archived-group">' +
              '<div class="archived-header">▶ 已归档 ' + archSessions.length + ' 对话</div>' +
              '<div class="archived-sessions">';
      archSessions.forEach(function(s) {
        html += renderItem(s);
      });
      html += '</div></div>';
    }
    html += '</div></div>';
  });

  if (!html) html = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px;">暂无会话</div>';
  list.innerHTML = html;

  // 绑定折叠
  list.querySelectorAll('.project-header').forEach(function(h) {
    h.addEventListener('click', function(e) {
      if (e.target.classList.contains('project-actions')) return; // 点菜单不折叠
      h.parentNode.classList.toggle('open');
    });
  });

  list.querySelectorAll('.archived-header').forEach(function(h) {
    h.addEventListener('click', function(e) {
      e.stopPropagation();
      h.parentNode.classList.toggle('open');
    });
  });

  // 绑定项目级菜单
  list.querySelectorAll('.project-actions').forEach(function(el) {
    el.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var pDir = el.getAttribute('data-pdir');
      var isArch = el.getAttribute('data-arch') === 'true';
      var action = prompt('输入操作：1=归档项目, 2=取消归档项目');
      if (action === '1' && !isArch) {
        send({ type: 'action-archive-project', profileId: currentProfileId, projectDir: pDir, archived: true });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      } else if (action === '2' && isArch) {
        send({ type: 'action-archive-project', profileId: currentProfileId, projectDir: pDir, archived: false });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      }
    });
  });

  // 绑定会话项
  list.querySelectorAll('.session-item').forEach(bindSessionItem);
}

function renderItem(s) {
  var title = s.title || s.sessionId || '未命名会话';
  var activeCls = (s.sessionId === currentProfileId) ? ' active' : '';
  return '<div class="session-item ' + activeCls + '" data-sid="' + escapeHtml(s.sessionId) + '">' +
         '<div class="s-title" style="padding-right:20px;">' + escapeHtml(title) + '</div>' +
         '<div class="session-more-btn" data-sid="' + escapeHtml(s.sessionId) + '">⋮</div>' +
         '</div>';
}

function bindSessionItem(el) {
  var moreBtn = el.querySelector('.session-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var sid = el.getAttribute('data-sid');
      var action = prompt('输入操作：1=重命名, 2=导入历史, 3=删除, 4=归档/取消归档');
      if (action === '4') {
        send({ type: 'action-archive-session', profileId: currentProfileId, sessionId: sid, archived: !el.closest('.archived-sessions') });
        setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
      } else if (action === '3') {
        if (confirm('确定要删除这个会话吗？此操作不可恢复！')) {
          send({ type: 'action-delete-session', profileId: currentProfileId, sessionId: sid });
        }
      } else if (action === '1') {
        var newName = prompt('输入新的会话名称：');
        if (newName) {
          send({ type: 'action-rename', profileId: currentProfileId, sessionId: sid, title: newName });
          setTimeout(function() { send({ type: 'req-sessions', profileId: currentProfileId }); }, 500);
        }
      } else if (action === '2') {
        send({ type: 'action-import', profileId: currentProfileId, sourceSessionId: sid });
        alert('历史导入指令已发送，请查看当前对话。');
        var d = $('sidebar-drawer'); if(d) d.classList.remove('open');
        var o = $('drawer-overlay'); if(o) { o.classList.remove('open'); setTimeout(function(){o.hidden=true;},200); }
      }
    });
  }

  el.addEventListener('click', function() {
    var sid = el.getAttribute('data-sid');
    send({ type: 'action-switch-session', profileId: currentProfileId, session: { sessionId: sid } });
    var d = $('sidebar-drawer'); if(d) d.classList.remove('open');
    var o = $('drawer-overlay'); if(o) { o.classList.remove('open'); setTimeout(function(){o.hidden=true;},200); }
    elMessages.innerHTML = '';
    if (!elEmpty) {
      elEmpty = document.createElement('div');
      elEmpty.className = 'empty-state';
      elEmpty.innerHTML = '<p style="color:var(--text-dim)">正在同步对话...</p>';
      elMessages.appendChild(elEmpty);
    }
    setTimeout(function() { send({ type: 'refresh-history' }); }, 1500);
  });
}`;

const startIdx = content.indexOf('var currentDrawerTab');
const endIdx = content.indexOf('function renderTodoPanel(todos)');
if (startIdx !== -1 && endIdx !== -1) {
  content = content.slice(0, startIdx) + newRenderLogic + '\n\n' + content.slice(endIdx);
  fs.writeFileSync(jsPath, content, 'utf8');
  console.log('✅ 前端渲染重构完成');
} else {
  console.log('❌ 找不到锚点');
}
