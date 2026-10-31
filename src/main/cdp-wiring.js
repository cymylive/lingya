/**
 * CDP 接线层 —— 把 cdp-capture 抓到的事件经 IPC 推给隔离世界。
 *
 * 职责边界：
 *  - cdp-capture 只管抓（不关心怎么送）
 *  - 本模块负责：校验 provider 支持 → attach → 每个回调转成 IPC 消息
 *  - cdp-bridge（隔离世界）负责把 IPC 消息还原成 CustomEvent
 */
const { ipcMain } = require('electron');
const capture = require('./cdp-capture');

let providersRegistry = null;

/**
 * providers/index.js 导出的是 { providers: [...], getProvider, ... }，
 * provider 对象在 providers 数组里，不是以 id 为键的 map。
 */
function getProviders() {
  if (providersRegistry) return providersRegistry;
  try {
    const mod = require('../providers');
    providersRegistry = Array.isArray(mod && mod.providers) ? mod.providers : [];
  } catch (_) {
    providersRegistry = [];
  }
  return providersRegistry;
}

/**
 * 查询 provider 是否支持 CDP。
 * 规则：provider 必须存在且 useCdp === true。
 * 当前只有 deepseek 声明 useCdp: true。
 */
function isCdpSupported(providerId) {
  const list = getProviders();
  const provider = list.find((p) => p && p.id === providerId);
  if (!provider) return false;
  return provider.useCdp === true;
}

/**
 * 处理渲染进程的 enable 请求。
 * 校验通过后 attach，并把所有回调转成 IPC。
 */
async function handleEnable(event, args) {
  const providerId = args && args.providerId;
  if (!providerId) return { ok: false, error: 'missing providerId' };
  if (!isCdpSupported(providerId)) {
    return { ok: false, error: 'provider does not support CDP: ' + providerId };
  }
  const sender = event && event.sender;
  if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
    return { ok: false, error: 'sender unavailable' };
  }

  const send = (payload) => {
    try {
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
      sender.send('lingya-cdp-event', payload);
    } catch (err) {
      console.error('[LingYa][cdp-wiring] IPC 发送失败:', err && err.message);
    }
  };

  const handlers = {
    onStart: () => send({ kind: 'start', data: { provider: providerId, at: Date.now() } }),
    onUserMessage: (text) => send({ kind: 'userMessage', data: { text, at: Date.now() } }),
    onResponse: (parsed) => send({ kind: 'response', data: parsed }),
    // 【对齐 Cuckoo 2026-11-01】流式字节增量 → 估算 TPS
    onStream: (d) => send({ kind: 'stream', data: d || {} }),
    onHeaders: (obj) => send({ kind: 'headers', data: obj }),
    onInterrupted: (reason) => send({
      kind: 'interrupted',
      data: { text: '', reason: reason || 'unknown' },
    }),
  };

  const r = capture.attach(sender, providerId, handlers);
  if (!r.ok) return r;
  return { ok: true };
}

function install(ipcMainInstance) {
  const m = ipcMainInstance || ipcMain;
  if (!m || typeof m.handle !== 'function') return;
  m.handle('lingya-cdp-enable', async (event, args) => {
    try {
      return await handleEnable(event, args);
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });
  m.handle('lingya-cdp-disable', async (event) => {
    try {
      const sender = event && event.sender;
      if (sender) capture.detach(sender);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });
}

module.exports = {
  install,
  isCdpSupported,
  __test: {
    handleEnable,
  },
};
