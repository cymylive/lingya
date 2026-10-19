/**
 * 聊天输入框交互：查找输入框、填入与发送消息、工具结果回传
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { ipcRenderer } = require('electron');
const state = require('./state');
const { BT } = require('./js-detector');
const { getProviderByUrl } = require('../../../src/providers');

/**
 * 根据当前 URL 获取 provider
 */
function getCurrentProvider() {
  return getProviderByUrl(window.location.href);
}

/**
 * 首条消息兜底延迟（ms）：尚无 AI 思考历史时使用。
 * 后续消息一律走「思考耗时自适应延迟」。
 */
function initialDelay() {
  const d = Number(state.initialSendDelay);
  return (Number.isFinite(d) && d >= 0) ? d : 1000;
}
// 启动时从 localStorage 恢复「思考耗时自适应延迟」配置
(function restoreThinkDelayConfig() {
  try {
    const init = localStorage.getItem('lingya-initial-send-delay');
    if (init !== null) {
      const n = parseInt(init, 10);
      if (Number.isFinite(n) && n >= 0) state.initialSendDelay = n;
    }
    const r = localStorage.getItem('lingya-think-ratio');
    const m = localStorage.getItem('lingya-think-max-delay');
    if (r !== null) {
      const n = parseFloat(r);
      if (Number.isFinite(n) && n >= 0) state.thinkRatio = n;
    }
    if (m !== null) {
      const n = parseInt(m, 10);
      if (Number.isFinite(n) && n >= 0) state.thinkMaxDelay = n;
    }
  } catch (_) { /* ignore */ }
})();

/**
 * 计算「思考耗时自适应延迟」（毫秒）。
 * 规则：延迟 = min(上次思考耗时 × thinkRatio, thinkMaxDelay)。
 * 思考越久说明负载越重，下一条就等越久，从根源避开频率风控。
 * 无历史（首次发送）时返回 0，由调用方回落到随机基础延迟。
 */
function computeThinkAdaptiveDelay() {
  const ratio = Number(state.thinkRatio) || 0;
  const maxDelay = Number(state.thinkMaxDelay) || 0;
  const thinkMs = Number(state.lastThinkMs) || 0;
  if (ratio <= 0 || thinkMs <= 0) return 0;
  const d = Math.floor(thinkMs * ratio);
  return maxDelay > 0 ? Math.min(d, maxDelay) : d;
}

/**
 * 将文本填入输入框（React 兼容：使用原生 value setter）
 * @param {Element} input - 输入框元素
 * @param {string} msg - 要填入的文本
 * @returns {boolean} 是否成功填入
 */
async function setInputContent(input, msg) {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeSetter.call(input, msg);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // 分段 Paste：每段 ≤6000 字符，不会触发 ChatGPT 的附件行为，且每段都很快。
      // 实测 12000 字符只需约 350ms。
      const CHUNK_SIZE = 6000;
      for (let i = 0; i < msg.length; i += CHUNK_SIZE) {
        const chunk = msg.slice(i, i + CHUNK_SIZE);
        const dt = new DataTransfer();
        dt.setData('text/plain', chunk);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        input.dispatchEvent(pasteEvent);
        if (i + CHUNK_SIZE < msg.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('[LingYa] 设置输入框内容失败:', err.message);
    return false;
  }
}
/**
 * 将消息填入当前可见输入框并按指定延迟触发发送
 * @param {string} msg - 要发送的消息
 * @param {string} [tag] - 日志标记
 * @param {number} [fixedDelay] - 固定延迟毫秒数；缺省时使用 initialDelay()
 * @param {Function} [afterSent] - 发送后回调
 * @returns {boolean} 是否成功
 */
// 用户消息已发出回调（供飞书同步等订阅；系统消息 tag 由订阅方自行过滤）
let onUserMessageSentCb = null;

/**
 * 注册"用户消息已发出"监听器
 * @param {Function} cb 参数 (text, tag)
 * @returns {Function} 取消注册
 */
function onUserMessageSent(cb) {
  onUserMessageSentCb = cb;
  return () => { if (onUserMessageSentCb === cb) onUserMessageSentCb = null; };
}

async function sendToChat(msg, tag, fixedDelay, afterSent) {
  state.touch(); // 发消息 = 有活动
  // 用户主动发消息：清除「已停止」状态，恢复正常自动执行
  if (state.stopped) {
    state.stopped = false;
    try { window.electronAPI.clearAbort(); } catch (_) {}
    try {
      const { setStopped } = require('../overlay/ui');
      if (setStopped) setStopped(false);
    } catch (_) {}
  }
  // 输入框可能因页面重渲染短暂消失：重试几次，避免回传静默丢失导致 Agent 循环永久停住
  let input = findInputArea();
  for (let i = 0; !input && i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    input = findInputArea();
  }
  if (!input) {
    console.log('[LingYa] 找不到输入框，无法发送消息（重试 5 次后放弃）');
    try {
      const { showToast } = require('../overlay/ui');
      if (showToast) showToast('⚠️ 无法回传结果：找不到输入框，请手动发一条消息恢复', 5000);
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!(await setInputContent(input, msg))) {
    return false;
  }
  // 思考耗时自适应延迟：上次 AI 思考越久，这次等越久（比例与上限可配）。
  // 每轮独立：只看紧邻的上一次请求往返耗时，不累加、不继承历史最长。
  const adaptiveDelay = computeThinkAdaptiveDelay();
  console.log('[LingYa][诊断] 计算延迟时 state.thinkRatio=' + state.thinkRatio + '，lastThinkMs=' + state.lastThinkMs);
  const fallbackDelay = fixedDelay !== undefined ? fixedDelay : initialDelay();
  const sendDelay = Math.max(fallbackDelay, adaptiveDelay);
  if (adaptiveDelay > fallbackDelay) {
    console.log('[LingYa] 思考自适应延迟生效：上次思考 ' + state.lastThinkMs + 'ms × ' +
      state.thinkRatio + ' = ' + adaptiveDelay + 'ms（上限 ' + state.thinkMaxDelay + 'ms）');
  }
  console.log('[LingYa] 消息已填入输入框，等待 ' + sendDelay + 'ms 后发送（兜底 ' + fallbackDelay + '，自适应 ' + adaptiveDelay + '）...');
  setTimeout(function() {
    // 延迟期间用户点了停止：取消本次发送
    if (state.stopped) {
      console.log('[LingYa] 已停止，取消本次延迟发送');
      return;
    }
    console.log('[LingYa] 等待结束，开始触发发送');
    triggerSend(input);
    // 记录本次请求发出时刻，供 intercept-observer 计算思考耗时
    state.lastRequestStartAt = Date.now();
    console.log('[LingYa] 已触发发送, ' + (tag || '') + ', 长度=' + msg.length);
    if (onUserMessageSentCb) { try { onUserMessageSentCb(msg, tag); } catch (_) {} }
    if (typeof afterSent === 'function') afterSent();
  }, sendDelay);
  return true;
}
/**
 * 将消息填入 DeepSeek 聊天输入框并触发发送（工具结果回传的公共实现）
 */
function sendMessageToChat(msg, tag) {
  return sendToChat(msg, tag);
}
/**
 * 将 JSON 工具执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendToolResultToChat(toolCall, result) {
  // 构造回传消息（明确的成功/失败信息，AI 可据此修正并继续）
  let msg;
  if (result.success) {
    const data = result.data || {};
    // 大内容截断保护（20KB），避免超长消息
    if (typeof data.content === 'string' && data.content.length > 20000) {
      data.content = data.content.substring(0, 20000) + String.fromCharCode(10) + '...[内容过长已截断]...';
    }
    msg = '【工具执行结果】' + toolCall.toolName + ' 执行成功 (callId: ' + (toolCall.callId || '') + ')' + String.fromCharCode(10) +
      JSON.stringify(data, null, 2);
  } else {
    msg = '【工具执行结果】' + toolCall.toolName + ' 执行失败 (callId: ' + (toolCall.callId || '') + ')' + String.fromCharCode(10) +
      '错误原因: ' + (result.error || '未知错误') + String.fromCharCode(10) +
      '请根据错误原因修正参数后重新调用工具。';
  }

  console.log('[LingYa] 回传工具结果, 消息长度=' + msg.length);
  sendMessageToChat(msg, '工具=' + toolCall.toolName);
}
/**
 * 将 JS 工具脚本执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendCombinedJsResultsToChat(results) {
  if (!Array.isArray(results) || results.length === 0) return;

  const MAX_OUTPUT = 15000;
  const sep = String.fromCharCode(10);

  let msg = '【JS 执行结果汇总】(共 ' + results.length + ' 个脚本)' + sep + sep;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    msg += '—— 脚本 ' + (i + 1) + ' ——' + sep;
    if (item && item.result && item.result.success) {
      let out = (item.result.output || '').trim();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + sep + '...[输出过长已截断]...';
      }
      msg += '✅ 成功' + sep + (out || '(脚本执行完成，无输出)');
    } else {
      msg += '❌ 失败' + sep + '错误原因: ' + ((item && item.result && item.result.error) || '未知错误') + sep;
      msg += '本次实际执行的代码(前300字符):' + sep + String((item && item.code) || '').slice(0, 300) + sep;
      msg += '请修正 JavaScript 代码后重新输出完整的 ' + BT + BT + BT + 'lingya 代码块。';
    }
    msg += sep + sep;
  }

  // 收集所有脚本产出的图片
  const allImages = [];
  for (const item of results) {
    if (item && item.result && Array.isArray(item.result.images) && item.result.images.length > 0) {
      allImages.push(...item.result.images);
    }
  }
  if (allImages.length > 0) {
    msg += sep + '（已附上 ' + allImages.length + ' 张图片，请查看图片内容后继续。）';
  }

  console.log('[LingYa] 回传 JS 汇总执行结果, 消息长度=' + msg.length + ', 图片=' + allImages.length);
  // 先填文本（sendToChat 内部会 selectAll+delete 清空输入框），再注入图片附件；
  // 文本发送有 2-4s 延迟，注入的附件会在发送前附着。
  sendMessageToChat(msg, 'JS汇总');
  if (allImages.length > 0) {
    injectImagesToInput(allImages);
  }
}
/**
 * 将图片作为附件注入聊天输入框（通过 paste 事件携带 File 对象）。
 * 浏览器/站点会把 File 识别为图片附件。返回成功注入的数量。
 * @param {Array<{name:string, mime:string, base64:string}>} images
 * @returns {number} 成功注入的图片数
 */
function injectImagesToInput(images) {
  if (!Array.isArray(images) || images.length === 0) return 0;
  const input = findInputArea();
  if (!input) {
    console.log('[LingYa] 找不到输入框，无法注入图片');
    return 0;
  }
  input.focus();
  let count = 0;
  for (const img of images) {
    try {
      const bin = atob(img.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], img.name || 'image.png', { type: img.mime || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      input.dispatchEvent(evt);
      count++;
      console.log('[LingYa] 已注入图片附件: ' + file.name + ' (' + bytes.length + ' bytes)');
    } catch (err) {
      console.error('[LingYa] 注入图片失败: ' + err.message);
    }
  }
  return count;
}

/**
 * 查找 DeepSeek 的输入框元素
 */
function findInputArea() {
  const provider = getCurrentProvider();
  if (provider && typeof provider.findInput === 'function') {
    const el = provider.findInput();
    if (el) return el;
  }

  // 通用兜底：找所有可见 textarea
  const allTextareas = document.querySelectorAll('textarea');
  for (const ta of allTextareas) {
    if (isInputVisible(ta)) return ta;
  }
  // 再找 contenteditable 或 textbox
  const editable = document.querySelector('div[contenteditable="true"], [role="textbox"]');
  if (editable && isInputVisible(editable)) return editable;

  return null;
}
/**
 * 检查元素是否可见
 */
function isInputVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
/**
 * 发送初始提示（目录树+systemPrompt）到输入框
 */
async function sendInitialPromptToInput() {
  if (!state.initialPromptContent) {
    state.pendingInitialPrompt = false;
    return false;
  }

  const input = findInputArea();
  if (!input) {
    return false;
  }

  if (!(await setInputContent(input, state.initialPromptContent))) {
    return false;
  }

  const sendDelay = initialDelay();
  console.log('[LingYa] 初始提示已填入，等待 ' + sendDelay + 'ms 后发送...');
  setTimeout(function() {
    if (state.stopped) {
      console.log('[LingYa] 已停止，取消初始提示发送');
      state.pendingInitialPrompt = false;
      return;
    }
    console.log('[LingYa] 等待结束，开始发送初始提示');
    triggerSend(input);
    state.pendingInitialPrompt = false;
  }, sendDelay);

  return true;
}
/**
 * 等待输入框出现后再发送初始提示
 */
function waitForInitialPromptAndSend() {
  let attempts = 0;
  const maxAttempts = 30;
  console.log('[' + new Date().toISOString() + '] [LingYa] 开始等待输入框出现（最多 ' + maxAttempts + ' 次，每次 500ms）');

  const checkInterval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(checkInterval);
      state.pendingInitialPrompt = false;
      console.log('[' + new Date().toISOString() + '] [LingYa] 等待输入框超时，放弃发送初始提示');
      return;
    }

    const found = !!findInputArea();
    if (attempts === 1 || attempts % 5 === 0 || found) {
      console.log('[' + new Date().toISOString() + '] [LingYa] 等待输入框第 ' + attempts + ' 次检查, 输入框=' + (found ? '找到' : '未找到'));
    }
    if (found) {
      clearInterval(checkInterval);
      sendInitialPromptToInput();
    }
  }, 500);
}
/**
 * 触发发送消息
 */
function triggerSend(input) {
  const provider = getCurrentProvider();

  // 方法 0: 站点原生发送（智谱等免疫合成事件的平台，经主进程注入真实级输入）
  if (provider && typeof provider.triggerSend === 'function') {
    let result = null;
    try { result = provider.triggerSend(input); } catch (_) { /* 站点实现异常时回退通用逻辑 */ }
    if (result && typeof result.then === 'function') {
      result.then(function (ok) {
        if (ok) {
          console.log('[LingYa] 已通过站点原生发送触发');
        } else {
          fallbackSend(provider, input);
        }
      }).catch(function () { fallbackSend(provider, input); });
      return;
    }
    if (result) {
      console.log('[LingYa] 已通过站点原生发送触发');
      return;
    }
  }

  fallbackSend(provider, input);
}

/**
 * 通用发送兜底：查找发送按钮点击，或模拟 Enter 按键序列
 */
function fallbackSend(provider, input) {
  // 方法 1: 调用平台 Provider 查找发送按钮
  if (provider && typeof provider.findSendButton === 'function') {
    const btn = provider.findSendButton();
    if (btn) {
      btn.click();
      console.log('[LingYa] 已点击发送按钮');
      return;
    }
  }

  // 方法 2: 在输入框上模拟完整 Enter 按键序列（keydown + keypress + keyup）
  if (input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
    console.log('[LingYa] 已通过 Enter 键触发发送 (未找到发送按钮)');
  }
}
/**
 * 注册主进程消息监听（initial-prompt）
 * 与原 preload.js 顶层注册时机一致：preload 入口加载时同步调用。
 */
function registerIpcListeners() {
// 监听主进程发送的初始提示
// 侧边栏「插入」→ 把文本填进输入框（不自动发送）
// 侧边栏「动作」→ 在 AI 视图侧执行（生成文档/沉浸式/停止/压缩/手动解析/导出）
ipcRenderer.on('lingya-set-setting', (_event, payload) => {
  try {
    const k = (payload && payload.key) || '';
    const v = payload && payload.value;
    if (!k) return;
    if (k === 'auto-inject') { localStorage.setItem('lingya-auto-inject', v ? '1' : '0'); }
    else if (k === 'auto-rename-enabled') { localStorage.setItem('lingya-auto-rename-enabled', v ? '1' : '0'); }
    else if (k === 'initial-send-delay') { localStorage.setItem('lingya-initial-send-delay', String(v)); state.initialSendDelay = Number(v); }
    else if (k === 'think-ratio') { localStorage.setItem('lingya-think-ratio', String(v)); state.thinkRatio = Number(v); console.log('[LingYa] 配置已更新 thinkRatio=' + state.thinkRatio + '（IPC 生效）'); }
    else if (k === 'think-max-delay') { localStorage.setItem('lingya-think-max-delay', String(v)); state.thinkMaxDelay = Number(v); console.log('[LingYa] 配置已更新 thinkMaxDelay=' + state.thinkMaxDelay + '（IPC 生效）'); }
    else if (k === 'auto-compact-enabled') { localStorage.setItem('lingya-auto-compact-enabled', v ? '1' : '0'); }
    else if (k === 'auto-compact-threshold') { localStorage.setItem('lingya-auto-compact-threshold', String(v)); }
    else if (k === 'hide-floating') { localStorage.setItem('lingya-hide-floating', v ? '1' : '0'); try { require('../overlay/ui').applyFloatSettings(); } catch (_) {} }
    else if (k === 'hide-plan-float') { localStorage.setItem('lingya-hide-plan-float', v ? '1' : '0'); try { require('../overlay/ui').applyFloatSettings(); } catch (_) {} }
  } catch (e) { console.error('[LingYa] set-setting 失败:', e.message); }
});

ipcRenderer.on('lingya-run-action', async (_event, payload) => {
  const a = (payload && payload.action) || '';
  try {
    if (a === 'gen-doc') {
      await sendToChat('根据当前项目生成一个类似 claude.md 的项目说明文件，并将文件放到当前项目 .lingyaCode/LINGYA.md', '生成文档', 300);
    } else if (a === 'immersive') {
      await sendToChat('现在你的任何疑问,或没有疑问的选择都需要和我确认 , 确认的方式是 你问一个问题我回答一个问题,然后你再问下一个问题, 最好给我选项, 也要给我个其他的选项, 谢谢 爱你哦', '沉浸式交流', 300);
    } else if (a === 'ai-rename') {
      // 让 AI 回顾完整上下文，用 nameConversation 给本对话重新命名
      const prompt = [
        '请回顾本次对话的**完整上下文**（包括所有历史消息与工具执行结果），提炼这次对话真正在做的核心工作，',
        '然后**只调用一次** nameConversation(title) 工具，给本次对话起一个准确的中文标题（≤20 字）。',
        '',
        '要求：',
        '1. 标题要体现对话的**实际核心内容**，不要用"你好""继续"这类开场词，也不要用最后一条消息的主题代替整体。',
        '2. 直接调用工具，不要输出计划、不要解释、不要做任何其他操作。',
        '3. 调用完只回复一句"已重命名为：<标题>"即可。',
      ].join('\n');
      await sendToChat(prompt, 'AI重命名', 300);
    } else if (a === 'stop') {
      const ev = require('../overlay/events'); if (ev.stopTask) await ev.stopTask(false);
    } else if (a === 'compact') {
      const cp = require('./compaction'); if (cp.runCompaction) await cp.runCompaction();
    } else if (a === 'manual-parse') {
      const io = require('./intercept-observer');
      const text = io.getLastInterceptedText ? io.getLastInterceptedText() : null;
      if (text && io.processInterceptedResponse) await io.processInterceptedResponse(text, true);
    } else if (a === 'clear-history') {
      try { const { commandHistory } = require('../overlay/ui'); if (commandHistory) commandHistory.length = 0; const ui = require('../overlay/ui'); if (ui.renderHistory) ui.renderHistory(); } catch (_) {}
    } else if (a === 'export-md') {
      const log = require('./conversation-log');
      const cnt = log.getCount ? log.getCount() : 0;
      if (cnt === 0) { try { const { showToast } = require('../overlay/ui'); showToast('本窗口尚无对话记录', 3000); } catch (_) {} return; }
      const md = log.exportMarkdown ? log.exportMarkdown() : '';
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const nm = 'lingya-conversation-' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.md';
      await ipcRenderer.invoke('conversation-export-md', { markdown: md, suggestedName: nm });
    }
  } catch (e) { console.error('[LingYa] run-action 失败:', e.message); }
});

ipcRenderer.on('lingya-insert-to-chat', async (_event, payload) => {
  try {
    const p = payload || {};
    const text = String(p.text || '');
    if (!text) return;
    let input = findInputArea();
    for (let i = 0; !input && i < 5; i++) { await new Promise(r => setTimeout(r, 300)); input = findInputArea(); }
    if (!input) { try { const { showToast } = require('../overlay/ui'); showToast('未找到输入框', 3000); } catch (_) {} return; }
    await setInputContent(input, text);
    try { const { showToast } = require('../overlay/ui'); showToast('已插入', 1500); } catch (_) {}
  } catch (e) { console.error('[LingYa] insert-to-chat 失败:', e.message); }
});

ipcRenderer.on('initial-prompt', (_event, content) => {
  console.log('[' + new Date().toISOString() + '] [LingYa] 收到 initial-prompt 事件, content长度=' + (content || '').length);
  state.initialPromptContent = content || '';
  state.pendingInitialPrompt = true;
  // 如果当前已有新的空会话输入框，立即发送
  if (state.pendingInitialPrompt && state.initialPromptContent) {
    try {
      const input = findInputArea();
      console.log('[' + new Date().toISOString() + '] [LingYa] 首次查找输入框结果=' + (input ? '找到' : '未找到'));
      if (input) {
        sendInitialPromptToInput();
      } else {
        // 等待输入框出现
        waitForInitialPromptAndSend();
      }
    } catch (e) {
      console.error('[' + new Date().toISOString() + '] [LingYa] initial-prompt 处理异常:', e.message);
    }
  }
});
}


module.exports = {
  initialDelay,
  setInputContent,
  sendToChat,
  sendMessageToChat,
  sendToolResultToChat,
  sendCombinedJsResultsToChat,
  injectImagesToInput,
  findInputArea,
  isInputVisible,
  sendInitialPromptToInput,
  waitForInitialPromptAndSend,
  triggerSend,
  registerIpcListeners,
  onUserMessageSent,
};
