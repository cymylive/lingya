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
function deepseekHookInstaller(SSE) {
  var MARKER = Symbol.for('l.hook.ds');
  if (window[MARKER]) return;

  // 共享 SSE 解析实现（由 getHookSource 注入对象字面量）。
  // 同一份代码同时供页面 hook 和主进程 CDP 解析使用，避免两处逻辑漂移。
  var isCompletion = SSE.isCompletion;
  var createFrameDecoder = SSE.createFrameDecoder;
  var parseBlock = SSE.parseBlock;
  var createExtractor = SSE.createExtractor;

  // 【2026-10-30 移除 spoofNative】
  // 原实现用 Object.defineProperty 给被 hook 的函数加自有 toString，
  // 试图伪装成 [native code]。但原生函数的 toString 是继承的，
  // 加自有属性后 hasOwnProperty('toString') 恒为 true —— 两行代码即可判定劫持。
  // 伪装失败比不伪装更糟：主动伪造 native 标识在平台协议里属于「假扮身份」，
  // 性质重于「自动化操作」。因此移除伪装，hook 本身保持原样。
  window[MARKER] = true;

  function dispatch(text, finished, tokenUsage, msgIds, interrupted, thinking) {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-response', {
        detail: {
          text: text || '',
          finished: !!finished,
          tokenUsage: tokenUsage || null,
          msgIds: msgIds || null,
          interrupted: !!interrupted,
          // 深度思考内容（DeepSeek 的「已思考」块）。没有时为空串。
          // 2026-10-30 新增：此前 THINK 片段被直接丢弃，推送通道拿不到。
          thinking: thinking || '',
        }
      }));
    } catch (e) { /* ignore */ }
  }

  function dispatchStart() {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-start'));
    } catch (e) { /* ignore */ }
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
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted, extractor.thinking);
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
      dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, isInterrupted, extractor.thinking);
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
          dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted, extractor.thinking);
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
      // 【2026-10-30】不再写 localStorage['lingya-ds-headers']。
      // 原实现把含 Bearer token 的完整请求头明文落在页面 storage 里：
      //   ① 页面任意脚本可读走 token（安全问题）
      //   ② 键名带 lingya- 前缀，一行 Object.keys(localStorage) 即暴露工具身份
      // 改为：主世界内存 + 派发事件给隔离世界，token 不落任何持久化存储。
      window.__lingyaDsHeaders = lower;
      window.dispatchEvent(new CustomEvent('lingya-ds-headers', { detail: lower }));
    } catch (e) { /* ignore */ }
  }

  // ---------- 自检探针：确认 hook 已生效且事件通道贯通 ----------
  // 主世界派发的 CustomEvent 若因隔离世界/时序问题收不到，整个 Agent 循环会静默失效。
  // 这里在注入完成后延迟派发一个自检事件，由 preload 侧记录日志（用户可见）。
  // 【2026-10-30 修时序竞态】原实现只在注入完成后 setTimeout(0) 派发一次。
  // 但本函数是通过 webFrame.executeJavaScript 异步注入主世界的，注入完成时
  // preload 侧的 intercept-observer 可能还没 require 到（它的自检监听器在那里注册）。
  // 事件派发早于监听器注册 → 事件丢失 → 5 秒后误报「hook 自检超时」。
  // 改为派发 3 次（0 / 400 / 1200ms），覆盖监听器注册窗口。
  // 监听器侧有幂等保护（window.__lingyaHookReadySeen__），重复收到只打一次日志。
  [0, 400, 1200].forEach(function (delay) {
    setTimeout(function () {
      try {
        window.dispatchEvent(new CustomEvent('lingya-hook-ready', {
          detail: { provider: 'deepseek', at: Date.now() }
        }));
      } catch (e) { /* ignore */ }
    }, delay);
  });

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
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
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
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, extractor.interrupted, extractor.thinking);
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
        dispatch(extractor.text, true, extractor.tokenUsage, extractor.msgIds, isInterrupted, extractor.thinking);
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
  //
  // SSE 解析四个函数来自 src/providers/sse/deepseek-parse.js，用 toString()
  // 序列化后以对象字面量传给 installer。同一份实现同时供主进程 CDP 解析使用，
  // 避免两条路径逻辑漂移。
  getHookSource() {
    const sse = require('./sse/deepseek-parse');
    const shared = [
      'var __SSE__ = {',
      'isCompletion: ' + sse.isCompletion.toString() + ',',
      'createFrameDecoder: ' + sse.createFrameDecoder.toString() + ',',
      'parseBlock: ' + sse.parseBlock.toString() + ',',
      'createExtractor: ' + sse.createExtractor.toString(),
      '};',
    ].join('\n');
    return shared + '\n(' + deepseekHookInstaller.toString() + ')(__SSE__);';
  },
};
