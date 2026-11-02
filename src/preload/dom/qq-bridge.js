/**
 * QQ 同步：bridge 侧逻辑（运行在 AI 页面 preload）
 * 
 * 职责：
 *   1. 接收主进程转发的 QQ 来消息 → sendToChat 发给 AI
 *   2. 监听 AI 处理完成 → 上报给主进程 → 推送到 QQ
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
    if (!api || typeof api.qqReport !== 'function') return;
    api.qqReport(payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

let inited = false;

// 当前活动状态（供任务面板展示）：AI 生成 / 调工具
let currentActivity = '🧠 AI 正在生成…';

function initQqBridge() {
  if (inited) return;
  inited = true;

  // 启用门控
  let enabled = false;
  try {
    window.electronAPI.onQqMode((payload) => {
      enabled = !!(payload && payload.enabled);
    });
  } catch (_) {}
  try {
    // 【2026-11-01 修复】改用 getQqEnabled（走 qq-is-enabled，非敏感通道）。
    // 原来用 getQqConfig → qq-get-config 在 ipc-guard 白名单里，
    // AI 页面（https://chat.deepseek.com/）调用被拒 → enabled 恒为 false
    // → onInterceptedResponse 第一行 return → AI 回复不上报 → 不回传 QQ。
    if (window.electronAPI.getQqEnabled) {
      window.electronAPI.getQqEnabled().then((r) => {
        if (r) enabled = !!r.enabled;
      }).catch(() => {});
    }
  } catch (_) {}

  // 1. 接收 QQ 来消息 → 发给 AI
  try {
    window.electronAPI.onQqUserMessage((payload) => {
      const text = payload && payload.text;
      if (!text) return;
      sendToChat(text, 'QQ', 300).catch(() => {});
    });
  } catch (_) {}

  // 2. 用户消息上报
  onUserMessageSent((text, tag) => {
    if (!enabled || !text) return;
    const SYSTEM_TAGS = ['拒绝改写请求', '拒绝改写回传', '拒绝拦截', 'XML工具调用提示', 'CTF注入', 'QQ'];
    if (tag && SYSTEM_TAGS.indexOf(tag) !== -1) return;
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
    const hasTool = /```(?:lingya|javascript|js)/i.test(text);
    // 【2026-10-30】不再塞占位文本。空回复由主进程判断是否推送，避免「(本轮无文本)」垃圾消息。
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

  // 7. 任务计划面板：todo 每次变化推一条完整面板
  //    每次 todoWrite 都是「替换完整列表」语义，所以 change 事件本身就是「某一步状态变了」。
  //    推送粒度 = 步骤级（不按工具调用推），避免刷屏与超额。
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

  // 6. QQ /stop 命令 → 停止当前任务
  // 【2026-10-30 修复】channel-commands.js 发出的是 'lingya-stop-task'，
  // 但此前全项目没有任何监听器，导致 QQ/微信 的 /stop 完全无效（只有飞书能用）。
  try {
    window.electronAPI.onStopTask(() => {
      try {
        const { stopTask } = require('../overlay/events');
        if (typeof stopTask === 'function') stopTask(true);
      } catch (err) {
        console.error('[LingYa QQ] /stop 执行失败:', err.message);
      }
    });
  } catch (_) {}
}

module.exports = { initQqBridge, stripToolBlocks };
