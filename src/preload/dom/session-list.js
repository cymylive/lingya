/**
 * 会话列表功能（渲染、导航、初始化项目按钮）
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { escapeHtml, showToast } = require('../overlay/ui');

// ========== 会话列表功能 ==========

/**
 * 渲染当前项目目录关联的会话列表
 */
async function renderSessions() {
  const listContainer = document.getElementById('lingya-session-list');
  if (!listContainer) return;

  try {
    if (!window.electronAPI || !window.electronAPI.listSessions) {
      listContainer.innerHTML = '<div class="lingya-session-empty">API 不可用</div>';
      return;
    }

    const result = await window.electronAPI.listSessions();
    if (!result.success) {
      listContainer.innerHTML = '<div class="lingya-session-empty">加载失败</div>';
      return;
    }

    const allSessions = result.sessions || [];
    if (allSessions.length === 0) {
      listContainer.innerHTML = '<div class="lingya-session-empty">暂无会话</div>';
      return;
    }

    // 分组：未归档 / 已归档
    const active = [];
    const archived = [];
    for (const s of allSessions) {
      const isArch = !!(typeof s === 'object' && s.archivedAt);
      (isArch ? archived : active).push(s);
    }

    function renderItem(s, isArchived) {
      const sid = typeof s === 'string' ? s : (s.sessionId || '');
      const title = typeof s === 'object' ? (s.title || '') : '';
      const label = title ? (escapeHtml(title) + ' (' + escapeHtml(sid) + ')') : escapeHtml(sid);
      const archBtn = isArchived
        ? '<span class="session-unarchive" title="取消归档">↩ 取消归档</span>'
        : '<span class="session-archive" title="归档（从列表隐藏）">📦 归档</span>';
      return `
      <div class="lingya-session-item${isArchived ? ' archived' : ''}" data-session-id="${escapeHtml(sid)}" data-title="${escapeHtml(title)}" data-archived="${isArchived ? '1' : '0'}">
        <span class="session-id">${label}</span>
        <span class="session-rename" title="重命名">✎ 改名</span>
        ${archBtn}
        <span class="session-action">▶ 跳转</span>
      </div>`;
    }

    let html = '';
    if (active.length === 0) {
      html += '<div class="lingya-session-empty">暂无进行中的会话</div>';
    } else {
      html += active.map((s) => renderItem(s, false)).join('');
    }
    if (archived.length > 0) {
      html += `
      <div class="lingya-archived-header" data-toggle-archived="1">
        <span class="lingya-archived-caret">▸</span>
        <span>📦 已归档 (${archived.length})</span>
      </div>
      <div class="lingya-archived-list" style="display:none;">
        ${archived.map((s) => renderItem(s, true)).join('')}
      </div>`;
    }
    listContainer.innerHTML = html;

    // 已归档折叠区展开/收起
    const archHeader = listContainer.querySelector('.lingya-archived-header');
    const archList = listContainer.querySelector('.lingya-archived-list');
    if (archHeader && archList) {
      const KEY = 'lingya-archived-open';
      let open = false;
      try { open = localStorage.getItem(KEY) === '1'; } catch (_) {}
      const apply = (v) => {
        archList.style.display = v ? 'flex' : 'none';
        const caret = archHeader.querySelector('.lingya-archived-caret');
        if (caret) caret.textContent = v ? '▾' : '▸';
        try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) {}
      };
      apply(open);
      archHeader.addEventListener('click', () => {
        const nowOpen = archList.style.display === 'none';
        apply(nowOpen);
      });
    }

    // 绑定每项事件（含归档区里的项）
    listContainer.querySelectorAll('.lingya-session-item').forEach((item) => {
      const renameBtn = item.querySelector('.session-rename');
      if (renameBtn) {
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleRenameSession(item.dataset.sessionId, item.dataset.title || '');
        });
      }
      const archBtn = item.querySelector('.session-archive');
      if (archBtn) {
        archBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleArchiveSession(item.dataset.sessionId, true);
        });
      }
      const unarchBtn = item.querySelector('.session-unarchive');
      if (unarchBtn) {
        unarchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleArchiveSession(item.dataset.sessionId, false);
        });
      }
      item.addEventListener('click', () => {
        const sessionId = item.dataset.sessionId;
        if (sessionId) handleNavigateSession(sessionId);
      });
    });
  } catch (err) {
    console.error('[LingYa] 渲染会话列表失败:', err);
    listContainer.innerHTML = '<div class="lingya-session-empty">加载出错</div>';
  }
}

/**
 * 归档 / 取消归档会话
 */
async function handleArchiveSession(sessionId, archived) {
  if (!sessionId) return;
  if (!window.electronAPI || !window.electronAPI.setSessionArchived) {
    showToast('归档 API 不可用', 3000);
    return;
  }
  try {
    const r = await window.electronAPI.setSessionArchived(sessionId, archived);
    if (r && r.success) {
      showToast(archived ? '已归档' : '已取消归档', 1800);
      renderSessions();
    } else {
      showToast('操作失败: ' + ((r && r.error) || '未知错误'), 3000);
    }
  } catch (err) {
    showToast('操作失败: ' + err.message, 3000);
  }
}

/**
 * 重命名指定会话（会话列表里手动改名，AI 命名后可修正）
 */
async function handleRenameSession(sessionId, currentTitle) {
  if (!sessionId) return;
  if (!window.electronAPI || !window.electronAPI.setSessionTitle) {
    showToast('重命名 API 不可用', 3000);
    return;
  }
  const next = window.prompt('重命名对话', currentTitle || '');
  if (next == null) return;
  const title = String(next).trim();
  if (!title) return;
  try {
    const r = await window.electronAPI.setSessionTitle(title, sessionId);
    if (r && r.success) {
      showToast('已重命名为：' + title, 2000);
      renderSessions();
    } else {
      showToast('重命名失败: ' + ((r && r.error) || '未知错误'), 3000);
    }
  } catch (err) {
    showToast('重命名失败: ' + err.message, 3000);
  }
}

/**
 * 导航到指定会话
 */
async function handleNavigateSession(sessionId) {
  if (!sessionId) return;

  try {
    if (!window.electronAPI || !window.electronAPI.navigateSession) {
      showToast('导航 API 不可用', 3000);
      return;
    }

    const result = await window.electronAPI.navigateSession(sessionId);
    if (result.success) {
      console.log('[LingYa] 已导航到会话:', sessionId);
      // 导航成功后，覆盖层可以保持打开，但用户可能会看到页面跳转
      // 小延迟后刷新会话列表
      setTimeout(renderSessions, 2000);
    } else {
      showToast('导航失败: ' + (result.error || '未知错误'), 3000);
    }
  } catch (err) {
    console.error('[LingYa] 导航到会话失败:', err);
    showToast('导航失败: ' + err.message, 3000);
  }
}

/**
 * 初始化项目按钮点击处理
 */
async function handleInitProject() {
  const initBtn = document.getElementById('lingya-btn-init');
  if (initBtn) {
    initBtn.disabled = true;
    initBtn.textContent = '⏳ 初始化中...';
  }

  try {
    // 调用主进程的 init-project IPC
    if (!window.electronAPI || !window.electronAPI.initProject) {
      throw new Error('window.electronAPI.initProject 不存在');
    }
    const result = await window.electronAPI.initProject();
    if (result && !result.success) {
      showToast(result.message || '初始化失败', 3000);
    } else {
      // 标记当前会话已注入，避免自动注入监视重复发送系统提示词
      try {
        require('./auto-inject').markSessionInjected(require('./auto-inject').getCurrentSessionId());
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    console.error('[LingYa] 初始化项目失败:', err);
    showToast('初始化失败: ' + err.message, 3000);
  } finally {
    if (initBtn) {
      initBtn.disabled = false;
      initBtn.textContent = '初始化项目';
    }
  }
}

module.exports = { renderSessions, handleNavigateSession, handleInitProject, handleRenameSession, handleArchiveSession };
