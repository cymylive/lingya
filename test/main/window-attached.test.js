'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

beforeEach(() => {
  delete require.cache[require.resolve('../../src/main/window')];
});

test('addWindow 后 ctx.attachedViews 初始为空数组', () => {
  const ws = require('../../src/main/window');
  const w = { id: 1, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p1', 'deepseek', {});
  const ctx = ws.getWindowContext(1);
  assert.deepStrictEqual(ctx.attachedViews, []);
  assert.strictEqual(ctx.splitDirection, null);
});

test('addAttachedView 可挂多个视图，getContextByWebContents 仍返回 OWNER ctx', () => {
  const ws = require('../../src/main/window');
  const wc = { id: 'attached-wc' };
  const ownerView = { webContents: wc };
  const wB = { id: 'b', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wB, 'pB', 'qwen', { b: 1 }, ownerView);
  const wA = { id: 'a', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wA, 'pA', 'deepseek', { a: 1 });

  ws.addAttachedView('a', ownerView);
  const v2 = { webContents: { id: 'wc2' } };
  ws.addAttachedView('a', v2);

  assert.strictEqual(ws.getWindowContext('a').attachedViews.length, 2);
  const ctx = ws.getContextByWebContents(wc);
  assert.strictEqual(ctx.profileId, 'pB', '必须返回拥有视图的原窗口 B 的 ctx');
});

test('addAttachedView 对不存在的窗口返回 null 不抛错', () => {
  const ws = require('../../src/main/window');
  const r = ws.addAttachedView(999, { webContents: { id: 'x' } });
  assert.strictEqual(r, null);
});

test('addAttachedView 重复挂同一个视图不会重复入数组', () => {
  const ws = require('../../src/main/window');
  const w = { id: 3, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p3', 'qwen', {});
  const view = { webContents: { id: 'dup' } };
  ws.addAttachedView(3, view);
  ws.addAttachedView(3, view);
  assert.strictEqual(ws.getWindowContext(3).attachedViews.length, 1);
});

test('removeAttachedView 移除单个，最后一个移除时清空方向', () => {
  const ws = require('../../src/main/window');
  const w = { id: 4, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p4', 'qwen', {});
  const v1 = { webContents: { id: 'v1' } };
  const v2 = { webContents: { id: 'v2' } };
  ws.addAttachedView(4, v1);
  ws.addAttachedView(4, v2);
  ws.getWindowContext(4).splitDirection = 'horizontal';

  ws.removeAttachedView(4, v1);
  assert.strictEqual(ws.getWindowContext(4).attachedViews.length, 1);
  assert.strictEqual(ws.getWindowContext(4).splitDirection, 'horizontal', '还剩一个时分屏保持');

  ws.removeAttachedView(4, v2);
  assert.strictEqual(ws.getWindowContext(4).attachedViews.length, 0);
  assert.strictEqual(ws.getWindowContext(4).splitDirection, null, '清空后方向归零');
});

test('clearAttachedView 清空全部并归零方向', () => {
  const ws = require('../../src/main/window');
  const w = { id: 5, on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'p5', 'qwen', {});
  ws.addAttachedView(5, { webContents: { id: 'a' } });
  ws.addAttachedView(5, { webContents: { id: 'b' } });
  ws.getWindowContext(5).splitDirection = 'vertical';
  ws.clearAttachedView(5);
  assert.strictEqual(ws.getWindowContext(5).attachedViews.length, 0);
  assert.strictEqual(ws.getWindowContext(5).splitDirection, null);
});
