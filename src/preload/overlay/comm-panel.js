/**
 * 通信中枢面板：列出飞书 / 微信 / QQ，点击进入各自配置。
 * 同时负责把各通道的连接状态渲染成卡片上的徽章。
 */
const { showToast } = require('./ui');
const { openFeishuManager, closeFeishuManager } = require('./feishu-panel');
const { openWeixinManager, closeWeixinManager } = require('./weixin-panel');
const { openQqManager, closeQqManager } = require('./qq-panel');

function el(id) {
  return document.getElementById(id);
}

/** 打开通信中枢 */
async function openCommManager() {
  const panel = el('lingya-comm-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await Promise.all([refreshCommStatus(), loadMediaConfig()]);
}

// ================= 接收目录配置 =================

/** 加载媒体收件箱配置并填充表单 */
async function loadMediaConfig() {
  try {
    const r = await window.electronAPI.getMediaConfig();
    if (!r || !r.success) return;
    const input = el('lingya-media-inbox-dir');
    // 输入框显示「用户配置值」，不是生效值——留空才代表默认
    if (input) input.value = r.inboxDir || '';
    const eff = el('lingya-media-effective');
    if (eff) {
      eff.textContent = '当前生效：' + (r.effectiveDir || '(未初始化)');
      eff.style.color = '#7c8798';
    }
  } catch (err) {
    console.error('[Comm] 加载媒体配置失败:', err.message);
  }
}

/** 选择目录（弹系统对话框），只填入输入框，不立即保存 */
async function pickMediaDir() {
  try {
    const r = await window.electronAPI.pickMediaDir();
    if (!r || !r.success) {
      if (r && r.canceled) return;
      showToast('选择目录失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    const input = el('lingya-media-inbox-dir');
    if (input) input.value = r.dir || '';
  } catch (err) {
    showToast('选择目录失败：' + err.message, 3000);
  }
}

/** 保存目录配置 */
async function saveMediaConfig() {
  const input = el('lingya-media-inbox-dir');
  const dir = input ? input.value.trim() : '';
  try {
    const r = await window.electronAPI.saveMediaConfig({ inboxDir: dir });
    if (!r || !r.success) {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 3500);
      return;
    }
    showToast(dir ? '已保存，立即生效' : '已恢复默认目录', 2500);
    await loadMediaConfig();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

/** 在文件管理器中打开当前生效目录 */
async function openMediaDir() {
  try {
    const r = await window.electronAPI.openMediaDir();
    if (!r || !r.success) {
      showToast('打开失败：' + ((r && r.error) || '未知错误'), 3000);
    }
  } catch (err) {
    showToast('打开失败：' + err.message, 3000);
  }
}

function closeCommManager() {
  const panel = el('lingya-comm-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/** 渲染某通道的状态徽章 */
function renderBadge(id, text, color) {
  const b = el(id);
  if (!b) return;
  b.textContent = text;
  if (color) {
    b.style.color = color;
    b.style.background = color.replace('rgb', 'rgba').replace(')', ', 0.15)');
  }
}

/** 拉取两个通道的状态，刷新卡片徽章 */
async function refreshCommStatus() {
  // 飞书
  try {
    const r = await window.electronAPI.getFeishuConfig();
    if (r && r.success) {
      const st = r.status || 'disconnected';
      const map = {
        connected: ['已连接', '#4ade80'],
        connecting: ['连接中', '#fbbf24'],
        error: ['错误', '#f87171'],
        disconnected: ['未连接', '#7c8798'],
      };
      const it = map[st] || map.disconnected;
      renderBadge('lingya-comm-feishu-status', it[0], it[1]);
    }
  } catch (_) {}

  // QQ
  try {
    const r = await window.electronAPI.getQqConfig();
    if (r && r.success) {
      const c = r.config || {};
      const st = r.status || 'disconnected';
      if (!c.appId || !c.hasSecret) {
        renderBadge('lingya-comm-qq-status', '未配置', '#7c8798');
      } else if (st === 'connected') {
        renderBadge('lingya-comm-qq-status', '已连接', '#4ade80');
      } else if (st === 'connecting') {
        renderBadge('lingya-comm-qq-status', '连接中', '#fbbf24');
      } else if (st === 'error') {
        renderBadge('lingya-comm-qq-status', '错误', '#f87171');
      } else {
        renderBadge('lingya-comm-qq-status', '未连接', '#7c8798');
      }
    }
  } catch (_) {}

  // 微信
  try {
    const r = await window.electronAPI.getWeixinConfig();
    if (r && r.success) {
      const c = r.config || {};
      const st = r.status || 'disconnected';
      if (!c.hasToken) {
        renderBadge('lingya-comm-weixin-status', '未登录', '#7c8798');
      } else if (st === 'connected') {
        renderBadge('lingya-comm-weixin-status', '已连接', '#4ade80');
      } else if (st === 'connecting') {
        renderBadge('lingya-comm-weixin-status', '连接中', '#fbbf24');
      } else if (st === 'error') {
        renderBadge('lingya-comm-weixin-status', '错误', '#f87171');
      } else {
        renderBadge('lingya-comm-weixin-status', '已登录', '#94a3b8');
      }
    }
  } catch (_) {}
}

/** 从中枢进入某通道配置（先收起中枢） */
async function gotoFeishu() {
  closeCommManager();
  try { await openFeishuManager(); } catch (err) { showToast('打开飞书配置失败: ' + err.message, 3000); }
}

async function gotoWeixin() {
  closeCommManager();
  try { await openWeixinManager(); } catch (err) { showToast('打开微信配置失败: ' + err.message, 3000); }
}

async function gotoQq() {
  closeCommManager();
  try { await openQqManager(); } catch (err) { showToast('打开 QQ 配置失败: ' + err.message, 3000); }
}

function bindCommPanelEvents() {
  const openBtn = el('lingya-btn-comm');
  openBtn && openBtn.addEventListener('click', openCommManager);

  const closeBtn = el('lingya-comm-close');
  closeBtn && closeBtn.addEventListener('click', closeCommManager);

  const fsBtn = el('lingya-comm-feishu');
  fsBtn && fsBtn.addEventListener('click', gotoFeishu);

  const wxBtn = el('lingya-comm-weixin');
  wxBtn && wxBtn.addEventListener('click', gotoWeixin);

  const qqBtn = el('lingya-comm-qq');
  qqBtn && qqBtn.addEventListener('click', gotoQq);

  // 媒体收件箱目录
  const pickBtn = el('lingya-media-pick');
  pickBtn && pickBtn.addEventListener('click', pickMediaDir);

  const openBtn2 = el('lingya-media-open');
  openBtn2 && openBtn2.addEventListener('click', openMediaDir);

  const saveBtn = el('lingya-media-save');
  saveBtn && saveBtn.addEventListener('click', saveMediaConfig);

  // QQ 按钮 disabled，不绑事件
}

module.exports = {
  bindCommPanelEvents,
  openCommManager,
  closeCommManager,
  refreshCommStatus,
};
