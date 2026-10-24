/**
 * DeepSeek Provider 定义
 * 包含主进程和 preload 都需要的信息：
 * - 主进程：homeUrl（打开窗口）、sessionUrlBase（导航到会话）
 * - preload：输入框/发送按钮选择器、用户信息选择器、首页判断正则
 */

/**
 * 判断元素是否由 LingYa 覆盖层/侧边栏注入（非站点原生元素）。
 *
 * 为什么必须排除：LingYa 往页面里注入了一批 textarea
 * （lingya-utodo-input「我的待办」、lingya-mcp-json、lingya-schedule-prompt 等），
 * 它们都挂在 body 下、位于 DOM 末尾。若站点原生输入框在导航瞬间尚未渲染，
 * findInput() 的兜底选择器 'textarea' 会先命中这些注入元素，
 * 导致 sendToChat 把消息填进「我的待办」并按 Enter 提交 —— 凭空生成待办。
 *
 * 实测事故：定时任务触发时把任务文本写进了待办（2026-10-24）。
 */
function isLingyaInjected(el) {
  if (!el) return true;
  try {
    // id / class / 祖先链任一含 lingya 前缀即视为注入元素
    if (el.id && /^lingya-|^sh-/.test(el.id)) return true;
    if (el.className && typeof el.className === 'string' && /\blingya-|\bsh-/.test(el.className)) return true;
    if (typeof el.closest === 'function' && el.closest('#lingya-root, .lingya-overlay, #lingya-sidebar, .lingya-sidebar')) return true;
  } catch (_) { /* 判定失败时保守放行（宁可误选也不 throw） */ }
  return false;
}

// ========== 网络拦截器（内联，注入主世界执行）==========
// 说明：hook 源码直接内联在 provider 中，保证 provider 单文件自包含，
// 便于自定义 provider 上传与整体移除。函数体必须自包含（不引用模块级变量）。
function deepseekHookInstaller() {
  var MARKER = Symbol.for('l.hook.ds');
  if (window[MARKER]) return;

  /**
   * 把被包裹的原生函数伪装成 native code。
   * 平台常用 Function.prototype.toString.call(fn).includes('[native code]') 判断劫持。
   * 这里覆盖 fn.toString()，让直接调用 fn.toString() 的检测拿不到真实源码。
   * 注意：Function.prototype.toString.call(fn) 仍会拿到真实源码 —— 那需要替换
   * Function.prototype.toString 本身，侵入性太大且容易弄坏站点，不做。
   */
  function spoofNative(fn, name) {
    try {
      Object.defineProperty(fn, 'toString', {
        value: function () { return 'function ' + name + '() { [native code] }'; },
        configurable: true,
        writable: true,
      });
    } catch (e) { /* 属性不可配置时忽略，不影响功能 */ }
  }
  window[MARKER] = true;

  // 主路径（已知的 DeepSeek 流式补全端点）
  var COMPLETION_PATH = '/api/v0/chat/completion';

  /**
   * 判断是否为「AI 回复流式请求」。
   *
   * 为什么不用严格等值：DeepSeek 会改端点细节（版本号 / 子路径 / trailing slash）。
   * 严格等值一旦不匹配，isCompletion 永远 false → 事件永不派发 → 整个 Agent 循环
   * 静默失效，且没有任何报错。这是不可接受的失败模式（0.6.94 排查时的重要盲区）。
   *
   * 放宽为：POST + 路径以 /api/v 开头 + 含 chat + 含 completion。
   * 保留了足够的特异性（不会误匹配 share/feedback 等其它端点），
   * 又能容忍版本号与子路径变化。
   */
  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    var pathname;
    try {
      pathname = new URL(url, document.baseURI).pathname;
    } catch (e) {
      pathname = String(url).split('?')[0];
    }
    if (pathname === COMPLETION_PATH) return true;
    // 放宽匹配：/api/v{N}/chat/**completion**
    return /^\/api\/v[\d.]+\/chat\//.test(pathname) && /completion/i.test(pathname);
  }

  function dispatch(text, finished, tokenUsage, msgIds, interrupted) {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-response', {
        detail: { text: text || '', finished: !!finished, tokenUsage: tokenUsage || null, msgIds: msgIds || null, interrupted: !!interrupted }
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------- SSE 帧解码 ----------
  function createFrameDecoder() {
    var buffer = '', scanFrom = 0;
    return {
      push: function (text) {
        buffer += text;
        var frames = [], re = /\r?\n\r?\n/g, offset = 0, m;
        re.lastIndex = scanFrom;
        while ((m = re.exec(buffer)) !== null) {
          frames.push(buffer.slice(offset, m.index));
          offset = m.index + m[0].length;
        }
        buffer = buffer.slice(offset);
        scanFrom = Math.max(0, buffer.length - 3);
        return frames;
      },
      finish: function () {
        var frames = [];
        if (buffer) frames.push(buffer);
        buffer = ''; scanFrom = 0;
        return frames;
      }
    };
  }

  function parseBlock(block) {
    if (!block || !block.trim()) return null;
    var data = null;
    var lines = block.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) {
        var d = line.slice(5).trim();
        data = data == null ? d : data + '\n' + d;
      }
    }
    if (data == null) return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  function dispatchStart() {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-start'));
    } catch (e) { /* ignore */ }
  }

  // ---------- 回复文本提取（区分 THINK / RESPONSE 片段）----------
  function createExtractor() {
    var fragmentTypes = [];
    var currentIndex = -1;
    var observed = false;
    var text = '';
    var finished = false;
    // 生成被中断（服务端明确标记 INTERRUPTED/BROKEN/FAILED）
    var interrupted = false;
    // 服务端权威 token 统计（accumulated_token_usage 含 prompt/context + 输出）
    var tokenUsage = null;
    // 本条回复的消息 id：requestMessageId（用户提问）+ responseMessageId（AI 回复）
    var msgIds = null;

    // 从对象里捕获消息 id 字段
    function captureMsgIds(src) {
      if (!src || typeof src !== 'object') return;
      if (!msgIds) msgIds = {};
      if (typeof src.request_message_id === 'number') msgIds.requestMessageId = src.request_message_id;
      if (typeof src.response_message_id === 'number') msgIds.responseMessageId = src.response_message_id;
      // 快照形式：{v:{response:{message_id, parent_id}}}
      if (typeof src.message_id === 'number') msgIds.responseMessageId = src.message_id;
      if (typeof src.parent_id === 'number') msgIds.requestMessageId = src.parent_id;
    }

    // 从对象里捕获 token 相关字段（幂等，只保留最后一次值）
    function captureTokenUsage(src) {
      if (!src || typeof src !== 'object') return;
      var changed = false;
      if (!tokenUsage) tokenUsage = {};
      if (typeof src.accumulated_token_usage === 'number') {
        tokenUsage.accumulatedTokens = src.accumulated_token_usage; changed = true;
      }
      if (typeof src.inserted_at === 'number') {
        tokenUsage.insertedAt = src.inserted_at; changed = true;
      }
      if (typeof src.updated_at === 'number') {
        tokenUsage.updatedAt = src.updated_at; changed = true;
      }
      if (typeof src.model_type === 'string') {
        tokenUsage.modelType = src.model_type; changed = true;
      }
      if (!changed && Object.keys(tokenUsage).length === 0) tokenUsage = null;
    }

    function lastSeg(p) { return typeof p === 'string' ? p.split('/').pop() : ''; }
    function isTextPatch(p) {
      var s = lastSeg(p);
      return s === 'content' || s === 'text' || s === 'markdown' || s === 'delta';
    }
    function isResponsePatch(p) {
      return typeof p === 'string' && (p === 'response' || p.indexOf('response/') === 0);
    }
    function isResponseTextPatch(p) { return isTextPatch(p) && isResponsePatch(p); }
    function isThinkingPatch(p) {
      var s = lastSeg(p);
      return s === 'reasoning_content' || s === 'thinking_content';
    }
    function isFragmentsAppend(p) {
      return p && typeof p.p === 'string' && p.p.slice(-10) === '/fragments' &&
        p.o === 'APPEND' && Array.isArray(p.v);
    }
    function snapshotFragments(p) {
      if (!p || p.p !== undefined || !p.v || typeof p.v !== 'object') return null;
      var r = p.v.response;
      if (!r || typeof r !== 'object') return null;
      var f = r.fragments;
      return Array.isArray(f) && f.length > 0 ? f : null;
    }
    function fragText(f) {
      if (!f || typeof f !== 'object') return '';
      if (typeof f.content === 'string') return f.content;
      if (typeof f.text === 'string') return f.text;
      return '';
    }
    function typeAt(i) {
      if (i === -1) i = currentIndex;
      if (i < 0 || i >= fragmentTypes.length) return null;
      return fragmentTypes[i];
    }
    function isThink(t) { return String(t).toUpperCase() === 'THINK'; }
    function consumeFragmentContent(fragments, types) {
      for (var i = 0; i < fragments.length; i++) {
        var c = fragText(fragments[i]);
        if (!c) continue;
        if (!isThink(types[i])) text += c;
      }
    }

    function consume(parsed) {
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
        for (var i = 0; i < parsed.v.length; i++) consume(parsed.v[i]);
        return;
      }
      // ---- 消息 id 捕获 ----
      // 顶层帧：{"request_message_id":668,"response_message_id":669,...}
      captureMsgIds(parsed);
      // ---- token 字段捕获 ----
      // 1) 消息快照：{"v":{"response":{"accumulated_token_usage":...}}}
      if (parsed.v && typeof parsed.v === 'object' && parsed.v.response && typeof parsed.v.response === 'object') {
        captureTokenUsage(parsed.v.response);
        captureMsgIds(parsed.v.response);
      }
      // 2) 独立帧：{"p":"accumulated_token_usage","v":123}
      if (typeof parsed.p === 'string' && lastSeg(parsed.p) === 'accumulated_token_usage' && typeof parsed.v === 'number') {
        captureTokenUsage({ accumulated_token_usage: parsed.v });
      }
      // 3) 顶层 updated_at：{"updated_at":1789351765.04}
      if (parsed.updated_at !== undefined) {
        captureTokenUsage(parsed);
      }
      if (isFragmentsAppend(parsed)) {
        var types = [];
        for (var j = 0; j < parsed.v.length; j++) {
          types.push(String((parsed.v[j] && parsed.v[j].type) || 'RESPONSE'));
        }
        fragmentTypes = fragmentTypes.concat(types);
        currentIndex = fragmentTypes.length - 1;
        observed = true;
        consumeFragmentContent(parsed.v, types);
        return;
      }
      var snap = snapshotFragments(parsed);
      if (snap) {
        var first = !observed;
        var stypes = [];
        for (var k = 0; k < snap.length; k++) {
          stypes.push(String((snap[k] && snap[k].type) || 'RESPONSE'));
        }
        fragmentTypes = stypes;
        currentIndex = fragmentTypes.length - 1;
        observed = true;
        if (first) consumeFragmentContent(snap, stypes);
        return;
      }
      if (isThinkingPatch(parsed.p) && typeof parsed.v === 'string') return;
      if (typeof parsed.p === 'string' && isResponseTextPatch(parsed.p) && typeof parsed.v === 'string') {
        var m = /^response\/fragments\/(-?\d+)\//.exec(parsed.p);
        var idx = m ? Number(m[1]) : -1;
        if (!isThink(typeAt(idx))) text += parsed.v;
        return;
      }
      if (parsed.p === undefined && typeof parsed.v === 'string') {
        if (!isThink(typeAt(currentIndex))) text += parsed.v;
        return;
      }
      if (parsed.p === 'response/status' || parsed.p === 'quasi_status') {
        if (parsed.v === 'FINISHED') finished = true;
        else if (parsed.v === 'INTERRUPTED' || parsed.v === 'BROKEN' || parsed.v === 'FAILED') interrupted = true;
      }
    }

    return {
      consume: consume,
      get text() { return text; },
      get finished() { return finished; },
      get interrupted() { return interrupted; },
      get tokenUsage() { return tokenUsage; },
      get msgIds() { return msgIds; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted);
      }
    }

    // 流结束（正常读完或异常断开）时统一收尾：未收到 FINISHED 即判定为中断
    function finalize() {
      if (dispatched) return;
      dispatched = true;
      try {
        var tail = decoder.decode();
        if (tail) feed(tail);
      } catch (e) { /* ignore */ }
      try {
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseBlock(rest[i]);
          if (parsed) extractor.consume(parsed);
        }
      } catch (e) { /* ignore */ }
      var isInterrupted = extractor.interrupted || !extractor.finished;
      dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, isInterrupted);
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) { finalize(); return; }
        var chunk = decoder.decode(r.value, { stream: true });
        var frames = frameDecoder.push(chunk);
        for (var i = 0; i < frames.length; i++) {
          var parsed = parseBlock(frames[i]);
          if (parsed) extractor.consume(parsed);
        }
        if (extractor.finished && !dispatched) {
          dispatched = true;
          dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted);
        }
        pump();
      }).catch(function () { finalize(); });
    }
    pump();
  }

  // ---------- 用户消息派发（供 preload 侧记录对话）----------
  // 从请求体提取用户输入。DeepSeek 的 completion 请求体里 prompt 就是用户消息。
  function dispatchUserMessage(bodyText) {
    try {
      if (!bodyText || typeof bodyText !== 'string') return;
      var obj;
      try { obj = JSON.parse(bodyText); } catch (e) { return; }
      if (!obj || typeof obj !== 'object') return;
      var text = obj.prompt;
      // 兼容可能的其他字段命名
      if (typeof text !== 'string' || !text.trim()) {
        if (typeof obj.message === 'string') text = obj.message;
        else if (typeof obj.content === 'string') text = obj.content;
      }
      if (typeof text !== 'string' || !text.trim()) return;
      window.dispatchEvent(new CustomEvent('lingya-user-message', {
        detail: { text: text.trim(), at: Date.now() }
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------- 缓存真实请求头（供压缩时直接 fetch 使用）----------
  // DeepSeek 的 share/create 需要 authorization + x-client-* 头，
  // 拦截任意请求时缓存最新一组，供后续直接调用 API。
  function cacheHeaders(hdrs) {
    try {
      if (!hdrs) return;
      var lower = {};
      for (var k in hdrs) {
        if (Object.prototype.hasOwnProperty.call(hdrs, k)) {
          lower[String(k).toLowerCase()] = hdrs[k];
        }
      }
      if (!lower['authorization']) return;
      localStorage.setItem('lingya-ds-headers', JSON.stringify(lower));
    } catch (e) { /* ignore */ }
  }

  // ---------- 自检探针：确认 hook 已生效且事件通道贯通 ----------
  // 主世界派发的 CustomEvent 若因隔离世界/时序问题收不到，整个 Agent 循环会静默失效。
  // 这里在注入完成后延迟派发一个自检事件，由 preload 侧记录日志（用户可见）。
  setTimeout(function () {
    try {
      window.dispatchEvent(new CustomEvent('lingya-hook-ready', {
        detail: { provider: 'deepseek', at: Date.now() }
      }));
    } catch (e) { /* ignore */ }
  }, 0);

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      // 缓存请求头
      try {
        if (init && init.headers) {
          var h = init.headers;
          var obj = {};
          if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { obj[k] = v; }); }
          else if (Array.isArray(h)) { h.forEach(function (p) { obj[p[0]] = p[1]; }); }
          else { obj = h; }
          cacheHeaders(obj);
        }
      } catch (e) { /* ignore */ }
      // 拦截用户消息（用于对话导出）：请求体含本次用户输入
      try {
        if (isCompletion(url, method) && init && typeof init.body === 'string') {
          dispatchUserMessage(init.body);
        }
      } catch (e) { /* ignore */ }

      var p = origFetch.apply(this, arguments);
      if (!isCompletion(url, method)) return p;
      dispatchStart();
      return p.then(function (response) {
        try {
          if (response && response.body) observeBody(response.clone().body);
        } catch (e) { /* ignore */ }
        return response;
      });
    };
    spoofNative(window.fetch, 'fetch');
  }

  // ---------- XHR 拦截（被动读取 responseText）----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      var inf = xhrInfo.get(this) || {};
      if (!inf.headers) inf.headers = {};
      inf.headers[name] = value;
      xhrInfo.set(this, inf);
      cacheHeaders(inf.headers);
    } catch (e) { /* ignore */ }
    return origSetRequestHeader.apply(this, arguments);
  };
  spoofNative(XMLHttpRequest.prototype.setRequestHeader, 'setRequestHeader');
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  spoofNative(XMLHttpRequest.prototype.open, 'open');
  XMLHttpRequest.prototype.send = function (body) {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      // 拦截用户消息（用于对话导出）
      try { if (typeof body === 'string') dispatchUserMessage(body); } catch (e) { /* ignore */ }
      dispatchStart();
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  };
  spoofNative(XMLHttpRequest.prototype.send, 'send');


  function observeXhr(xhr) {
    var lastLen = 0;
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseBlock(rest[i]);
          if (parsed) extractor.consume(parsed);
        }
        dispatched = true;
        // 请求结束但未收到 FINISHED → 判定为中断
        var isInterrupted = extractor.interrupted || !extractor.finished;
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, isInterrupted);
      }
    });
  }
}

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chat.deepseek.com/',
  sessionUrlBase: 'https://chat.deepseek.com/a/chat/s/',

  // 查找可见的聊天输入框
  //
  // 【必须排除 LingYa 注入的元素】
  // 覆盖层注入了一批 textarea（lingya-utodo-input / lingya-mcp-json /
  // lingya-schedule-prompt 等），且它们位于 body 末尾。若 DeepSeek 原生输入框
  // 延迟渲染（导航到首页的瞬间），裸选择器 'textarea' 会先命中覆盖层的输入框，
  // 导致系统提示词被填进「我的待办」并触发 Enter → 待办被凭空创建。
  // 实测已发生：定时任务触发时把任务文本写进了待办。
  findInput() {
    const selectors = [
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="输入消息"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="提问"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="send"]',
      'textarea[placeholder*="deepseek"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea.chat-input',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!this.isElementVisible(el)) continue;
          if (isLingyaInjected(el)) continue;   // 排除 LingYa 自己的输入框
          return el;
        }
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'button[type="submit"]',
      'button[aria-label*="send"]',
      'button[aria-label*="发送"]',
      'button[title*="send"]',
      'button[title*="发送"]',
      'button[data-action="send"]',
      'button[data-type="send"]',
      '.send-btn',
      '.submit-btn',
      'button svg[data-icon="send"]',
      '[data-testid="send"]',
      '[data-testid="send-button"]',
      'button:has(svg[data-icon="arrow"])',
      'button:has(> svg)',
      'button:has(svg[data-icon="send"])',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel);
        if (this.isElementVisible(btn) && !btn.disabled) return btn;
      } catch (_) {}
    }
    return null;
  },

  // 查找可见的「停止生成」按钮（AI 正在输出时出现）
  findStopButton() {
    const selectors = [
      'button[aria-label*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[title*="stop"]',
      'button[title*="停止"]',
      'button[data-testid*="stop"]',
      'div[role="button"][aria-label*="停止"]',
      'button:has(svg[data-icon="stop"])',
      'button:has(svg[data-testid*="stop"])',
      '.stop-btn',
      '.stop-generating',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel);
        if (this.isElementVisible(btn) && !btn.disabled) return btn;
      } catch (_) {}
    }
    return null;
  },

  // 提取当前用户信息文本（脱敏手机号/微信昵称）
  extractUserInfo() {
    const el = document.querySelector('._9d8da05');
    return el ? el.textContent.trim() : '';
  },

  // 首页判断正则（用于覆盖层首页模式）
  homeUrlPattern: /^https:\/\/chat\.deepseek\.com\/?(\?.*)?$/,

  // 从 URL 提取会话 ID
  extractSessionId(url) {
    if (!url) return null;
    const match = url.match(/\/chat\/s\/([a-f0-9-]+)/i);
    if (match) return match[1];
    const altMatch = url.match(/\/s\/([a-f0-9-]+)/i);
    return altMatch ? altMatch[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    return url.includes('chat.deepseek.com');
  },

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  getHookSource() {
    return '(' + deepseekHookInstaller.toString() + ')();';
  },
};
