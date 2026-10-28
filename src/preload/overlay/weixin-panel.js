/**
 * 微信 iLink 通道面板：扫码登录 + 连接状态 + 推送选项
 * 仿 feishu-panel.js 结构，差异：用扫码代替 appId/appSecret，无群绑定。
 */
const { showToast } = require('./ui');

function el(id) {
  return document.getElementById(id);
}

/** 打开微信面板 */
async function openWeixinManager() {
  const panel = el('lingya-weixin-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await loadWeixinConfig();
}

function closeWeixinManager() {
  const panel = el('lingya-weixin-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/** 渲染连接状态 */
function renderWeixinStatus(status, detail) {
  const box = el('lingya-weixin-status');
  if (!box) return;
  const map = {
    connected: ['已连接', '#4ade80'],
    connecting: ['连接中…', '#fbbf24'],
    error: ['错误', '#f87171'],
    disconnected: ['未登录', '#7c8798'],
  };
  const item = map[status] || map.disconnected;
  box.textContent = item[0] + (detail ? ('（' + detail + '）') : '');
  box.style.color = item[1];
}

/** 加载配置并填充表单 */
async function loadWeixinConfig() {
  try {
    const r = await window.electronAPI.getWeixinConfig();
    if (!r || !r.success) {
      showToast('加载微信配置失败', 3000);
      return;
    }
    const c = r.config || {};
    const enabledEl = el('lingya-weixin-enabled');
    if (enabledEl) enabledEl.checked = !!c.enabled;

    const setCheck = (id, val, def) => { const e = el(id); if (e) e.checked = (val === undefined ? def : !!val); };
    setCheck('lingya-weixin-push-user', c.pushUserMessage, true);
    setCheck('lingya-weixin-push-ai', c.pushAiReply, true);
    setCheck('lingya-weixin-push-tool', c.pushToolStatus, true);
    setCheck('lingya-weixin-push-toolname', c.pushToolName, false);
    setCheck('lingya-weixin-push-done', c.pushTaskDone, true);
    const stallEl = el('lingya-weixin-stall');
    if (stallEl) stallEl.value = (typeof c.stallTimeoutSec === 'number' ? c.stallTimeoutSec : 660);

    // 登录态
    const loginBox = el('lingya-weixin-login-state');
    if (loginBox) {
      loginBox.textContent = c.hasToken ? ('已登录' + (c.botId ? '（bot: ' + c.botId.slice(0, 12) + '…）' : '')) : '未登录';
      loginBox.style.color = c.hasToken ? '#4ade80' : '#7c8798';
    }
    renderWeixinStatus(r.status, r.statusDetail);
  } catch (err) {
    showToast('加载微信配置失败：' + err.message, 3000);
  }
}

// ================= 扫码登录 =================

/** 轮询器句柄，切换面板时清掉 */
let qrPollTimer = null;

function stopQrPolling() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

/** 展示二维码 */
function showQrcode(qrcodeUrl) {
  const box = el('lingya-weixin-qrcode');
  if (!box) return;
  if (!qrcodeUrl) {
    box.innerHTML = '<span style="color:#f87171">二维码获取失败</span>';
    return;
  }
  // 主进程已本地生成 DataURL；兼容旧的 URL 和纯文本两种情况
  let src;
  if (qrcodeUrl.indexOf('data:image/') === 0) {
    src = qrcodeUrl;
  } else if (/^https?:\/\//i.test(qrcodeUrl)) {
    src = qrcodeUrl;
  } else {
    src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(qrcodeUrl);
  }
  box.innerHTML = '<img src="' + src + '" style="width:180px;height:180px;border-radius:8px;background:#fff;padding:6px;" />';
}

/** 发起扫码登录 */
async function startWeixinLogin() {
  stopQrPolling();
  const tip = el('lingya-weixin-login-tip');
  if (tip) { tip.textContent = '正在获取二维码…'; tip.style.color = '#fbbf24'; }

  try {
    const r = await window.electronAPI.getWeixinQrcode();
    if (!r || !r.success) {
      if (tip) { tip.textContent = '获取失败：' + ((r && r.error) || '未知错误'); tip.style.color = '#f87171'; }
      return;
    }
    showQrcode(r.qrcodeUrl);
    if (tip) { tip.textContent = '请用微信扫码确认'; tip.style.color = '#fbbf24'; }

    const qrcode = r.qrcode;
    qrPollTimer = setInterval(async () => {
      try {
        const st = await window.electronAPI.checkWeixinQrcode(qrcode);
        if (!st) return;
        if (st.status === 'scaned') {
          if (tip) { tip.textContent = '已扫码，请在手机上确认'; tip.style.color = '#fbbf24'; }
        } else if (st.status === 'confirmed') {
          stopQrPolling();
          if (tip) { tip.textContent = '登录成功！'; tip.style.color = '#4ade80'; }
          const box = el('lingya-weixin-qrcode');
          if (box) box.innerHTML = '<span style="color:#4ade80;font-size:13px;">✓ 已登录</span>';
          showToast('微信登录成功', 2500);
          await loadWeixinConfig();
        } else if (st.status === 'expired') {
          stopQrPolling();
          if (tip) { tip.textContent = '二维码已过期，请重新获取'; tip.textContent = '二维码已过期，请重新获取'; tip.style.color = '#f87171'; }
        } else if (st.status === 'error') {
          stopQrPolling();
          if (tip) { tip.textContent = '查询失败：' + (st.error || ''); tip.style.color = '#f87171'; }
        }
      } catch (err) {
        // 单次轮询失败不中断，等下一轮
      }
    }, 1500);
  } catch (err) {
    if (tip) { tip.textContent = '登录失败：' + err.message; tip.style.color = '#f87171'; }
  }
}

// ================= 配置保存与连接控制 =================

async function saveWeixinConfig() {
  const data = {
    enabled: !!(el('lingya-weixin-enabled') && el('lingya-weixin-enabled').checked),
    pushUserMessage: !!(el('lingya-weixin-push-user') && el('lingya-weixin-push-user').checked),
    pushAiReply: !!(el('lingya-weixin-push-ai') && el('lingya-weixin-push-ai').checked),
    pushToolStatus: !!(el('lingya-weixin-push-tool') && el('lingya-weixin-push-tool').checked),
    pushToolName: !!(el('lingya-weixin-push-toolname') && el('lingya-weixin-push-toolname').checked),
    pushTaskDone: !!(el('lingya-weixin-push-done') && el('lingya-weixin-push-done').checked),
  };
  const stallEl = el('lingya-weixin-stall');
  if (stallEl) {
    const v = parseInt(stallEl.value, 10);
    data.stallTimeoutSec = (!isNaN(v) && v >= 30) ? v : (v === 0 ? 0 : 660);
  }
  try {
    const r = await window.electronAPI.saveWeixinConfig(data);
    if (!r || !r.success) {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast('已保存', 2000);
    await loadWeixinConfig();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

async function reconnectWeixin() {
  try {
    const r = await window.electronAPI.reconnectWeixin();
    if (!r || !r.success) {
      showToast('重连失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast('正在重连…', 2000);
    setTimeout(loadWeixinConfig, 1500);
  } catch (err) {
    showToast('重连失败：' + err.message, 3000);
  }
}

async function disconnectWeixin() {
  try {
    await window.electronAPI.disconnectWeixin();
    showToast('已断开', 2000);
    await loadWeixinConfig();
  } catch (err) {
    showToast('断开失败：' + err.message, 3000);
  }
}

async function logoutWeixin() {
  try {
    await window.electronAPI.logoutWeixin();
    showToast('已退出登录', 2000);
    const box = el('lingya-weixin-qrcode');
    if (box) box.innerHTML = '';
    await loadWeixinConfig();
  } catch (err) {
    showToast('退出失败：' + err.message, 3000);
  }
}

// ================= 事件绑定 =================

function bindWeixinPanelEvents() {
  const openBtn = el('lingya-btn-weixin');
  openBtn && openBtn.addEventListener('click', openWeixinManager);

  const closeBtn = el('lingya-weixin-close');
  closeBtn && closeBtn.addEventListener('click', () => {
    stopQrPolling();
    closeWeixinManager();
  });

  const loginBtn = el('lingya-weixin-login');
  loginBtn && loginBtn.addEventListener('click', startWeixinLogin);

  const saveBtn = el('lingya-weixin-save');
  saveBtn && saveBtn.addEventListener('click', saveWeixinConfig);

  const reconBtn = el('lingya-weixin-reconnect');
  reconBtn && reconBtn.addEventListener('click', reconnectWeixin);

  const discBtn = el('lingya-weixin-disconnect');
  discBtn && discBtn.addEventListener('click', disconnectWeixin);

  const logoutBtn = el('lingya-weixin-logout');
  logoutBtn && logoutBtn.addEventListener('click', logoutWeixin);
}

module.exports = { bindWeixinPanelEvents, openWeixinManager, closeWeixinManager };
