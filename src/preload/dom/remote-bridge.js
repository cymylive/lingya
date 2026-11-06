/**
 * 手机远程控制：bridge 侧逻辑（运行在 AI 页面 preload）
 *
 * 职责：
 *   1. 监听 AI 事件（流式/工具/回复/开始/停止）→ 上报主进程 → 转发给已连接的手机
 *   2. 接收主进程转发的手机消息 → sendToChat 发给 AI
 *
 * 与 feishu/qq/weixin-bridge 同构：上报前 unredact。
 * 门控：不做启用门控——上报走 electronAPI.remoteReport 同步 send（fire-and-forget），
 *   主进程 broadcastAiEvent 在 remoteServer 为 null 时立即 return，几乎零开销。
 *   这样避免额外引入 onRemoteMode/getRemoteEnabled IPC 通道。
 *
 * 数据流：
 *   hook（主世界） --AI_STREAM/AI_START/AI_RESPONSE--> intercept-observer --> remote-bridge
 *   remote-bridge --electronAPI.remoteReport--> 主进程 remote-ipc --manager.broadcastAiEvent--> 手机
 *   手机 --ws user-message--> server --manager.onUserMessage--> view.webContents.send('remote-user-message')
 *   AI 页面 --onRemoteUserMessage--> sendToChat --> AI
 */
const { onInterceptedResponse, onToolCall, onStream } = require('./intercept-observer');
const { sendToChat, onUserMessageSent } = require('./chat-input');
const { hasToolBlocks } = require('./js-detector');

/** 移除文本中的 lingya/js 工具代码块（工具调用另行上报，手机端只显示对话正文） */
function stripToolBlocks(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(/\`\`\`(?:lingya|javascript|js)\s*\n[\s\S]*?\`\`\`/gi, '');
  out = out.replace(/\`\`\`(?:lingya|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/\`\`\`(?:lingya|javascript|js)\s*$/gi, '');
  return out.trim();
}

function report(payload) {
  try {
    const api = window.electronAPI;
    if (!api || typeof api.remoteReport !== 'function') return;
    try {
      const { unredactText } = require('./redaction-filter');
      if (unredactText && payload) {
        if (typeof payload.text === 'string') {
          payload = Object.assign({}, payload, { text: unredactText(payload.text) });
        }
        if (payload.data) {
          const d = payload.data;
          if (typeof d.text === 'string') d.text = unredactText(d.text);
          if (typeof d.full === 'string') d.full = unredactText(d.full);
        }
      }
    } catch (_) {}
    api.remoteReport(payload);
  } catch (_) { /* ignore */ }
}

let inited = false;

function initRemoteBridge() {
  if (inited) return;
  inited = true;

  // 1. 用户消息上报（经灵鸦发送的）→ 手机端回显
  onUserMessageSent((text, tag) => {
    if (!text) return;
    const SYSTEM_TAGS = ['拒绝改写请求', '拒绝改写回传', '拒绝检测', 'XML工具调用提示', '脱敏', '飞书', 'QQ', '微信'];
    if (tag && SYSTEM_TAGS.indexOf(tag) !== -1) return;
    if (tag && String(tag).indexOf('导入历史') === 0) return;
    report({ type: 'user-message', text: text, tag: tag || '' });
  });

  // 2. AI 流式（全量快照，由 provider hook 80ms 节流）
  try {
    onStream((detail) => {
      if (!detail) return;
      if (detail.finished) return;
      const text = String(detail.text || '');
      const think = String(detail.think || '');
      if (!text && !think) return;
      report({
        type: 'stream',
        kind: 'stream',
        data: { full: text, think: think },
      });
    });
  } catch (_) {}

  // 3. AI 回复完成
  onInterceptedResponse((text, thinking) => {
    const clean = stripToolBlocks(text);
    const hasTools = hasToolBlocks(text);
    report({
      type: 'ai-reply',
      kind: 'ai-reply',
      data: {
        text: clean || '',
        thinking: String(thinking || ''),
        hasTools: hasTools,
      },
    });
  });

  // 4. 工具调用 start/end
  try {
    onToolCall((ev) => {
      if (!ev) return;
      if (ev.phase === 'start') {
        report({ type: 'tool', kind: 'tool-start', data: { name: ev.toolName || '' } });
      } else if (ev.phase === 'end') {
        report({ type: 'tool', kind: 'tool-end', data: { name: ev.toolName || '' } });
      }
    });
  } catch (_) {}

  // 5. 手机消息 → sendToChat
  try {
    if (typeof window.electronAPI.onRemoteUserMessage === 'function') {
      window.electronAPI.onRemoteUserMessage((payload) => {
        const text = payload && payload.text;
        if (!text) return;
        sendToChat(text, '手机', 300).catch(() => {});
      });
    }
  } catch (_) {}
}

module.exports = { initRemoteBridge, stripToolBlocks };
