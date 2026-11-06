const { test } = require('node:test');
const assert = require('node:assert');

function ensureWindowMock() {
  global.window = global.window || {};
  global.window.electronAPI = global.window.electronAPI || {};
  global.localStorage = global.localStorage || {
    _s: {}, getItem(k) { return this._s[k] != null ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); },
  };
  global.document = global.document || { getElementById: () => null, createRange: () => ({}) };
  global.window.getSelection = global.window.getSelection || (() => ({ removeAllRanges() {}, addRange() {} }));
  global.HTMLTextAreaElement = global.HTMLTextAreaElement || { prototype: {} };
  global.HTMLInputElement = global.HTMLInputElement || { prototype: {} };
}

function makeInput() {
  return {
    tagName: 'TEXTAREA',
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 40 }),
    focus() {},
    select() {},
  };
}

function makeButton() {
  return {
    getBoundingClientRect: () => ({ left: 300, top: 300, width: 40, height: 30 }),
    click() {},
  };
}

test('P1: Enter 路径前调 trustedMouseMoveTo', async () => {
  ensureWindowMock();
  const calls = { move: 0, key: 0, click: 0 };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true, points: 3 }; };
  global.window.electronAPI.trustedKey = async () => { calls.key++; return { success: true }; };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: true }; };

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');

  const input = makeInput();
  const ok = await ci.__test.fallbackSend(null, input);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.key, 1, 'Enter 应被触发');
  assert.strictEqual(calls.move, 1, 'Enter 前应补鼠标轨迹');
  assert.strictEqual(calls.click, 0, 'Enter 成功时不应再点按钮');
});

test('P1: Enter 失败走点击按钮时，不额外调 trustedMouseMove（避免轨迹叠加）', async () => {
  ensureWindowMock();
  const calls = { move: 0, key: 0, click: 0 };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true, points: 3 }; };
  global.window.electronAPI.trustedKey = async () => { calls.key++; return { success: false, error: 'enter blocked' }; };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: true }; };

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');

  const input = makeInput();
  const btn = makeButton();
  const provider = { findSendButton: () => btn };
  const ok = await ci.__test.fallbackSend(provider, input);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.key, 1);
  assert.strictEqual(calls.click, 1, 'Enter 失败后应点按钮');
  // Enter 路径调了一次 trustedMouseMoveTo；点击路径 trustedClickElement 自带轨迹，不再补 move
  assert.strictEqual(calls.move, 1, '只在 Enter 路径补轨迹，点击路径不再补（trustedClickElement 已含轨迹）');
});

test('P1: 全部失败时返回 false', async () => {
  ensureWindowMock();
  const calls = { move: 0, key: 0, click: 0 };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true }; };
  global.window.electronAPI.trustedKey = async () => { calls.key++; return { success: false }; };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: false }; };

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');

  const input = makeInput();
  const btn = makeButton();
  const provider = { findSendButton: () => btn };
  const ok = await ci.__test.fallbackSend(provider, input);
  assert.strictEqual(ok, false);
});

test('P1: input 为空时跳过 Enter 路径，只走点击', async () => {
  ensureWindowMock();
  const calls = { move: 0, key: 0, click: 0 };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true }; };
  global.window.electronAPI.trustedKey = async () => { calls.key++; return { success: true }; };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: true }; };

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');

  const btn = makeButton();
  const provider = { findSendButton: () => btn };
  const ok = await ci.__test.fallbackSend(provider, null);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.key, 0, 'input 为空时不应调 trustedKey');
  assert.strictEqual(calls.click, 1);
  assert.strictEqual(calls.move, 0, 'input 为空时不补轨迹');
});
