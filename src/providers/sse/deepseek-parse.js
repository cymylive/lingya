/**
 * DeepSeek SSE 流解析 —— 纯函数模块。
 *
 * 从 providers/deepseek.js 的 getHookSource() 内联实现中抽出，
 * 供两条路径共用：
 *   1. 页面内 hook（通过 Function.prototype.toString() 序列化注入）
 *   2. 主进程 CDP 捕获（响应结束后 parseFullBody 解析全量 body）
 *
 * 抽取约束：不得依赖任何外层闭包、window、document 等运行环境对象，
 * 否则 toString() 序列化后注入主世界会 ReferenceError。
 */

// 主路径（已知的 DeepSeek 流式补全端点）
var COMPLETION_PATH = '/api/v0/chat/completion';

/**
 * 判断是否为「AI 回复流式请求」。
 *
 * 不严格等值：DeepSeek 会改端点细节（版本号 / 子路径 / trailing slash）。
 * 严格等值一旦不匹配，isCompletion 永远 false → 事件永不派发 → Agent 循环
 * 静默失效。放宽为：POST + 路径以 /api/v 开头 + 含 chat + 含 completion。
 *
 * baseURI 在浏览器内可用；主进程调用时退化为直接解析 url。
 */
function isCompletion(url, method) {
  if (!url) return false;
  if (String(method || 'GET').toUpperCase() !== 'POST') return false;
  var pathname;
  try {
    var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : 'http://localhost/';
    pathname = new URL(url, base).pathname;
  } catch (e) {
    pathname = String(url).split('?')[0];
  }
  if (pathname === COMPLETION_PATH) return true;
  return /^\/api\/v[\d.]+\/chat\//.test(pathname) && /completion/i.test(pathname);
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

// ---------- 回复文本提取（区分 THINK / RESPONSE 片段）----------
function createExtractor() {
  var fragmentTypes = [];
  var currentIndex = -1;
  var observed = false;
  var text = '';
  var thinking = '';
  var finished = false;
  var interrupted = false;
  var tokenUsage = null;
  var msgIds = null;

  function captureMsgIds(src) {
    if (!src || typeof src !== 'object') return;
    if (!msgIds) msgIds = {};
    if (typeof src.request_message_id === 'number') msgIds.requestMessageId = src.request_message_id;
    if (typeof src.response_message_id === 'number') msgIds.responseMessageId = src.response_message_id;
    if (typeof src.message_id === 'number') msgIds.responseMessageId = src.message_id;
    if (typeof src.parent_id === 'number') msgIds.requestMessageId = src.parent_id;
  }

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
      if (isThink(types[i])) thinking += c;
      else text += c;
    }
  }

  function consume(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
      for (var i = 0; i < parsed.v.length; i++) consume(parsed.v[i]);
      return;
    }
    captureMsgIds(parsed);
    if (parsed.v && typeof parsed.v === 'object' && parsed.v.response && typeof parsed.v.response === 'object') {
      captureTokenUsage(parsed.v.response);
      captureMsgIds(parsed.v.response);
    }
    if (typeof parsed.p === 'string' && lastSeg(parsed.p) === 'accumulated_token_usage' && typeof parsed.v === 'number') {
      captureTokenUsage({ accumulated_token_usage: parsed.v });
    }
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
    if (isThinkingPatch(parsed.p) && typeof parsed.v === 'string') { thinking += parsed.v; return; }
    if (typeof parsed.p === 'string' && isResponseTextPatch(parsed.p) && typeof parsed.v === 'string') {
      var m = /^response\/fragments\/(-?\d+)\//.exec(parsed.p);
      var idx = m ? Number(m[1]) : -1;
      if (isThink(typeAt(idx))) thinking += parsed.v;
      else text += parsed.v;
      return;
    }
    if (parsed.p === undefined && typeof parsed.v === 'string') {
      if (isThink(typeAt(currentIndex))) thinking += parsed.v;
      else text += parsed.v;
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
    get thinking() { return thinking; },
    get finished() { return finished; },
    get interrupted() { return interrupted; },
    get tokenUsage() { return tokenUsage; },
    get msgIds() { return msgIds; }
  };
}

/**
 * 一次性解析完整的 SSE body（CDP getResponseBody 拿到的全量）。
 * 返回结构与 lingya-ai-response 的 detail 一致。
 */
function parseFullBody(bodyText) {
  var extractor = createExtractor();
  if (!bodyText) {
    return {
      text: '', thinking: '', finished: false, interrupted: true,
      tokenUsage: null, msgIds: null,
    };
  }
  var decoder = createFrameDecoder();
  var frames = decoder.push(bodyText).concat(decoder.finish());
  for (var i = 0; i < frames.length; i++) {
    var parsed = parseBlock(frames[i]);
    if (parsed) extractor.consume(parsed);
  }
  var interrupted = extractor.interrupted || !extractor.finished;
  return {
    text: extractor.text,
    thinking: extractor.thinking,
    finished: extractor.finished,
    interrupted: interrupted,
    tokenUsage: extractor.tokenUsage,
    msgIds: extractor.msgIds,
  };
}

module.exports = {
  isCompletion,
  createFrameDecoder,
  parseBlock,
  createExtractor,
  parseFullBody,
};
