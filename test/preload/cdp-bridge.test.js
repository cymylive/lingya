const { test } = require('node:test');
const assert = require('node:assert');

test('kind=response 派发 lingya-ai-response 且 detail 结构一致', () => {
  const fired = [];
  const fakeWindow = { dispatchEvent: e => fired.push(e) };
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent(fakeWindow, {
    kind: 'response',
    data: { text: 'hi', finished: true, thinking: '', tokenUsage: null, msgIds: [], interrupted: false },
  });
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].type, 'lingya-ai-response');
  assert.deepStrictEqual(fired[0].detail, {
    text: 'hi', finished: true, thinking: '', tokenUsage: null, msgIds: [], interrupted: false,
  });
});

test('kind=start 派发 lingya-ai-start', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'start' });
  assert.strictEqual(fired[0].type, 'lingya-ai-start');
});

test('kind=interrupted 派发带 interrupted:true 的 response', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, {
    kind: 'interrupted', data: { text: '半截', reason: 'network' },
  });
  assert.strictEqual(fired[0].type, 'lingya-ai-response');
  assert.strictEqual(fired[0].detail.interrupted, true);
  assert.strictEqual(fired[0].detail.finished, true);
  assert.strictEqual(fired[0].detail.text, '半截');
});

test('kind=headers 派发 lingya-ds-headers', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'headers', data: { authorization: 'x' } });
  assert.strictEqual(fired[0].type, 'lingya-ds-headers');
  assert.strictEqual(fired[0].detail.authorization, 'x');
});

test('kind=userMessage 派发 lingya-user-message', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, {
    kind: 'userMessage', data: { text: '你好' },
  });
  assert.strictEqual(fired[0].type, 'lingya-user-message');
  assert.strictEqual(fired[0].detail.text, '你好');
});

test('未知 kind 不派发任何事件', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'unknown' });
  assert.strictEqual(fired.length, 0);
});
