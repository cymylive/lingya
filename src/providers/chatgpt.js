/**
 * ChatGPT Provider 定义
 * 基于 chatgpt.com 页面结构，输入框为 ProseMirror（contenteditable）。
 */
// ========== 网络拦截器（内联，注入主世界执行）==========
// 说明：hook 源码直接内联在 provider 中，保证 provider 单文件自包含。
// 函数体必须自包含（不引用模块级变量）。
function chatgptHookInstaller() {
  var MARKER = '__lingyaChatgptHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      var host = u.hostname;
      if (host.indexOf('chatgpt.com') === -1 && host.indexOf('chat.openai.com') === -1) return false;
      return /\/backend-api\/(?:f\/)?conversation\/?$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function dispatch(text, finished) {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-response', {
        detail: { text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  function dispatchStart() {
    try {
      window.dispatchEvent(new CustomEvent('lingya-ai-start'));
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

  // 返回 { data: string|null, done: boolean }
  function parseBlock(block) {
    if (!block || !block.trim()) return { data: null, done: false };
    var data = null;
    var lines = block.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) {
        var d = line.slice(5).trim();
        data = data == null ? d : data + '\n' + d;
      }
    }
    if (data == null) return { data: null, done: false };
    if (data === '[DONE]') return { data: null, done: true };
    return { data: data, done: false };
  }

  // ---------- 回复文本提取 ----------
  function createExtractor() {
    var text = '';
    var finished = false;

    function extractParts(content) {
      if (!content || !Array.isArray(content.parts)) return null;
      var out = '';
      for (var i = 0; i < content.parts.length; i++) {
        var p = content.parts[i];
        if (typeof p === 'string') out += p;
        else if (p && typeof p === 'object' && typeof p.text === 'string') out += p.text;
      }
      return out;
    }

    function applyOp(node) {
      if (!node || typeof node !== 'object') return;

      // 1) 批量操作：o='patch' / 'BATCH'，v 为操作数组
      if (Array.isArray(node.v) && (node.o === 'patch' || node.o === 'BATCH')) {
        for (var i = 0; i < node.v.length; i++) applyOp(node.v[i]);
        return;
      }

      // 2) 消息快照：v.message（仅采纳 assistant）
      if (node.v && typeof node.v === 'object' && node.v.message) {
        var m = node.v.message;
        var role = m.author && m.author.role;
        if (role === 'assistant') {
          var snap = extractParts(m.content);
          if (snap !== null) text = snap;
        }
        return;
      }

      // 3) 路径操作
      if (typeof node.p === 'string' && node.p !== '') {
        if (node.p === '/message/status' && node.v === 'finished_successfully') { finished = true; return; }
        if (node.p === '/message/end_turn' && node.v === true) { finished = true; return; }
        if (/\/message\/content\/parts\/\d+$/.test(node.p)) {
          if (typeof node.v === 'string') {
            if (node.o === 'append' || node.o === 'add') text += node.v;
            else text = node.v;
          }
        }
        return;
      }

      // 4) 裸 v 字符串（无有效 p）：追加正文
      if (typeof node.v === 'string') { text += node.v; return; }

      // 5) 类型化结束事件
      if (node.type === 'message_stream_complete' || node.type === 'message_stream_completed') {
        finished = true;
      }
    }

    return {
      consume: function (parsed) { applyOp(parsed); },
      markDone: function () { finished = true; },
      get text() { return text; },
      get finished() { return finished; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) feed(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
      });
    }
    pump();
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
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

  // ---------- XHR 拦截 ----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
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

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
        dispatched = true;
        dispatch(extractor.text, true);
      }
    });
  }
}

module.exports = {
  id: 'chatgpt',
  name: 'ChatGPT',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chatgpt.com/',
  sessionUrlBase: 'https://chatgpt.com/c/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（ChatGPT 用 ProseMirror contenteditable）
  findInput() {
    const selectors = [
      'div[contenteditable="true"].ProseMirror',
      'div[role="textbox"]',
      'div.ProseMirror',
      'div[contenteditable="true"]',
      'textarea',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (this.isElementVisible(el)) return el;
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
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
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="停止生成"]',
      'button:has(svg rect[x="6"])',
    ];
    for (const sel of selectors) {
      try {
        const btn = document.querySelector(sel);
        if (this.isElementVisible(btn) && !btn.disabled) return btn;
      } catch (_) {}
    }
    return null;
  },

  // 提取当前用户信息文本
  // 优先从 localStorage 的 accountSwitchSessions 读取（稳定，不受 DOM 渲染影响）；
  // 失败再回退到侧边栏 DOM 提取。
  extractUserInfo() {
    // 1. localStorage: oai/apps/accountSwitchSessions -> [0].name
    try {
      const raw = localStorage.getItem('oai/apps/accountSwitchSessions');
      if (raw) {
        const sessions = JSON.parse(raw);
        if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].name) {
          return String(sessions[0].name).trim();
        }
      }
    } catch (_) {}

    // 2. 优先用常见按钮选择器
    const btn = document.querySelector('[data-testid="profile-button"]') ||
      document.querySelector('button[aria-label*="profile" i]') ||
      document.querySelector('button[aria-label*="account" i]');
    if (btn) {
      const aria = btn.getAttribute('aria-label') || '';
      if (aria) return aria.trim();
    }

    // 3. 侧边栏底部用户区：class 含 z-30 的底部固定容器
    const containers = document.querySelectorAll('nav div[class*="z-30"]');
    for (const el of containers) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button').forEach(b => b.remove());
      const text = (clone.textContent || '').trim();
      if (text && text !== 'ChatGPT' && text.length <= 40) {
        return text;
      }
    }
    return '';
  },

  // 首页判断正则（https://chatgpt.com/ 或 https://chatgpt.com）
  homeUrlPattern: /^https:\/\/chatgpt\.com\/?$/,

  // 从 URL 提取会话 ID（ChatGPT 是 /c/xxx 格式）
  // 从 URL 提取会话 ID（ChatGPT 是 /c/{uuid} 格式）
  // 注意：创建会话过程中 URL 有中间态 /c/WEB:xxx，不能把 WEB 当会话 ID。
  // session-store 会优先使用本方法的返回值，故此处必须自行排除 WEB。
  extractSessionId(url) {
    if (!url) return null;
    // 优先匹配完整 UUID（正式会话 ID）
    const uuidMatch = url.match(/\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (uuidMatch) return uuidMatch[1];
    // 回退通用匹配，排除中间态 WEB
    const genericMatch = url.match(/\/c\/([a-zA-Z0-9_-]+)/i);
    if (genericMatch && genericMatch[1] !== 'WEB') return genericMatch[1];
    return null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    return url.includes('chatgpt.com') || url.includes('chat.openai.com');
  },

  // 返回注入主世界的网络拦截器源码（拦截模式使用）
  getHookSource() {
    return '(' + chatgptHookInstaller.toString() + ')();';
  },
};
