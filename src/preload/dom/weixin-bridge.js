/**
 * 微信 iLink 同步：bridge 侧逻辑（运行在 AI 页面 preload）
 * 
 * 职责：
 *   1. 接收主进程转发的微信来消息 → sendToChat 发给 AI
 *   2. 监听 AI 处理完成 → 上报给主进程 → 推送到微信
 */
const { onInterceptedResponse, onToolCall } = require('./intercept-observer');
const { sendToChat, onUserMessageSent } = require('./chat-input');

/** 移除文本中的 lingya/js 工具代码块（工具调用另行上报） */
function stripToolBlocks(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*?```/gi, '');
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```(?:lingya|javascript|js)\s*$/gi, '');
  return out.trim();
}

function report(payload) {
  try {
    const api = window.electronAPI;
    if (!api || typeof api.weixinReport !== 'function') return;
    api.weixinReport(payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;
function initWeixinBridge() {
  if (inited) return;
  inited = true;

  // 启用门控
  let enabled = false;
  try {
    window.electronAPI.onWeixinMode((payload) => {
      enabled = !!(payload && payload.enabled);
    });
  } catch (_) {}
  try {
    if (window.electronAPI.getWeixinEnabled) {
      window.electronAPI.getWeixinEnabled().then((r) => {
        if (r) enabled = !!r.enabled;
      }).catch(() => {});
    }
  } catch (_) {}

  // 1. 接收微信来消息 → 发给 AI
  try {
    window.electronAPI.onWeixinUserMessage((payload) => {
      const text = payload && payload.text;
      if (!text) return;
      sendToChat(text, '微信', 300).catch(() => {});
    });
  } catch (_) {}

  // 2. 用户消息上报
  onUserMessageSent((text, tag) => {
    if (!enabled || !text) return;
    const SYSTEM_TAGS = ['拒绝改写请求', '拒绝改写回传', '拒绝拦截', 'XML工具调用提示', 'CTF注入', '微信'];
    if (tag && SYSTEM_TAGS.indexOf(tag) !== -1) return;
    report({ type: 'user-message', text: text, tag: tag || '' });
  });

  // 3. AI 开始生成
  try {
    window.addEventListener('lingya-ai-start', () => {
      if (!enabled) return;
      report({ type: 'ai-start' });
    });
  } catch (_) {}

  // 4. AI 回复完成
  onInterceptedResponse((text) => {
    if (!enabled || !text) return;
    const clean = stripToolBlocks(text);
    const hasTool = /```(?:lingya|javascript|js)/i.test(text);
    report({ type: 'ai-reply', text: clean || '(本轮无文本，继续执行工具)', hasTool: hasTool });
    if (!hasTool) report({ type: 'task-done' });
  });

  // 5. 工具调用状态
  onToolCall((ev) => {
    if (!enabled || !ev) return;
    if (ev.phase === 'start') report({ type: 'tool-start', toolName: ev.toolName || '' });
    else if (ev.phase === 'end') report({ type: 'tool-end' });
  });
}

module.exports = { initWeixinBridge, stripToolBlocks };
