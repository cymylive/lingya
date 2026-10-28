/**
 * QQ 通道面板：AppID/AppSecret 配置 + 连接状态 + 推送选项
 * 结构仿 feishu-panel.js，差异：无群绑定（QQ 被动回复模型）。
 */
const { showToast } = require('./ui');

function el(id) {
  return document.getElementById(id);
}

async function openQqManager() {
  const panel = el('lingya-qq-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await loadQqConfig();
}

function closeQqManager() {
  const panel = el('lingya-qq-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

function renderQqStatus(status, detail) {
  const box = el('lingya-qq-status');
  if (!box) return;
  const map = {
    connected: ['已连接', '#4ade80'],
    connecting: ['连接中…', '#fbbf24'],
    error: ['错误', '#f87171'],
    disconnected: ['未连接', '#7c8798'],
  };
  const item = map[status] || map.disconnected;
  box.textContent = item[0] + (detail ? ('（' + detail + '）') : '');
  box.style.color = item[1];
}

async function loadQqConfig() {
  try {
    const r = await window.electronAPI.getQqConfig();
    if (!r || !r.success) {
      showToast('加载 QQ 配置失败', 3000);
      return;
    }
    const c = r.config || {};
    const appIdEl = el('lingya-qq-appid');
    const secretEl = el('lingya-qq-secret');
    const enabledEl = el('lingya-qq-enabled');
    if (appIdEl) appIdEl.value = c.appId || '';
    if (secretEl) {
      secretEl.value = '';
      secretEl.placeholder = c.hasSecret ? '已配置（留空表示不修改）' : 'App Secret';
    }
    if (enabledEl) enabledEl.checked = !!c.enabled;

    const setCheck = (id, val, def) => { const e = el(id); if (e) e.checked = (val === undefined ? def : !!val); };
    setCheck('lingya-qq-push-user', c.pushUserMessage, true);
    setCheck('lingya-qq-push-ai', c.pushAiReply, true);
    setCheck('lingya-qq-push-tool', c.pushToolStatus, true);
    setCheck('lingya-qq-push-toolname', c.pushToolName, false);
    setCheck('lingya-qq-push-done', c.pushTaskDone, true);
    const stallEl = el('lingya-qq-stall');
    if (stallEl) stallEl.value = (typeof c.stallTimeoutSec === 'number' ? c.stallTimeoutSec : 660);

    renderQqStatus(r.status, r.statusDetail);
  } catch (err) {
    showToast('加载 QQ 配置失败：' + err.message, 3000);
  }
}

async function saveQqConfig() {
  const data = {
    appId: el('lingya-qq-appid') ? el('lingya-qq-appid').value.trim() : '',
    enabled: !!(el('lingya-qq-enabled') && el('lingya-qq-enabled').checked),
    pushUserMessage: !!(el('lingya-qq-push-user') && el('lingya-qq-push-user').checked),
    pushAiReply: !!(el('lingya-qq-push-ai') && el('lingya-qq-push-ai').checked),
    pushToolStatus: !!(el('lingya-qq-push-tool') && el('lingya-qq-push-tool').checked),
    pushToolName: !!(el('lingya-qq-push-toolname') && el('lingya-qq-push-toolname').checked),
    pushTaskDone: !!(el('lingya-qq-push-done') && el('lingya-qq-push-done').checked),
  };
  const stallEl = el('lingya-qq-stall');
  if (stallEl) {
    const v = parseInt(stallEl.value, 10);
    data.stallTimeoutSec = (!isNaN(v) && v >= 30) ? v : (v === 0 ? 0 : 660);
  }
  const secretEl = el('lingya-qq-secret');
  if (secretEl && secretEl.value) data.appSecret = secretEl.value;

  try {
    const r = await window.electronAPI.saveQqConfig(data);
    if (!r || !r.success) {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 4000);
      return;
    }
    showToast('已保存', 2000);
    await loadQqConfig();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

async function reconnectQq() {
  try {
    const r = await window.electronAPI.reconnectQq();
    if (!r || !r.success) {
      showToast('重连失败：' + ((r && r.error) || '未知错误'), 4000);
      return;
    }
    showToast('正在重连…', 2000);
    setTimeout(loadQqConfig, 1500);
  } catch (err) {
    showToast('重连失败：' + err.message, 3000);
  }
}

async function disconnectQq() {
  try {
    await window.electronAPI.disconnectQq();
    showToast('已断开', 2000);
    await loadQqConfig();
  } catch (err) {
    showToast('断开失败：' + err.message, 3000);
  }
}

function bindQqPanelEvents() {
  const closeBtn = el('lingya-qq-close');
  closeBtn && closeBtn.addEventListener('click', closeQqManager);

  const saveBtn = el('lingya-qq-save');
  saveBtn && saveBtn.addEventListener('click', saveQqConfig);

  const reconBtn = el('lingya-qq-reconnect');
  reconBtn && reconBtn.addEventListener('click', reconnectQq);

  const discBtn = el('lingya-qq-disconnect');
  discBtn && discBtn.addEventListener('click', disconnectQq);
}

module.exports = { bindQqPanelEvents, openQqManager, closeQqManager };
