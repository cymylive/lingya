/**
 * 飞书同步：bridge 侧逻辑（运行在 AI 页面 preload）
 *
 * 职责：
 *   1. 监听"用户消息已发出" → 上报主进程 → 飞书推送
 *   2. 监听 AI 回复完成 → 上报（剥离工具代码块）
 *   3. 监听工具调用（start/end）→ 上报（仅状态）
 *   4. 接收主进程转发的飞书来消息 → sendToChat 发给 AI
 *
 * 门控：主进程切换飞书启用状态时通知（enabled=false 时各回调立即返回，零开销）。
 *
 * 移植自 cuckoo-code src/bridge/feishu-bridge.ts。
 */
const { onInterceptedResponse, onToolCall } = require('./intercept-observer');
const { sendToChat, onUserMessageSent } = require('./chat-input');

/** 移除文本中的 lingya/js 工具代码块（工具调用另行上报，飞书只显示对话） */
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
    if (!api || typeof api.feishuReport !== 'function') return;
    api.feishuReport(payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;
function initFeishuBridge() {
  if (inited) return;
  inited = true;

  // 启用门控（主进程下发 + 初始化时主动查询，避免错过广播）
  let enabled = false;
  try {
    window.electronAPI.onFeishuMode((payload) => {
      enabled = !!(payload && payload.enabled);
    });
  } catch (_) {}
  try {
    if (window.electronAPI.getFeishuEnabled) {
      window.electronAPI.getFeishuEnabled().then((r) => {
        if (r) enabled = !!r.enabled;
      }).catch(() => {});
    }
  } catch (_) {}

  // 1. 用户消息（经 LingYa 发送）→ 上报
  onUserMessageSent((text, tag) => {
    if (!enabled || !text) return;
    // 系统消息（自动续写/拒绝改写/工具结果回传等）不上报
    const SYSTEM_TAGS = ['自动续写', '拒绝改写请求', '拒绝改写回传', '拒绝拦截', 'XML工具调用提示', 'CTF注入', '飞书'];
    if (tag && SYSTEM_TAGS.indexOf(tag) !== -1) return;
    report({ type: 'user-message', text: text, tag: tag || '' });
  });

  // 1b. AI 开始生成 → 上报（手机能看到"进行中"，而非只看到最后一条）
  try {
    window.addEventListener('lingya-ai-start', () => {
      if (!enabled) return;
      report({ type: 'ai-start' });
    });
  } catch (_) {}

  // 2. AI 回复完成 → 上报（剥离工具代码块，飞书只看对话）
  // hasTool=true 表示这轮还要继续调工具，主进程据此判断任务是否真的收尾
  onInterceptedResponse((text) => {
    if (!enabled || !text) return;
    const clean = stripToolBlocks(text);
    const hasTool = /\`\`\`(?:lingya|javascript|js)/i.test(text);
    report({ type: 'ai-reply', text: clean || '(本轮无文本，继续执行工具)', hasTool: hasTool });
    // 无后续工具 → 任务收尾，单独上报"完成"标志
    if (!hasTool) report({ type: 'task-done' });
  });

  // 3. 工具调用状态 → 上报（仅状态；工具名是否带上由主进程按配置决定）
  onToolCall((ev) => {
    if (!enabled || !ev) return;
    if (ev.phase === 'start') report({ type: 'tool-start', toolName: ev.toolName || '' });
    else if (ev.phase === 'end') report({ type: 'tool-end' });
  });

  // 4. 飞书来消息 → 主进程转发到此 → 发给 AI
  try {
    window.electronAPI.onFeishuUserMessage((payload) => {
      const text = payload && payload.text;
      if (!text) return;
      sendToChat(text, '飞书', 300).catch(() => {});
    });
  } catch (_) {}

  // 5. 飞书 /stop 命令 → 停止当前任务（复用面板「停止」按钮的同一逻辑）
  try {
    window.electronAPI.onFeishuStop(() => {
      try {
        const { stopTask } = require('../overlay/events');
        if (typeof stopTask === 'function') stopTask(true);
      } catch (err) {
        console.error('[LingYa Feishu] /stop 执行失败:', err.message);
      }
    });
  } catch (_) {}
}

module.exports = { initFeishuBridge, stripToolBlocks };
