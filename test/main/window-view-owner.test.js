'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

beforeEach(() => {
  delete require.cache[require.resolve('../../src/main/window')];
});

test('视图从原窗口搬到宿主后，仍能查到 OWNER 的 profile/session', () => {
  const ws = require('../../src/main/window');
  const wc = { id: 'moved-wc' };
  const view = { webContents: wc };
  const ownerStore = { state: { owner: true } };

  // 源窗口 B 拥有视图
  const wB = { id: 'B', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wB, 'pB', 'qwen', ownerStore, view);

  // 把视图搬到窗口 A
  const wA = { id: 'A', on: () => {}, isDestroyed: () => false };
  ws.addWindow(wA, 'pA', 'deepseek', { state: { host: true } });
  const ownerCtx = ws.getContextByWebContents(wc);
  ws.addAttachedView('A', view);
  ws.rememberViewOwner(wc, ownerCtx);

  // 销毁源窗口 B（合并的真实流程）
  ws.removeWindow('B');

  // 关键：搬到 A 之后，仍必须返回 B 的 profile/session
  const found = ws.getContextByWebContents(wc);
  assert.ok(found, '视图归属不能丢');
  assert.strictEqual(found.profileId, 'pB');
  assert.strictEqual(found.sessionStore, ownerStore);
  assert.strictEqual(found.win.id, 'B', 'owner 仍是原窗口上下文');
});

test('forgetViewOwner 后归属清除', () => {
  const ws = require('../../src/main/window');
  const wc = { id: 'x-wc' };
  const view = { webContents: wc };
  const w = { id: 'X', on: () => {}, isDestroyed: () => false };
  ws.addWindow(w, 'pX', 'qwen', {}, view);
  const ctx = ws.getContextByWebContents(wc);
  ws.rememberViewOwner(wc, ctx);
  // 窗口销毁后 windows 里查不到，只剩归属表
  ws.removeWindow('X');
  assert.ok(ws.getContextByWebContents(wc), '归属表仍能查到');
  ws.forgetViewOwner(wc);
  assert.strictEqual(ws.getContextByWebContents(wc), null, '清除后彻底查不到');
});
