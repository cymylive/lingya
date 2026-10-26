/**
 * 安全增强面板：CTF 提示词注入 + 拒绝拦截配置
 */
const { showToast } = require('./ui');
const { sendToChat } = require('../dom/chat-input');

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function el(id) {
  return document.getElementById(id);
}

/**
 * 打开安全增强面板
 */
async function openSecurityManager() {
  const panel = el('lingya-security-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await loadConfig();
}

function closeSecurityManager() {
  const panel = el('lingya-security-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

/**
 * 从主进程加载配置并填充表单
 */
async function loadConfig() {
  try {
    const cfg = await window.electronAPI.getSecurityConfig();
    if (!cfg) {
      showToast('加载安全配置失败', 3000);
      return;
    }
    const ctfEnabled = el('lingya-security-ctf-enabled');
    const ctfPrompt = el('lingya-security-ctf-prompt');
    if (ctfEnabled) ctfEnabled.checked = !!cfg.ctfInjectionEnabled;
    if (ctfPrompt) ctfPrompt.value = cfg.ctfPrompt || '';
    const promptChunkSize = el('lingya-security-prompt-chunk-size');
    if (promptChunkSize) promptChunkSize.value = cfg.promptChunkSize != null ? cfg.promptChunkSize : 15000;
  } catch (err) {
    showToast('加载安全配置失败：' + err.message, 3000);
  }
}

/**
 * 保存表单配置
 */
async function saveConfig() {
  const patch = {
    ctfInjectionEnabled: !!(el('lingya-security-ctf-enabled') && el('lingya-security-ctf-enabled').checked),
    ctfPrompt: el('lingya-security-ctf-prompt') ? el('lingya-security-ctf-prompt').value : '',
    promptChunkSize: el('lingya-security-prompt-chunk-size') ? el('lingya-security-prompt-chunk-size').value : '',
  };
  try {
    const res = await window.electronAPI.updateSecurityConfig(patch);
    if (!res || !res.success) {
      showToast('保存失败：' + ((res && res.error) || '未知错误'), 3000);
      return;
    }
    showToast('已保存', 2000);
    await loadConfig();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

/**
 * 重置配置
 */
async function resetConfig() {
  try {
    const res = await window.electronAPI.resetSecurityConfig();
    if (!res || !res.success) {
      showToast('重置失败：' + ((res && res.error) || '未知错误'), 3000);
      return;
    }
    showToast('已重置为默认配置', 2000);
    await loadConfig();
  } catch (err) {
    showToast('重置失败：' + err.message, 3000);
  }
}

/**
 * 立即注入：把当前生效的 CTF 提示词填入输入框并发送到当前对话
 * 用于已初始化的会话补注入，无需重新初始化项目
 */
async function injectCtfPrompt() {
  let res;
  try {
    res = await window.electronAPI.getCtfPrompt();
  } catch (err) {
    showToast('读取 CTF 提示词失败：' + err.message, 3000);
    return;
  }
  if (!res || !res.success) {
    showToast('读取 CTF 提示词失败：' + ((res && res.error) || '未知错误'), 3000);
    return;
  }
  const prompt = (res.prompt || '').trim();
  if (!prompt) {
    showToast('CTF 提示词为空（可在上方输入框填写，或确认内置模板 src/prompt/ctf.md 存在）', 4000);
    return;
  }
  const text =
    '【CTF 沙箱上下文 — 请在本次对话中遵循以下规则】\n\n' +
    prompt +
    '\n\n【以上为本次对话的安全测试上下文，请据此继续】';
  if (!sendToChat(text, 'CTF注入', 300)) {
    showToast('未找到输入框，请确保已打开聊天界面', 3000);
    return;
  }
  showToast('CTF 提示词已注入当前对话', 2500);
}

/**
 * 手动触发拒绝改写（I2：与侧边栏「立即改写」按钮同源）
 */
async function manualRewrite() {
  try {
    const res = await window.electronAPI.manualRewrite();
    if (res && res.success) {
      showToast(res.mode === 'local' ? '已本地改写并重发' : '已请求 AI 改写', 2500);
    } else {
      showToast('改写失败：' + ((res && res.error) || '未知错误'), 3000);
    }
  } catch (err) {
    showToast('改写异常：' + err.message, 3000);
  }
}

/**
 * 绑定安全增强面板事件
 */
function bindSecurityPanelEvents() {
  const openBtn = el('lingya-btn-security');
  openBtn?.addEventListener('click', openSecurityManager);

  const closeBtn = el('lingya-security-close');
  closeBtn?.addEventListener('click', closeSecurityManager);

  const saveBtn = el('lingya-security-save');
  saveBtn?.addEventListener('click', saveConfig);

  const resetBtn = el('lingya-security-reset');
  resetBtn?.addEventListener('click', resetConfig);

  const injectBtn = el('lingya-security-inject');
  injectBtn?.addEventListener('click', injectCtfPrompt);

  const manualBtn = el('lingya-security-manual-rewrite');
  manualBtn?.addEventListener('click', manualRewrite);
}

module.exports = { bindSecurityPanelEvents, openSecurityManager, closeSecurityManager };
