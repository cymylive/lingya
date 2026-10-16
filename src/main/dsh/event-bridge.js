/**
 * DSH 兼容层 - 事件桥（CommonJS）
 *
 * 把 LingYa 主进程的 AI 事件转成 DSH 标准事件名，广播给所有已加载的 DSH 插件。
 * 映射（对齐 cuckoo event-bridge）：
 *   stream         → agent/assistant-stream
 *   assistant-done → session/event + agent/turn-end
 *   task-idle      → agent/task-idle
 *   tool-start     → tool/call
 *   tool-end       → tool/result
 */
const { EventEmitter } = require('events');

// 活跃插件的 EventBus（每个已加载 DSH 插件一个）
const activeBuses = new Set();

function registerBus(bus) { activeBuses.add(bus); }
function unregisterBus(bus) { activeBuses.delete(bus); }

/** 向所有活跃插件广播一个 DSH 事件 */
function broadcastDshEvent(event, ...args) {
  for (const bus of activeBuses) {
    try { bus.emit(event, ...args); } catch (_) {}
  }
}

/** 把主进程的 payload 转成 DSH 事件并广播 */
function dispatchHarnessPayload(payload) {
  if (!payload || typeof payload.type !== 'string') return;
  switch (payload.type) {
    case 'stream':
      broadcastDshEvent('agent/assistant-stream', {
        frame: { think: payload.think || '', text: payload.text || '', finished: !!payload.finished },
      });
      break;
    case 'assistant-done':
      broadcastDshEvent('session/event', { type: 'assistant/message', text: payload.text || '' });
      broadcastDshEvent('agent/turn-end', { text: payload.text || '' });
      break;
    case 'task-idle':
      broadcastDshEvent('agent/task-idle', {});
      break;
    case 'tool-start':
      broadcastDshEvent('tool/call', { code: payload.code || '' });
      break;
    case 'tool-end':
      broadcastDshEvent('tool/result', {
        code: payload.code || '', success: !!payload.success,
        output: payload.output || '', error: payload.error || '',
      });
      break;
    case 'ai-state':
      broadcastDshEvent('agent/state', { generating: !!payload.generating });
      break;
    default:
      break;
  }
}

module.exports = { registerBus, unregisterBus, broadcastDshEvent, dispatchHarnessPayload, activeBuses };
