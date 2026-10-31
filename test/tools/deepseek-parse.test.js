const { test } = require('node:test');
const assert = require('node:assert');
const sse = require('../../src/providers/sse/deepseek-parse');

test('序列化后的函数在主世界沙箱中可执行且无外部依赖', () => {
  // toString() 后注入页面主世界，模块级变量（如 COMPLETION_PATH）会丢失。
  // 用 vm 模拟：只带函数源码本身，不带模块作用域，能跑通才算自包含。
  const vm = require('node:vm');
  const src = [
    sse.isCompletion.toString(),
    sse.createFrameDecoder.toString(),
    sse.parseBlock.toString(),
    sse.createExtractor.toString(),
  ].join('\n');
  const ctx = vm.createContext({ URL, console });
  vm.runInContext(src, ctx);
  assert.strictEqual(
    vm.runInContext("isCompletion('https://chat.deepseek.com/api/v0/chat/completion','POST')", ctx),
    true
  );
  const decoded = vm.runInContext("(function(){var d=createFrameDecoder();return d.push('data: a\\n\\n')})()", ctx);
  assert.deepStrictEqual(Array.from(decoded), ['data: a']);
});

test('getHookSource 返回的源码在沙箱执行后 hook 生效且无 require', () => {
  const vm = require('node:vm');
  const provider = require('../../src/providers/deepseek');
  const src = provider.getHookSource();
  // 不得含 require —— 主世界没有模块系统
  assert.doesNotMatch(src, /\brequire\s*\(/);
  // 在伪浏览器环境执行，确认 hook 装上且 window.fetch 被替换
  const fakeWindow = { dispatchEvent: () => true, fetch: function(){ return Promise.resolve({}); } };
  const ctx = vm.createContext({ window: fakeWindow, URL, console, CustomEvent: function(){}, TextDecoder, setTimeout, clearTimeout, XMLHttpRequest: function(){ XMLHttpRequest.prototype.open=function(){}; XMLHttpRequest.prototype.send=function(){}; XMLHttpRequest.prototype.setRequestHeader=function(){}; } });
  ctx.XMLHttpRequest.prototype = { open(){}, send(){}, setRequestHeader(){} };
  vm.runInContext(src, ctx);
  assert.strictEqual(fakeWindow[Symbol.for('l.hook.ds')], true);
  assert.strictEqual(typeof fakeWindow.fetch, 'function');
});

test('getHookSource 返回的源码包含四个解析函数', () => {
  const provider = require('../../src/providers/deepseek');
  const src = provider.getHookSource();
  assert.match(src, /function createFrameDecoder/);
  assert.match(src, /function parseBlock/);
  assert.match(src, /function createExtractor/);
  assert.match(src, /function isCompletion/);
});

test('isCompletion 识别 DeepSeek 补全接口', () => {
  assert.strictEqual(sse.isCompletion('https://chat.deepseek.com/api/v0/chat/completion', 'POST'), true);
  assert.strictEqual(sse.isCompletion('https://chat.deepseek.com/api/v0/users', 'GET'), false);
});

test('createFrameDecoder 按空行切帧，跨 chunk 保持残留', () => {
  const d = sse.createFrameDecoder();
  assert.deepStrictEqual(d.push('data: a\n\ndata: b'), ['data: a']);
  assert.deepStrictEqual(d.push('\n\n'), ['data: b']);
});

test('parseFullBody 处理中文与 emoji', () => {
  const body = 'data: {"p":"response/content","v":"你好🦆"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n';
  assert.strictEqual(sse.parseFullBody(body).text, '你好🦆');
});

test('parseFullBody 未收到 FINISHED 时标记 interrupted', () => {
  const body = 'data: {"p":"response/content","v":"半截"}\n\n';
  const r = sse.parseFullBody(body);
  assert.strictEqual(r.text, '半截');
  assert.strictEqual(r.interrupted, true);
});

test('parseFullBody 空 body 不抛异常', () => {
  const r = sse.parseFullBody('');
  assert.strictEqual(r.text, '');
});

test('parseFullBody 从完整 SSE body 提取正文', () => {
  const body = 'data: {"v":"Hello"}\n\ndata: {"p":"response/content","v":" world"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n';
  const r = sse.parseFullBody(body);
  assert.strictEqual(r.text, 'Hello world');
  assert.strictEqual(r.finished, true);
});
