/**
 * CDP 捕获器 —— 用 webContents.debugger 监听 AI 平台的网络请求，
 * 替代页面内 hook fetch/XHR。
 *
 * 设计约束（来自 2026-10-31 spike 实测，见 docs/superpowers/plans/2026-10-31-cdp-dehook.md）：
 *  - CDP 在 Electron 33 下无法既流式读 fetch body 又不独占页面 body：
 *    Fetch.takeResponseBodyAsStream 会让页面自己的 getReader() 拿不到任何数据
 *  - 因此只用「响应结束后拿全量」：Network.loadingFinished + getResponseBody
 *  - 这与现有 hook 的派发时机等价：deepseek.js observeBody 也只在
 *    extractor.finished 时 dispatch 一次全文，不做流式处理
 *
 * 本模块只管「抓」，不关心「抓到的怎么送出去」——
 * handlers 由 cdp-wiring 注入，内部转成 IPC 推给隔离世界。
 */
const sse = require('../providers/sse/deepseek-parse');

/** webContents.id -> { handler, listener, providerId } */
const tracked = new Map();

function log(...args) {
  try { console.log('[LingYa][cdp-capture]', ...args); } catch (_) {}
}

function isValidWc(wc) {
  return !!(wc && wc.debugger && typeof wc.debugger.attach === 'function');
}

function isDestroyed(wc) {
  try {
    return typeof wc.isDestroyed === 'function' && wc.isDestroyed();
  } catch (_) {
    return true;
  }
}

function isAttached(wc) {
  if (!wc || !wc.debugger) return false;
  try {
    return !!wc.debugger.isAttached();
  } catch (_) {
    return false;
  }
}

/**
 * 把 CDP 返回的响应体解成 UTF-8 文本。
 * base64Encoded 为 true 时必须先解 base64，否则中文会乱码。
 */
function decodeBody(result) {
  if (!result || typeof result.body !== 'string') return '';
  if (result.base64Encoded) {
    try {
      return Buffer.from(result.body, 'base64').toString('utf8');
    } catch (_) {
      return '';
    }
  }
  return result.body;
}

/**
 * 从请求体里提取用户输入。DeepSeek 的 completion 请求体是 JSON，
 * prompt 字段就是用户消息（兼容 message / content 命名）。
 */
function extractUserMessage(postData) {
  if (!postData || typeof postData !== 'string') return null;
  let obj;
  try { obj = JSON.parse(postData); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  let text = obj.prompt;
  if (typeof text !== 'string' || !text.trim()) {
    if (typeof obj.message === 'string') text = obj.message;
    else if (typeof obj.content === 'string') text = obj.content;
  }
  if (typeof text !== 'string' || !text.trim()) return null;
  return text.trim();
}

/**
 * 处理 loadingFinished：拿全量 body → 解析 → 回调。
 * 独立导出（__test 下）便于单测，不需要真 Electron。
 */
async function handleLoadingFinished(dbg, providerId, params, handler) {
  if (!handler || typeof handler.onResponse !== 'function') return;
  const requestId = params && params.requestId;
  if (!requestId) return;
  let bodyText = '';
  try {
    const result = await dbg.sendCommand('Network.getResponseBody', { requestId });
    bodyText = decodeBody(result);
  } catch (err) {
    // 超长 body / 请求已被回收 / 跨进程读取失败 —— 都走中断路径
    log('getResponseBody 失败，按中断处理:', err && err.message);
    if (typeof handler.onInterrupted === 'function') {
      handler.onInterrupted('body_unavailable: ' + (err && err.message));
    }
    return;
  }
  let parsed;
  try {
    parsed = sse.parseFullBody(bodyText);
  } catch (err) {
    log('parseFullBody 抛异常:', err && err.message);
    if (typeof handler.onInterrupted === 'function') {
      handler.onInterrupted('parse_error: ' + (err && err.message));
    }
    return;
  }
  try { handler.onResponse(parsed); } catch (err) {
    log('onResponse 回调抛异常:', err && err.message);
  }
}

function handleLoadingFailed(params, handler) {
  if (!handler || typeof handler.onInterrupted !== 'function') return;
  const reason = (params && params.errorText) || 'loading_failed';
  try { handler.onInterrupted(reason); } catch (err) {
    log('onInterrupted 回调抛异常:', err && err.message);
  }
}

/**
 * 挂到 webContents 上开始抓包。
 *
 * @param {WebContents} wc
 * @param {string} providerId
 * @param {object} handlers { onStart, onUserMessage, onResponse, onHeaders, onInterrupted }
 * @returns {{ ok: boolean, error?: string }}
 */
function attach(wc, providerId, handlers) {
  if (!isValidWc(wc)) {
    return { ok: false, error: 'invalid webContents (missing debugger API)' };
  }
  if (isDestroyed(wc)) {
    return { ok: false, error: 'webContents already destroyed' };
  }
  if (providerId !== 'deepseek') {
    // 目前只给 DeepSeek 提供 CDP 解析（其它平台仍走 hook）。
    // 新平台要接入时在这里加分支，并实现自己的 parseFullBody。
    return { ok: false, error: 'unsupported provider: ' + providerId };
  }

  const h = handlers || {};
  const key = wc.id;

  // 已 attach 则复用，只替换 handler
  if (tracked.has(key)) {
    tracked.get(key).handler = h;
    log('复用已 attach 的连接, webContents.id=' + key);
    return { ok: true };
  }

  const already = isAttached(wc);
  if (!already) {
    try {
      wc.debugger.attach('1.3');
    } catch (err) {
      return { ok: false, error: 'debugger.attach 失败: ' + (err && err.message) };
    }
  }

  // 记录「哪些 requestId 是我们关心的」。只有 isCompletion 命中的请求才抓 body，
  // 否则每一条静态资源请求都会触发 getResponseBody，白白拖慢页面。
  const watched = new Set();
  // 请求体暂存：requestWillBeSent 先到，loadingFinished 后到
  const pendingUserMsg = new Map();

  const listener = (event, method, params) => {
    const cur = tracked.get(key);
    if (!cur) return;
    const handler = cur.handler || {};

    try {
      if (method === 'Network.requestWillBeSent') {
        const url = params && params.request && params.request.url;
        const m = params && params.request && params.request.method;
        if (!sse.isCompletion(url, m)) return;
        watched.add(params.requestId);
        // 派发开始事件
        if (typeof handler.onStart === 'function') {
          try { handler.onStart(); } catch (e) { log('onStart 抛异常:', e && e.message); }
        }
        // 提取用户消息（用于对话导出）
        const userText = extractUserMessage(params.request.postData);
        if (userText) {
          pendingUserMsg.set(params.requestId, userText);
          if (typeof handler.onUserMessage === 'function') {
            try { handler.onUserMessage(userText); } catch (e) { log('onUserMessage 抛异常:', e && e.message); }
          }
        }
        return;
      }

      if (method === 'Network.requestWillBeSentExtraInfo') {
        // 请求头（含 authorization / x-client-*），供压缩功能直连 API 复用
        if (params && params.headers && typeof handler.onHeaders === 'function') {
          try { handler.onHeaders(params.headers); } catch (e) { log('onHeaders 抛异常:', e && e.message); }
        }
        return;
      }

      if (method === 'Network.loadingFinished') {
        if (!watched.has(params.requestId)) return;
        watched.delete(params.requestId);
        pendingUserMsg.delete(params.requestId);
        handleLoadingFinished(wc.debugger, providerId, params, handler);
        return;
      }

      if (method === 'Network.loadingFailed') {
        if (!watched.has(params.requestId)) return;
        watched.delete(params.requestId);
        pendingUserMsg.delete(params.requestId);
        handleLoadingFailed(params, handler);
        return;
      }
    } catch (err) {
      log('CDP 事件处理异常 (' + method + '):', err && err.message);
    }
  };

  wc.debugger.on('message', listener);

  try {
    wc.debugger.sendCommand('Network.enable').catch((err) => {
      log('Network.enable 失败:', err && err.message);
    });
  } catch (err) {
    log('Network.enable 调用抛异常:', err && err.message);
  }

  tracked.set(key, { handler: h, listener, providerId });
  log('attach 成功, webContents.id=' + key + ' provider=' + providerId);

  // 生命周期兜底（Task 7 会补完整逻辑，这里先挂最小清理）
  try {
    if (typeof wc.on === 'function') {
      const onDestroyed = () => {
        try { detach(wc); } catch (_) {}
      };
      wc.once && wc.once('destroyed', onDestroyed);
    }
  } catch (_) {}

  return { ok: true };
}

function detach(wc) {
  if (!wc || !wc.debugger) return;
  const key = wc.id;
  const cur = tracked.get(key);
  if (cur && cur.listener) {
    try { wc.debugger.removeListener('message', cur.listener); } catch (_) {}
  }
  tracked.delete(key);
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch (err) {
    log('detach 失败:', err && err.message);
  }
}

/**
 * 确保 webContents 已 attach，返回 debugger 供 sendCommand 复用。
 *
 * 输入层（Input.insertText）只需要一个可用的 debugger，
 * 不关心 provider 是否能被解析成 SSE 流 —— 因此这里不经过 attach()
 * 的 provider 校验，直接裸 attach。这样 claude / chatgpt 页面也能用
 * 内核级输入，即使它们仍走 hook 捕获回复。
 */
function ensureAttached(wc) {
  if (!isValidWc(wc)) {
    throw new Error('invalid webContents (missing debugger API)');
  }
  if (isDestroyed(wc)) {
    throw new Error('webContents already destroyed');
  }
  if (!isAttached(wc)) {
    try {
      wc.debugger.attach('1.3');
    } catch (err) {
      throw new Error('debugger.attach 失败: ' + (err && err.message));
    }
  }
  return wc.debugger;
}

module.exports = {
  attach,
  detach,
  isAttached,
  ensureAttached,
  __test: {
    handleLoadingFinished,
    handleLoadingFailed,
    decodeBody,
    extractUserMessage,
  },
};
