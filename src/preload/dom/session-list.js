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

    const sessions = result.sessions || [];
    if (sessions.length === 0) {
      listContainer.innerHTML = '<div class="lingya-session-empty">暂无会话</div>';
      return;
    }

    listContainer.innerHTML = sessions.map((sessionId) => `
      <div class="lingya-session-item" data-session-id="${escapeHtml(sessionId)}">
        <span class="session-id">${escapeHtml(sessionId)}</span>
        <span class="session-action">▶ 跳转</span>
      </div>
    `).join('');

    // 绑定点击事件
    listContainer.querySelectorAll('.lingya-session-item').forEach((item) => {
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

module.exports = { renderSessions, handleNavigateSession, handleInitProject };
