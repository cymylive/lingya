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

test('ensureAttached 对未 attach 的 wc 裸 attach（不校验 provider）', () => {
  let attached = false;
  const fake = {
    id: 99,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      sendCommand: async () => ({}),
    },
  };
  const dbg = capture.ensureAttached(fake);
  assert.strictEqual(attached, true);
  assert.strictEqual(dbg, fake.debugger);
});

test('ensureAttached 对已 attach 的直接返回，不重复 attach', () => {
  let attachCalls = 0;
  const fake = {
    id: 98,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach: () => { attachCalls++; },
      sendCommand: async () => ({}),
    },
  };
  capture.ensureAttached(fake);
  assert.strictEqual(attachCalls, 0);
});

test('ensureAttached 对非法 wc 抛异常', () => {
  assert.throws(() => capture.ensureAttached(null), /webContents/);
});

test('requestWillBeSentExtraInfo 只对补全请求派发 headers', () => {
  // 构造一个最小 attach 流程：fake wc + 手动投递 CDP 事件
  const sent = [];
  const listeners = {};
  const fake = {
    id: 8001,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => false,
      attach: () => {},
      detach: () => {},
      sendCommand: async () => ({}),
      on: (ev, cb) => { listeners[ev] = cb; },
      removeListener: () => {},
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
  const r = capture.attach(fake, 'deepseek', {
    onHeaders: (h) => sent.push(h),
  });
  assert.strictEqual(r.ok, true);

  // 1) 无关请求的 ExtraInfo 不得派发
  listeners['message']({}, 'Network.requestWillBeSentExtraInfo', {
    requestId: 'img-1',
    headers: { 'content-type': 'image/png' },
  });
  assert.strictEqual(sent.length, 0, '无关请求的 headers 不得派发');

  // 2) 补全请求先被 requestWillBeSent 登记，再来的 ExtraInfo 才派发
  listeners['message']({}, 'Network.requestWillBeSent', {
    requestId: 'chat-1',
    request: { url: 'https://chat.deepseek.com/api/v0/chat/completion', method: 'POST', postData: '{"prompt":"hi"}' },
  });
  listeners['message']({}, 'Network.requestWillBeSentExtraInfo', {
    requestId: 'chat-1',
    headers: { authorization: 'Bearer xxx' },
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].authorization, 'Bearer xxx');
});

test('trackLifecycle 在 destroyed 时自动 detach', () => {
  const listeners = {};
  let attached = true;
  const fake = {
    id: 7001,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {},
    },
    on: (ev, cb) => { listeners[ev] = cb; },
    once: (ev, cb) => { listeners[ev] = cb; },
  };
  capture.__test.trackLifecycle(fake, {}, 'deepseek');
  assert.strictEqual(typeof listeners['destroyed'], 'function', '必须监听 destroyed');
  listeners['destroyed']();
  assert.strictEqual(capture.isAttached(fake), false);
});

test('连续导航不会累积 did-navigate 监听器', () => {
  const listeners = { 'did-navigate': [] };
  let attached = true;
  const fake = {
    id: 7003,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {},
    },
    on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    once: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    removeListener: (ev, cb) => {
      if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== cb);
    },
  };
  capture.__test.trackLifecycle(fake, {}, 'deepseek');
  const afterFirst = listeners['did-navigate'].length;
  // 连续导航 3 次
  for (let i = 0; i < 3; i++) {
    attached = false;
    listeners['did-navigate'].slice().forEach((fn) => fn());
  }
  assert.strictEqual(
    listeners['did-navigate'].length,
    afterFirst,
    '每次导航不得新增 did-navigate 监听器，否则内存泄漏且一次导航触发多次重连'
  );
});

test('trackLifecycle 在 did-navigate 时重新 attach', () => {
  const listeners = {};
  let attached = true;
  let attachCount = 0;
  const fake = {
    id: 7002,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; attachCount++; },
      detach: () => { attached = false; },
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {},
    },
    on: (ev, cb) => { listeners[ev] = cb; },
    once: (ev, cb) => { listeners[ev] = cb; },
  };
  capture.__test.trackLifecycle(fake, {}, 'deepseek');
  assert.strictEqual(typeof listeners['did-navigate'], 'function', '必须监听 did-navigate');
  // 模拟导航：debugger 被浏览器自动断开
  attached = false;
  listeners['did-navigate']();
  assert.strictEqual(attachCount >= 1, true, '导航后必须重新 attach');
  assert.strictEqual(capture.isAttached(fake), true);
});
