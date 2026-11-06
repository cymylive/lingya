const { test } = require('node:test');
const assert = require('node:assert');

// 这里测试的是 chat-input.js 中 setInputContent / fallbackSend 的降级行为。
// 由于 chat-input.js 依赖大量 DOM 与 electronAPI，采用模块级函数抽取 + 轻量 mock。

// 模拟一个最小可用的元素
function makeEl(opts = {}) {
  return {
    tagName: opts.tagName || 'TEXTAREA',
    isContentEditable: !!opts.contentEditable,
    getAttribute: (k) => (k === 'contenteditable' && opts.contentEditable ? 'true' : null),
    getBoundingClientRect: () => opts.rect || { left: 100, top: 100, width: 200, height: 40 },
    focus: opts.focus || function () { this._focused = true; },
    _focused: false,
    select: () => {},
  };
}

// 由于 chat-input.js 是 preload 模块，require 时会执行顶层代码（依赖 window）。
// 用最小 window mock 满足 require 期需要。
function ensureWindowMock() {
  if (global.window && global.window.electronAPI) return;
  global.window = global.window || {};
  global.window.electronAPI = {
    trustedInsertText: async () => ({ success: true }),
    trustedClick: async () => ({ success: true }),
    trustedMouseMove: async () => ({ success: true, points: 5 }),
    getSecurityConfig: async () => ({}),
  };
  global.localStorage = global.localStorage || {
    _s: {},
    getItem(k) { return this._s[k] != null ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
  };
  global.document = global.document || { getElementById: () => null, createRange: () => ({}) };
  global.window.getSelection = global.window.getSelection || (() => ({ removeAllRanges() {}, addRange() {} }));
  global.HTMLTextAreaElement = global.HTMLTextAreaElement || { prototype: {} };
  global.HTMLInputElement = global.HTMLInputElement || { prototype: {} };
}

test('P3 降级：trustedClick 失败时调用 focus() 并调 trustedMouseMove', async () => {
  ensureWindowMock();
  const calls = { click: 0, move: 0, focus: 0, insert: 0 };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: false, error: 'no element' }; };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true, points: 3 }; };
  global.window.electronAPI.trustedInsertText = async () => { calls.insert++; return { success: true }; };

  // 动态 require，确保 mock 先生效
  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');
  const el = makeEl();
  const origFocus = el.focus.bind(el);
  el.focus = function () { calls.focus++; origFocus(); };

  const ok = await ci.__test.setInputContent(el, 'hi');
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.click, 1, 'trustedClick 应被调用一次');
  assert.strictEqual(calls.focus, 1, 'trustedClick 失败后应 fallback focus()');
  assert.strictEqual(calls.move, 1, 'fallback 时应补 trustedMouseMove');
  assert.strictEqual(calls.insert, 1, '最终应调 trustedInsertText');
});

test('P3 成功：trustedClick 成功时不调 focus()、不补 trustedMouseMove', async () => {
  ensureWindowMock();
  const calls = { click: 0, move: 0, focus: 0, insert: 0 };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: true }; };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true }; };
  global.window.electronAPI.trustedInsertText = async () => { calls.insert++; return { success: true }; };

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');
  const el = makeEl();
  el.focus = function () { calls.focus++; };

  const ok = await ci.__test.setInputContent(el, 'hi');
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.click, 1);
  assert.strictEqual(calls.focus, 0, 'trustedClick 成功时不应再调 focus()');
  assert.strictEqual(calls.move, 0, 'trustedClick 成功时不补 trustedMouseMove（避免轨迹叠加）');
});

test('P3 元素无尺寸时跳过点击，直接 fallback', async () => {
  ensureWindowMock();
  const calls = { click: 0, move: 0, focus: 0 };
  global.window.electronAPI.trustedClick = async () => { calls.click++; return { success: true }; };
  global.window.electronAPI.trustedMouseMove = async () => { calls.move++; return { success: true }; };
  global.window.electronAPI.trustedInsertText = async () => ({ success: true });

  delete require.cache[require.resolve('../../src/preload/dom/chat-input')];
  const ci = require('../../src/preload/dom/chat-input');
  const el = makeEl({ rect: { left: 0, top: 0, width: 0, height: 0 } });
  el.focus = function () { calls.focus++; };

  await ci.__test.setInputContent(el, 'x');
  assert.strictEqual(calls.click, 0, '无尺寸元素不应调 trustedClick');
  assert.strictEqual(calls.focus, 1, '无尺寸元素仍应 fallback focus()');
  // trustedMouseMoveTo 对 0 尺寸元素也短路返回 false，不调 API —— move 应为 0
  assert.strictEqual(calls.move, 0, '0 尺寸元素无有效坐标，不调 trustedMouseMove');
});
