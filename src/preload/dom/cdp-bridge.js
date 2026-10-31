/**
 * CDP 桥 —— 隔离世界侧。
 *
 * 主进程 cdp-capture 抓到事件后，经 IPC 'lingya-cdp-event' 推过来；
 * 这里把它转成与页面内 hook **完全同构**的 CustomEvent。
 *
 * 为什么同构：intercept-observer / feishu-bridge / conversation-log /
 * compaction 等 5 个下游模块都监听 lingya-ai-response 等事件，
 * 只要事件名和 detail 结构一致，它们一行都不用改。
 *
 * 【重要】本模块不 require electron —— 单测在纯 Node 环境跑。
 * install() 才真正去 require('electron').ipcRenderer。
 */

function buildEvent(fakeWindow, type, detail) {
  // 优先用真 CustomEvent（浏览器环境）；
  // 单测环境没有 CustomEvent 时退化为普通对象，结构一致即可。
  let ev;
  try {
    if (typeof CustomEvent === 'function') {
      ev = new CustomEvent(type, { detail });
    } else {
      ev = { type, detail };
    }
  } catch (_) {
    ev = { type, detail };
  }
  return ev;
}

/**
 * 把一条 IPC payload 翻译成一个 CustomEvent 并派发。
 * 导出在 __test 下供单测直接用，不需要 electron。
 */
function handleEvent(fakeWindow, payload) {
  if (!fakeWindow || typeof fakeWindow.dispatchEvent !== 'function') return;
  if (!payload || typeof payload !== 'object') return;
  const kind = payload.kind;
  const data = payload.data || {};

  if (kind === 'start') {
    fakeWindow.dispatchEvent(buildEvent(fakeWindow, 'lingya-ai-start', {
      provider: data.provider || 'deepseek',
      at: data.at || Date.now(),
    }));
    return;
  }

  if (kind === 'response') {
    // detail 结构与 deepseek.js 的 dispatch() 完全一致
    fakeWindow.dispatchEvent(buildEvent(fakeWindow, 'lingya-ai-response', {
      text: data.text || '',
      finished: !!data.finished,
      tokenUsage: data.tokenUsage || null,
      msgIds: data.msgIds || null,
      interrupted: !!data.interrupted,
      thinking: data.thinking || '',
    }));
    return;
  }

  if (kind === 'userMessage') {
    fakeWindow.dispatchEvent(buildEvent(fakeWindow, 'lingya-user-message', {
      text: data.text || '',
      at: data.at || Date.now(),
    }));
    return;
  }

  if (kind === 'headers') {
    // 与 deepseek.js cacheHeaders() 派发的 detail 结构一致（裸对象）
    fakeWindow.dispatchEvent(buildEvent(fakeWindow, 'lingya-ds-headers', data));
    return;
  }

  if (kind === 'interrupted') {
    // 中断也走 lingya-ai-response，但 interrupted=true、finished=true
    // 这样下游统一按「一轮回复结束」处理，不会卡在等待态。
    fakeWindow.dispatchEvent(buildEvent(fakeWindow, 'lingya-ai-response', {
      text: data.text || '',
      finished: true,
      tokenUsage: data.tokenUsage || null,
      msgIds: data.msgIds || null,
      interrupted: true,
      thinking: data.thinking || '',
      reason: data.reason || 'unknown',
    }));
    return;
  }
}

let installed = false;

/**
 * 注册 IPC 监听。只应在 preload 里调用一次。
 */
function install() {
  if (installed) return;
  installed = true;
  const { ipcRenderer } = require('electron');
  // 告知 intercept-observer：本轮走 CDP，不要报「未收到 hook 自检」的假警告
  try { window.__lingyaCdpActive__ = true; } catch (_) {}
  ipcRenderer.on('lingya-cdp-event', (_event, payload) => {
    try {
      handleEvent(window, payload);
    } catch (err) {
      console.error('[LingYa][cdp-bridge] 派发事件失败:', err && err.message);
    }
  });
  console.log('[LingYa][cdp-bridge] 已启动 lingya-cdp-event 监听');
}

module.exports = {
  install,
  __test: {
    handleEvent,
  },
};
