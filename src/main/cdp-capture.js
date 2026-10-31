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

/** 【临时校准】requestId -> { startAt, baselineAcc, totalBytes } */
const CALIB_META = new Map();
/** 【临时校准】上一轮结束时的 accumulatedTokens（作为下一轮 baseline） */
let _lastKnownAcc = 0;

/** webContents -> { onDestroyed, onNavigate }，用于重新 attach 时摘掉旧监听器 */
const lifecycleHandlers = new WeakMap();

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
    log('getResponseBody 失败，按中断处理:', err && err.message);
    if (typeof handler.onInterrupted === 'function') {
      handler.onInterrupted('body_unavailable: ' + (err && err.message));
    }
    return;
  }
  // 【2026-11-01 新增】DeepSeek 有时用 HTTP 200 + body 内 biz_code=40029 / 限流文案 表达"操作频繁"
  // 先检查 body 再决定是否走正常 SSE 解析
  if (bodyText && typeof handler.onError === 'function') {
    const low = String(bodyText).toLowerCase();
    const byKeyword =
      low.indexOf('too frequently') !== -1 || low.indexOf('rate limit') !== -1 ||
      low.indexOf('too many requests') !== -1 || low.indexOf('too fast') !== -1 ||
      low.indexOf('过于频繁') !== -1 || low.indexOf('频率过快') !== -1 ||
      low.indexOf('稍后再试') !== -1 || low.indexOf('稍后再发') !== -1;
    const byBizCode =
      bodyText.indexOf('"code":40029') !== -1 || bodyText.indexOf('"code": 40029') !== -1 ||
      bodyText.indexOf('"biz_code":40029') !== -1 || bodyText.indexOf('"biz_code": 40029') !== -1;
    if (byKeyword || byBizCode) {
      log('[cdp-capture] 检测到限流标记: keyword=' + byKeyword + ' bizCode=' + byBizCode);
      try { handler.onError({ reason: 'rate_limit', bizCode: byBizCode ? 40029 : null }); } catch (_) {}
      return;  // 不解析，本轮已失败
    }
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
  // 【对齐 Cuckoo】用真实 token 数据计算并覆盖 TPS
  try {
    const meta = CALIB_META.get(requestId);
    const elapsedSec = meta ? (Date.now() - meta.startAt) / 1000 : 0;
    const realAcc = parsed && parsed.tokenUsage && typeof parsed.tokenUsage.accumulatedTokens === 'number'
      ? parsed.tokenUsage.accumulatedTokens : -1;
    const baseline = meta ? meta.baselineAcc : 0;
    const outTokens = realAcc >= 0 ? Math.max(0, realAcc - baseline) : -1;
    if (realAcc >= 0) _lastKnownAcc = realAcc;
    CALIB_META.delete(requestId);
    // 【对齐 Cuckoo】把真实 TPS 塞进 parsed，供前端覆盖估算值
    // 首轮冷启动（baseline=0 且 outTokens 巨大）视为异常，不覆盖
    if (outTokens > 0 && outTokens < 5000 && elapsedSec > 0.3) {
      const realTps = outTokens / elapsedSec;
      if (realTps > 0 && realTps < 1000) {
        parsed._realTps = Math.round(realTps * 10) / 10;
        log('[CALIB] realTps=' + parsed._realTps + ' 覆盖估算值');
      }
    }
  } catch (_) {}
  try { handler.onResponse(parsed); } catch (err) {
    log('onResponse 回调抛异常:', err && err.message);
  }
}

function handleLoadingFailed(params, handler) {
  if (!handler) return;
  const reason = (params && params.errorText) || 'loading_failed';
  // 【2026-11-01】网络失败也算失败，触发重试引擎
  if (typeof handler.onError === 'function') {
    try { handler.onError({ reason: 'network', errorText: reason }); }
    catch (err) { log('onError 回调抛异常:', err && err.message); }
  }
  // 同时让下游知道本轮结束
  if (typeof handler.onInterrupted === 'function') {
    try { handler.onInterrupted(reason); } catch (err) {
      log('onInterrupted 回调抛异常:', err && err.message);
    }
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
    // 【重要】lifecycle 监听器的闭包持有旧 handler。若不重挂，
    // 导航后会恢复成上一次的 handler（可能已被销毁的 sender）。
    // trackLifecycle 内部会先摘掉旧监听器，不会累积。
    trackLifecycle(wc, h, providerId);
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
  // 【2026-11-01 新增】HTTP 状态记录：requestId -> { status, mimeType }
  // 用于识别 429 / 4xx / 5xx 等失败响应，派发 onError 触发重试引擎
  const responseStatus = new Map();
  // 【对齐 Cuckoo 2026-11-01】流式字节累计：用于 TPS 测速（fetch 流）
  // requestId -> 已接收字节数（从 dataReceived 累计）
  const streamBytes = new Map();
  // 节流：上一次派发时间（避免每帧都 IPC）
  let lastStreamAt = 0;
  const STREAM_THROTTLE_MS = 100;


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
        streamBytes.set(params.requestId, 0);
        // 【临时校准】记录本轮起始时刻和 baseline
        CALIB_META.set(params.requestId, {
          startAt: Date.now(),
          baselineAcc: _lastKnownAcc,
          totalBytes: 0,
        });
        // 派发开始事件
        if (typeof handler.onStart === 'function') {
          try { handler.onStart(); } catch (e) { log('onStart 抛异常:', e && e.message); }
        }
        // 提取用户消息（用于对话导出）
        const userText = extractUserMessage(params.request.postData);
        if (userText) {
          if (typeof handler.onUserMessage === 'function') {
            try { handler.onUserMessage(userText); } catch (e) { log('onUserMessage 抛异常:', e && e.message); }
          }
        }
        return;
      }

      // 【2026-11-01 新增】记录 HTTP 状态码，用于后续识别 429/4xx/5xx
      if (method === 'Network.responseReceived') {
        if (!watched.has(params.requestId)) return;
        const r = params.response || {};
        responseStatus.set(params.requestId, {
          status: typeof r.status === 'number' ? r.status : 0,
          mimeType: r.mimeType || '',
        });
        return;
      }

      if (method === 'Network.requestWillBeSentExtraInfo') {
        // 【只认补全请求】本事件对**所有**请求触发（图片、JS、CSS 都算），
        // 无条件派发会让垃圾请求头覆盖真正的 authorization / x-client-*。
        // 用 requestId 反查是否在 watched 里过滤掉无关请求。
        if (!params || !watched.has(params.requestId)) return;
        if (params.headers && typeof handler.onHeaders === 'function') {
          try { handler.onHeaders(params.headers); } catch (e) { log('onHeaders 抛异常:', e && e.message); }
        }
        return;
      }

      // 【对齐 Cuckoo 2026-11-01】DeepSeek 用 fetch + ReadableStream（非原生 EventSource），
      // 因此 eventSourceMessageReceived 不触发。改用 Network.dataReceived 捕获网络包长度，
      // 累加后按「5 字节 ≈ 1 token」估算 accumulatedTokens，供 TPS 测速器计算。
      if (method === 'Network.dataReceived') {
        if (!watched.has(params.requestId)) return;
        const prev = streamBytes.get(params.requestId) || 0;
        const total = prev + (params.dataLength || 0);
        streamBytes.set(params.requestId, total);

        const now = Date.now();
        if (now - lastStreamAt >= STREAM_THROTTLE_MS) {
          lastStreamAt = now;
          if (typeof handler.onStream === 'function') {
            try { handler.onStream({ bytes: total, requestId: params.requestId }); }
            catch (e) { log('onStream 抛异常:', e && e.message); }
          }
        }
        return;
      }

      if (method === 'Network.loadingFinished') {
        if (!watched.has(params.requestId)) return;
        watched.delete(params.requestId);
        const totalBytes = streamBytes.get(params.requestId) || 0;
        streamBytes.delete(params.requestId);
        // 请求结束：最后派发一次（finished=true），让测速器冻结最终值
        if (typeof handler.onStream === 'function' && totalBytes > 0) {
          try { handler.onStream({ bytes: totalBytes, requestId: params.requestId, finished: true }); }
          catch (e) { log('onStream(final) 抛异常:', e && e.message); }
        }
        // 【2026-11-01 新增】优先检查 HTTP 状态，失败时派发 onError
        const st = responseStatus.get(params.requestId) || {};
        responseStatus.delete(params.requestId);
        const httpStatus = st.status || 0;
        if (typeof handler.onError === 'function') {
          if (httpStatus === 429) {
            try { handler.onError({ reason: 'rate_limit', httpStatus: 429 }); } catch (e) { log('onError 抛异常:', e && e.message); }
            return;
          }
          if (httpStatus >= 400) {
            try { handler.onError({ reason: 'http', httpStatus: httpStatus }); } catch (e) { log('onError 抛异常:', e && e.message); }
            return;
          }
        }
        // 正常响应：走 SSE 解析
        handleLoadingFinished(wc.debugger, providerId, params, handler);
        return;
      }

      if (method === 'Network.loadingFailed') {
        if (!watched.has(params.requestId)) return;
        watched.delete(params.requestId);
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

  trackLifecycle(wc, h, providerId);

  return { ok: true };
}

/**
 * 注册 webContents 生命周期兜底：
 *  - destroyed：页面没了，debugger 必须清掉，否则 tracked 里留死引用
 *  - did-navigate：页面导航后浏览器会断开 debugger 连接（Electron 行为），
 *    需要重新 attach 并重装事件监听，否则新页面的回复收不到
 *
 * handler 与 providerId 显式传入（不从 tracked 反查），
 * 这样单测可以直接传 fake，不需要先走完整 attach 流程。
 */
function trackLifecycle(wc, handler, providerId) {
  if (!wc || typeof wc.on !== 'function') return;

  // 【防累积】重新 attach 会再次调用本函数。若每次都挂新的 did-navigate，
  // 导航 N 次后就有 N+1 个监听器，一次导航触发多次重连。
  // 先把上一轮挂的摘掉。
  const prev = lifecycleHandlers.get(wc);
  if (prev) {
    try { wc.removeListener && wc.removeListener('did-navigate', prev.onNavigate); } catch (_) {}
    try { wc.removeListener && wc.removeListener('destroyed', prev.onDestroyed); } catch (_) {}
  }

  const onDestroyed = () => {
    lifecycleHandlers.delete(wc);
    try { detach(wc); } catch (err) {
      log('destroyed 清理失败:', err && err.message);
    }
  };

  const onNavigate = () => {
    log('页面导航，重建 debugger 连接, webContents.id=' + wc.id);
    // detach 只摘 debugger 监听，不摘生命周期监听
    try { detach(wc); } catch (_) {}
    // 重新 attach。attach 内部会再调 trackLifecycle，那里负责摘旧监听器。
    try {
      const r = attach(wc, providerId, handler || {});
      if (!r.ok) log('导航后重新 attach 失败:', r.error);
    } catch (err) {
      log('导航后重新 attach 抛异常:', err && err.message);
    }
  };

  lifecycleHandlers.set(wc, { onDestroyed, onNavigate });

  try {
    // 用 once 挂 destroyed：销毁只发生一次，on 会留悬挂监听
    if (typeof wc.once === 'function') wc.once('destroyed', onDestroyed);
    else wc.on('destroyed', onDestroyed);
  } catch (_) {}
  try {
    // did-navigate 可能多次（每次导航都要重建），必须用 on
    wc.on('did-navigate', onNavigate);
  } catch (_) {}
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
    trackLifecycle,
  },
};
