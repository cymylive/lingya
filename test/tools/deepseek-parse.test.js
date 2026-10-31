const { test } = require('node:test');
const assert = require('node:assert');
const sse = require('../../src/providers/sse/deepseek-parse');

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
