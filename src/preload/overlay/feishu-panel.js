/**
 * 飞书同步面板：凭证配置 + 连接状态 + 群绑定 + 推送选项
 * 仿 security-panel.js 结构。
 */
const { showToast } = require('./ui');

function el(id) {
  return document.getElementById(id);
}

/** 打开飞书面板 */
async function openFeishuManager() {
  const panel = el('lingya-feishu-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await loadFeishuConfig();
  await loadFeishuBinding();
}

function closeFeishuManager() {
  const panel = el('lingya-feishu-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/** 渲染连接状态 */
function renderStatus(status, detail) {
  const box = el('lingya-feishu-status');
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

/** 加载配置并填充表单 */
async function loadFeishuConfig() {
  try {
    const r = await window.electronAPI.getFeishuConfig();
    if (!r || !r.success) {
      showToast('加载飞书配置失败', 3000);
      return;
    }
    const c = r.config || {};
    const appIdEl = el('lingya-feishu-appid');
    const secretEl = el('lingya-feishu-secret');
    const enabledEl = el('lingya-feishu-enabled');
    if (appIdEl) appIdEl.value = c.appId || '';
    if (secretEl) {
      secretEl.value = '';
      secretEl.placeholder = c.hasSecret ? '已配置（留空表示不修改）' : 'App Secret';
    }
    if (enabledEl) enabledEl.checked = !!c.enabled;
    const setCheck = (id, val, def) => { const e = el(id); if (e) e.checked = (val === undefined ? def : !!val); };
    setCheck('lingya-feishu-push-user', c.pushUserMessage, true);
    setCheck('lingya-feishu-push-ai', c.pushAiReply, true);
    setCheck('lingya-feishu-push-tool', c.pushToolStatus, true);
    setCheck('lingya-feishu-push-toolname', c.pushToolName, false);
    setCheck('lingya-feishu-push-done', c.pushTaskDone, true);
    const stallEl = el('lingya-feishu-stall');
    if (stallEl) stallEl.value = (typeof c.stallTimeoutSec === 'number' ? c.stallTimeoutSec : 150);
    renderStatus(r.status, r.statusDetail);
  } catch (err) {
    showToast('加载飞书配置失败：' + err.message, 3000);
  }
}

/** 加载当前窗口的群绑定 */
async function loadFeishuBinding() {
  try {
    const b = await window.electronAPI.getFeishuBinding();
    const sel = el('lingya-feishu-chat');
    const cur = el('lingya-feishu-chat-current');
    if (cur) {
      cur.textContent = (b && b.chatName) ? (b.chatName + '（已绑定）') : '未绑定';
    }
    // 加载群列表填充下拉
    if (sel) {
      try {
        const r = await window.electronAPI.listFeishuChats();
        const chats = (r && r.success && r.chats) || [];
        sel.innerHTML = '<option value="">— 选择要绑定的群 —</option>' +
          chats.map((c) => '<option value="' + c.chatId + '">' + c.name + '</option>').join('');
        if (b && b.chatId) sel.value = b.chatId;
      } catch (_) {}
    }
  } catch (err) {
    console.error('[Feishu] 加载绑定失败:', err.message);
  }
}

/** 保存配置 */
async function saveFeishuConfig() {
  const data = {
    appId: el('lingya-feishu-appid') ? el('lingya-feishu-appid').value.trim() : '',
    enabled: !!(el('lingya-feishu-enabled') && el('lingya-feishu-enabled').checked),
    pushUserMessage: !!(el('lingya-feishu-push-user') && el('lingya-feishu-push-user').checked),
    pushAiReply: !!(el('lingya-feishu-push-ai') && el('lingya-feishu-push-ai').checked),
    pushToolStatus: !!(el('lingya-feishu-push-tool') && el('lingya-feishu-push-tool').checked),
    pushToolName: !!(el('lingya-feishu-push-toolname') && el('lingya-feishu-push-toolname').checked),
    pushTaskDone: !!(el('lingya-feishu-push-done') && el('lingya-feishu-push-done').checked),
  };
  const stallEl = el('lingya-feishu-stall');
  if (stallEl) {
    const v = parseInt(stallEl.value, 10);
    // 0 表示关闭看门狗；其余最小值 30 秒
    data.stallTimeoutSec = (!isNaN(v) && v >= 30) ? v : (v === 0 ? 0 : 150);
  }
  const secretEl = el('lingya-feishu-secret');
  if (secretEl && secretEl.value) data.appSecret = secretEl.value;
  try {
    const r = await window.electronAPI.saveFeishuConfig(data);
    if (!r || !r.success) {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast('已保存', 2000);
    await loadFeishuConfig();
    await loadFeishuBinding();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

/** 绑定选中群 */
async function bindSelectedChat() {
  const sel = el('lingya-feishu-chat');
  if (!sel) return;
  const chatId = sel.value;
  const chatName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
  try {
    const r = await window.electronAPI.bindFeishuChat(chatId, chatName);
    if (!r || !r.success) {
      showToast('绑定失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast(chatId ? '已绑定群' : '已解绑', 2000);
    await loadFeishuBinding();
  } catch (err) {
    showToast('绑定失败：' + err.message, 3000);
  }
}

/** 重新连接 */
async function reconnectFeishu() {
  try {
    const r = await window.electronAPI.reconnectFeishu();
    if (!r || !r.success) {
      showToast('重连失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast('正在重连…', 2000);
    setTimeout(loadFeishuConfig, 1500);
  } catch (err) {
    showToast('重连失败：' + err.message, 3000);
  }
}

/** 断开连接 */
async function disconnectFeishu() {
  try {
    await window.electronAPI.disconnectFeishu();
    showToast('已断开', 2000);
    await loadFeishuConfig();
  } catch (err) {
    showToast('断开失败：' + err.message, 3000);
  }
}

/** 绑定面板事件 */
function bindFeishuPanelEvents() {
  const openBtn = el('lingya-btn-feishu');
  openBtn && openBtn.addEventListener('click', openFeishuManager);

  const closeBtn = el('lingya-feishu-close');
  closeBtn && closeBtn.addEventListener('click', closeFeishuManager);

  const saveBtn = el('lingya-feishu-save');
  saveBtn && saveBtn.addEventListener('click', saveFeishuConfig);

  const bindBtn = el('lingya-feishu-bind');
  bindBtn && bindBtn.addEventListener('click', bindSelectedChat);

  const refreshBtn = el('lingya-feishu-refresh');
  refreshBtn && refreshBtn.addEventListener('click', loadFeishuBinding);

  const reconnectBtn = el('lingya-feishu-reconnect');
  reconnectBtn && reconnectBtn.addEventListener('click', reconnectFeishu);

  const disconnectBtn = el('lingya-feishu-disconnect');
  disconnectBtn && disconnectBtn.addEventListener('click', disconnectFeishu);
}

module.exports = { bindFeishuPanelEvents, openFeishuManager, closeFeishuManager };
