/**
 * 微信 iLink 同步：bridge 侧逻辑（运行在 AI 页面 preload）
 * 
 * 职责：
 *   1. 接收主进程转发的微信来消息 → sendToChat 发给 AI
 *   2. 监听 AI 处理完成 → 上报给主进程 → 推送到微信
 */
const { onInterceptedResponse, onToolCall } = require('./intercept-observer');
const { sendToChat, onUserMessageSent } = require('./chat-input');
const { hasToolBlocks } = require('./js-detector');

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
    // 2026-11-05: 上报前还原占位符，让用户收到的推送是真词
    try {
      const { unredactText } = require('./redaction-filter');
      if (unredactText && payload && typeof payload.text === 'string') {
        payload = Object.assign({}, payload, { text: unredactText(payload.text) });
      }
    } catch (_) {}
    api.weixinReport(payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;

// 当前活动状态（供任务面板展示）：AI 生成 / 调工具
let currentActivity = '🧠 AI 正在生成…';

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
    // 2026-11-06: 会话导入不推送到 IM
    if (tag && String(tag).indexOf('导入历史') === 0) return;
    report({ type: 'user-message', text: text, tag: tag || '' });
  });

  // 3. AI 开始生成
  try {
    window.addEventListener(require('./evt-names').AI_START, () => {
      if (!enabled) return;
      currentActivity = '🧠 AI 正在生成…';
      report({ type: 'ai-start' });
    });
  } catch (_) {}

  // 4. AI 回复完成
  onInterceptedResponse((text, thinking) => {
    // thinking 可能与 text 同时存在，也可能只有 thinking（纯思考轮次）。
    if (!enabled) return;
    const clean = stripToolBlocks(text);
    const hasTool = hasToolBlocks(text);
    // 【2026-10-30】不再塞占位文本。空回复由主进程判断是否推送。
    report({ type: 'ai-reply', text: clean, hasTool: hasTool, thinking: String(thinking || '') });
    if (!hasTool) report({ type: 'task-done' });
  });

  // 5. 工具调用状态
  onToolCall((ev) => {
    if (!enabled || !ev) return;
    if (ev.phase === 'start') {
      currentActivity = '🔧 AI 正在调用工具' + (ev.toolName ? '：' + ev.toolName : '…');
      report({ type: 'tool-start', toolName: ev.toolName || '' });
    } else if (ev.phase === 'end') {
      currentActivity = '🧠 AI 正在生成…';
      report({ type: 'tool-end' });
    }
  });

  // 7. 任务计划面板：todo 每次变化推一条完整面板（与 QQ 通道同一格式）
  try {
    if (window.electronAPI && typeof window.electronAPI.onTodosUpdated === 'function') {
      window.electronAPI.onTodosUpdated((payload) => {
        if (!enabled) return;
        const todos = (payload && Array.isArray(payload.todos)) ? payload.todos : null;
        if (!todos || todos.length === 0) return;
        report({ type: 'todo-panel', todos: todos, activity: currentActivity });
      });
    }
  } catch (_) {}

  // 6. Weixin /stop 命令 → 停止当前任务
  // 【2026-10-30 修复】channel-commands.js 发出的是 'lingya-stop-task'，
  // 但此前全项目没有任何监听器，导致 QQ/微信 的 /stop 完全无效（只有飞书能用）。
  try {
    window.electronAPI.onStopTask(() => {
      try {
        const { stopTask } = require('../overlay/events');
        if (typeof stopTask === 'function') stopTask(true);
      } catch (err) {
        console.error('[LingYa Weixin] /stop 执行失败:', err.message);
      }
    });
  } catch (_) {}
}

module.exports = { initWeixinBridge, stripToolBlocks };
