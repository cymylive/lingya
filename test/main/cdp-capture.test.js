const { test } = require('node:test');
const assert = require('node:assert');
const capture = require('../../src/main/cdp-capture');

test('attach 对非法 webContents 返回错误而非抛异常', () => {
  const r = capture.attach(null, 'deepseek', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /webContents/);
});

test('isAttached 对未 attach 的返回 false', () => {
  const fake = { debugger: { isAttached: () => false } };
  assert.strictEqual(capture.isAttached(fake), false);
});

test('base64Encoded 的 body 被正确解码为 UTF-8', async () => {
  const raw = 'data: {"p":"response/content","v":"中文"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n';
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  const fake = {
    sendCommand: async (cmd) => {
      assert.strictEqual(cmd, 'Network.getResponseBody');
      return { body: b64, base64Encoded: true };
    },
  };
  const got = [];
  await capture.__test.handleLoadingFinished(fake, 'deepseek', { requestId: '1' }, {
    onResponse: p => got.push(p),
  });
  assert.strictEqual(got[0].text, '中文');
  assert.strictEqual(got[0].finished, true);
});

test('未 base64Encoded 的 body 原样使用', async () => {
  const raw = 'data: {"p":"response/content","v":"纯文本"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n';
  const fake = { sendCommand: async () => ({ body: raw, base64Encoded: false }) };
  const got = [];
  await capture.__test.handleLoadingFinished(fake, 'deepseek', { requestId: '1' }, {
    onResponse: p => got.push(p),
  });
  assert.strictEqual(got[0].text, '纯文本');
});

test('loadingFailed 触发 onInterrupted', () => {
  const got = [];
  capture.__test.handleLoadingFailed({ requestId: '1', errorText: 'net::ERR' }, {
    onInterrupted: r => got.push(r),
  });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0], 'net::ERR');
});

test('getResponseBody 失败时走 onInterrupted 而非崩溃', async () => {
  const fake = { sendCommand: async () => { throw new Error('No resource'); } };
  const got = [];
  await capture.__test.handleLoadingFinished(fake, 'deepseek', { requestId: '1' }, {
    onResponse: () => { throw new Error('不该被调用'); },
    onInterrupted: r => got.push(r),
  });
  assert.strictEqual(got.length, 1);
  assert.match(got[0], /body_unavailable/);
});

test('extractUserMessage 从 prompt 字段提取', () => {
  const r = capture.__test.extractUserMessage(JSON.stringify({ prompt: '你好' }));
  assert.strictEqual(r, '你好');
});

test('extractUserMessage 对非法 JSON 返回 null', () => {
  assert.strictEqual(capture.__test.extractUserMessage('not json'), null);
});

test('attach 对不支持的 provider 返回错误', () => {
  const fake = { debugger: { isAttached: () => false, attach: () => {} }, id: 1 };
  const r = capture.attach(fake, 'claude', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unsupported/);
});
