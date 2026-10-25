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
    const refusalEnabled = el('lingya-security-refusal-enabled');
    const aiRewrite = el('lingya-security-ai-rewrite');
    const endpoint = el('lingya-security-ai-endpoint');
    const key = el('lingya-security-ai-key');
    const model = el('lingya-security-ai-model');
    const mock = el('lingya-security-mock');
    const autoContinueEnabled = el('lingya-security-auto-continue-enabled');
    const autoContinueText = el('lingya-security-auto-continue-text');
    const autoContinueMax = el('lingya-security-auto-continue-max');
    const planContinueMax = el('lingya-security-plan-continue-max');
    const unplannedContinueEnabled = el('lingya-security-unplanned-continue-enabled');
    const stallSupervisorEnabled = el('lingya-security-stall-supervisor-enabled');
    const stallThreshold = el('lingya-security-stall-threshold');
    const stallContinueMax = el('lingya-security-stall-continue-max');

    if (ctfEnabled) ctfEnabled.checked = !!cfg.ctfInjectionEnabled;
    if (ctfPrompt) ctfPrompt.value = cfg.ctfPrompt || '';
    if (autoContinueEnabled) autoContinueEnabled.checked = !!cfg.autoContinueEnabled;
    if (autoContinueText) autoContinueText.value = cfg.autoContinueText || '';
    if (autoContinueMax) autoContinueMax.value = cfg.autoContinueMax != null ? cfg.autoContinueMax : 5;
    if (planContinueMax) planContinueMax.value = cfg.planContinueMax != null ? cfg.planContinueMax : 5;
    if (unplannedContinueEnabled) unplannedContinueEnabled.checked = cfg.unplannedContinueEnabled !== false;
    if (stallSupervisorEnabled) stallSupervisorEnabled.checked = cfg.stallSupervisorEnabled !== false;
    if (stallThreshold) stallThreshold.value = cfg.stallThresholdMs != null ? Math.round(cfg.stallThresholdMs / 1000) : 120;
    if (stallContinueMax) stallContinueMax.value = cfg.stallContinueMax != null ? cfg.stallContinueMax : 5;
    const promptChunkSize = el('lingya-security-prompt-chunk-size');
    if (promptChunkSize) promptChunkSize.value = cfg.promptChunkSize != null ? cfg.promptChunkSize : 15000;
    if (refusalEnabled) refusalEnabled.checked = !!cfg.refusalEnabled;
    const localRewrite = el('lingya-security-local-rewrite');
    if (localRewrite) localRewrite.checked = cfg.localRewriteEnabled !== false;
    if (aiRewrite) aiRewrite.checked = !!cfg.aiRewriteEnabled;
    const aiRewriteViaChat = el('lingya-security-ai-rewrite-via-chat');
    if (aiRewriteViaChat) aiRewriteViaChat.checked = !!cfg.aiRewriteViaChat;
    if (endpoint) endpoint.value = cfg.aiEndpoint || '';
    if (key) {
      key.value = '';
      key.placeholder = cfg.aiKeyConfigured ? '已配置（留空表示不修改）' : 'sk-...';
    }
    if (model) model.value = cfg.aiModel || '';
    if (mock) mock.value = cfg.mockResponse || '';
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
    autoContinueEnabled: !!(el('lingya-security-auto-continue-enabled') && el('lingya-security-auto-continue-enabled').checked),
    autoContinueText: el('lingya-security-auto-continue-text') ? el('lingya-security-auto-continue-text').value : '',
    autoContinueMax: el('lingya-security-auto-continue-max') ? el('lingya-security-auto-continue-max').value : '',
    planContinueMax: el('lingya-security-plan-continue-max') ? el('lingya-security-plan-continue-max').value : '',
    unplannedContinueEnabled: !!(el('lingya-security-unplanned-continue-enabled') && el('lingya-security-unplanned-continue-enabled').checked),
    stallSupervisorEnabled: !!(el('lingya-security-stall-supervisor-enabled') && el('lingya-security-stall-supervisor-enabled').checked),
    stallThresholdMs: (() => { const v = el('lingya-security-stall-threshold'); const s = v ? Math.floor(Number(v.value)) : 0; return s > 0 ? s * 1000 : ''; })(),
    stallContinueMax: el('lingya-security-stall-continue-max') ? el('lingya-security-stall-continue-max').value : '',
    promptChunkSize: el('lingya-security-prompt-chunk-size') ? el('lingya-security-prompt-chunk-size').value : '',
    refusalEnabled: !!(el('lingya-security-refusal-enabled') && el('lingya-security-refusal-enabled').checked),
    localRewriteEnabled: !!(el('lingya-security-local-rewrite') && el('lingya-security-local-rewrite').checked),
    aiRewriteEnabled: !!(el('lingya-security-ai-rewrite') && el('lingya-security-ai-rewrite').checked),
    aiRewriteViaChat: !!(el('lingya-security-ai-rewrite-via-chat') && el('lingya-security-ai-rewrite-via-chat').checked),
    aiEndpoint: el('lingya-security-ai-endpoint') ? el('lingya-security-ai-endpoint').value.trim() : '',
    aiModel: el('lingya-security-ai-model') ? el('lingya-security-ai-model').value.trim() : '',
    mockResponse: el('lingya-security-mock') ? el('lingya-security-mock').value : '',
  };
  // API Key：只有用户输入了新值才提交（留空 = 保留原值）
  const keyEl = el('lingya-security-ai-key');
  if (keyEl && keyEl.value) {
    patch.aiKey = keyEl.value;
  }
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
