'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

beforeEach(() => {
  delete require.cache[require.resolve('../../src/main/window')];
});

test('addWindow 后 ctx.attachedView 初始为 null', () => {
  const ws = require('../../src/main/window');
  const w = { id: 1, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p1', 'deepseek', {});
  assert.strictEqual(ws.getWindowContext(1).attachedView, null);
});

test('addAttachedView 挂载视图后，getContextByWebContents 返回 OWNER ctx 而非宿主', () => {
  const ws = require('../../src/main/window');
  const wc = { id: 'attached-wc' };
  const ownerView = { webContents: wc };
  const wB = { id: 'b', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wB, 'pB', 'qwen', { b: 1 }, ownerView);
  const wA = { id: 'a', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wA, 'pA', 'deepseek', { a: 1 });
  ws.addAttachedView('a', ownerView);
  assert.strictEqual(ws.getWindowContext('a').attachedView, ownerView);
  const ctx = ws.getContextByWebContents(wc);
  assert.strictEqual(ctx.profileId, 'pB', '必须返回拥有视图的原窗口 B 的 ctx');
});

test('addAttachedView 对不存在的窗口返回 null 不抛错', () => {
  const ws = require('../../src/main/window');
  const r = ws.addAttachedView(999, { webContents: { id: 'x' } });
  assert.strictEqual(r, null);
});

test('clearAttachedView 解除挂载', () => {
  const ws = require('../../src/main/window');
  const w = { id: 2, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p2', 'qwen', {});
  ws.addAttachedView(2, { webContents: { id: 'v' } });
  ws.clearAttachedView(2);
  assert.strictEqual(ws.getWindowContext(2).attachedView, null);
});
