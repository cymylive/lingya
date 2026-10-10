/**
 * 定时任务 bridge（运行在 AI 页面 preload）
 * 收到主进程 schedule-run → 先暂存，等 AI 回复完成（初始化 systemPrompt 已就绪）后，
 * 再把任务指令发给 AI，避免两条消息互相覆盖。
 *
 * 时序：runTask 先发 initial-prompt（systemPrompt）→ renderer 延迟 2-4 秒发送 →
 *       AI 回复"已就绪" → 本 bridge 监听到回复完成 → 发送任务指令。
 * 兜底：30 秒内若始终没有 AI 回复（初始化失败），也把任务发出去，避免任务丢失。
 */
const { sendToChat } = require('./chat-input');
const { onInterceptedResponse } = require('./intercept-observer');

let pendingTask = null;
let pendingTimer = null;

/** 发送暂存的任务指令 */
function flushTask() {
  if (!pendingTask) return;
  const t = pendingTask;
  pendingTask = null;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  const msg = '【定时任务】' + (t.name || '') + String.fromCharCode(10) + (t.prompt || '');
  console.log('[LingYa Schedule] 初始化就绪，发送任务指令:', t.name);
  sendToChat(msg, '定时任务', 500).then((ok) => {
    if (!ok) {
      try { window.electronAPI.scheduleReport({ name: t.name, ok: false, error: '发送失败（找不到输入框）' }); } catch (_) {}
    }
  }).catch((err) => {
    try { window.electronAPI.scheduleReport({ name: t.name, ok: false, error: err.message }); } catch (_) {}
  });
}

let inited = false;
function initScheduleBridge() {
  if (inited) return;
  inited = true;

  // 1. 监听 AI 回复完成 → 若有待发任务，稍等输入框空闲后发送
  try {
    onInterceptedResponse(() => {
      if (pendingTask) setTimeout(flushTask, 1200);
    });
  } catch (_) {}

  // 2. 接收主进程下发的定时任务
  try {
    window.electronAPI.onScheduleRun((payload) => {
      const prompt = payload && payload.prompt;
      if (!prompt) return;
      console.log('[LingYa Schedule] 收到定时任务，等待初始化完成:', payload.name);
      pendingTask = payload;
      if (pendingTimer) clearTimeout(pendingTimer);
      // 兜底：30 秒后无论如何都发（初始化可能没触发 AI 回复）
      pendingTimer = setTimeout(flushTask, 30000);
    });
  } catch (_) {}
}

module.exports = { initScheduleBridge };
