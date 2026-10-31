const { test } = require('node:test');
const assert = require('node:assert');

// 【封号风险改造 2026-11-01】事件名改为每会话随机后缀（evt-names.js）。
// 测试改为从 evt-names 读取实际事件名，断言不再硬编码明文。
const evtNames = require('../../src/preload/dom/evt-names');

test('kind=response 派发 AI_RESPONSE 且 detail 结构一致', () => {
  const fired = [];
  const fakeWindow = { dispatchEvent: e => fired.push(e) };
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent(fakeWindow, {
    kind: 'response',
    data: { text: 'hi', finished: true, thinking: '', tokenUsage: null, msgIds: [], interrupted: false },
  });
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].type, evtNames.AI_RESPONSE);
  assert.deepStrictEqual(fired[0].detail, {
    text: 'hi', finished: true, thinking: '', tokenUsage: null, msgIds: [], interrupted: false,
  });
});

test('kind=start 派发 AI_START', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'start' });
  assert.strictEqual(fired[0].type, evtNames.AI_START);
});

test('kind=interrupted 派发带 interrupted:true 的 response', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, {
    kind: 'interrupted', data: { text: '半截', reason: 'network' },
  });
  assert.strictEqual(fired[0].type, evtNames.AI_RESPONSE);
  assert.strictEqual(fired[0].detail.interrupted, true);
  assert.strictEqual(fired[0].detail.finished, true);
  assert.strictEqual(fired[0].detail.text, '半截');
});

test('kind=headers 派发 DS_HEADERS', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'headers', data: { authorization: 'x' } });
  assert.strictEqual(fired[0].type, evtNames.DS_HEADERS);
  assert.strictEqual(fired[0].detail.authorization, 'x');
});

test('kind=userMessage 派发 USER_MESSAGE', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, {
    kind: 'userMessage', data: { text: '你好' },
  });
  assert.strictEqual(fired[0].type, evtNames.USER_MESSAGE);
  assert.strictEqual(fired[0].detail.text, '你好');
});

test('未知 kind 不派发任何事件', () => {
  const fired = [];
  const bridge = require('../../src/preload/dom/cdp-bridge');
  bridge.__test.handleEvent({ dispatchEvent: e => fired.push(e) }, { kind: 'unknown' });
  assert.strictEqual(fired.length, 0);
});

test('evt-names 后缀确实存在且随机（防预埋监听器）', () => {
  assert.ok(evtNames.SUFFIX && evtNames.SUFFIX.length >= 6, '后缀应至少 6 字符');
  // 每个事件名都应包含后缀
  for (const k of ['AI_START', 'AI_RESPONSE', 'AI_ERROR', 'USER_MESSAGE', 'DS_HEADERS', 'HOOK_READY']) {
    assert.ok(evtNames[k].endsWith(evtNames.SUFFIX), k + ' 应以 SUFFIX 结尾');
  }
  // DEFAULTS 是无后缀的明文版本（供向后兼容）
  assert.strictEqual(evtNames.DEFAULTS.AI_RESPONSE, 'lingya-ai-response');
});
