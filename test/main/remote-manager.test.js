'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

beforeEach(() => {
  delete require.cache[require.resolve('../../src/main/window')];
  delete require.cache[require.resolve('../../src/main/generation-state')];
  delete require.cache[require.resolve('../../src/main/profile-manager')];
  delete require.cache[require.resolve('../../src/main/remote/manager.js')];
});

function makeCtx(profileId, wcId) {
  const winObj = { id: 'w-' + profileId, on: () => {}, isDestroyed: () => false, webContents: { id: wcId + 1000 } };
  return { profileId, view: { webContents: { id: wcId, isDestroyed: () => false, send: () => {} } }, win: winObj };
}
function mountWindow(ctx, id) {
  const ws = require('../../src/main/window');
  ws.addWindow(ctx.win, ctx.profileId, 'deepseek', {}, ctx.view);
  if (id) ctx.win.id = id;
}
test('listProfilesForRemote 返回窗口列表', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const ctx = makeCtx('p1', 11);
  mountWindow(ctx, 'w1');
  const list = mgr.listProfilesForRemote();
  assert.ok(Array.isArray(list));
  assert.ok(list.some(p => p.id === 'p1'));
});
test('markBusy/isBusy/clearBusy 基本语义', () => {
  const mgr = require('../../src/main/remote/manager.js');
  assert.strictEqual(mgr.isBusy(5), false);
  mgr.markBusy(5);
  assert.strictEqual(mgr.isBusy(5), true);
  mgr.clearBusy(5);
  assert.strictEqual(mgr.isBusy(5), false);
});
test('findContextByWcId 命中视图与壳窗口', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const ctx = makeCtx('p2', 21);
  mountWindow(ctx, 'w2');
  assert.strictEqual(mgr.findContextByWcId(21).profileId, 'p2');
  assert.strictEqual(mgr.findContextByWcId(1021).profileId, 'p2');
  assert.strictEqual(mgr.findContextByWcId(9999), null);
});
test('initRemote 后 broadcastAiEvent 不抛异常', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p3', 31);
  mountWindow(ctx, 'w3');
  mgr.broadcastAiEvent(31, 'ai-start', {});
  assert.ok(got.some(m => m.type === 'sys'));
  mgr.stopRemote();
});
test('onUserMessage 目标窗口忙时拒收', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p4', 41);
  mountWindow(ctx, 'w4');
  mgr.markBusy(41);
  mgr.onUserMessage('hi', 'p4');
  assert.ok(got.some(m => m.type === 'sys' && /正在生成/.test(m.text)));
  mgr.stopRemote();
});
test('onUserMessage 空闲时转发到视图', () => {
  const mgr = require('../../src/main/remote/manager.js');
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx = makeCtx('p5', 51);
  let sent = null;
  ctx.view.webContents.send = (ch, payload) => { sent = { ch, payload }; };
  mountWindow(ctx, 'w5');
  mgr.onUserMessage('hello', 'p5');
  assert.ok(sent);
  assert.strictEqual(sent.ch, 'qq-user-message');
  assert.strictEqual(sent.payload.text, 'hello');
  mgr.stopRemote();
});
test('onStop 发送停止通道并清忙态', () => {
  const mgr = require('../../src/main/remote/manager.js');
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx = makeCtx('p6', 61);
  let ch = null;
  ctx.view.webContents.send = (c) => { ch = c; };
  mountWindow(ctx, 'w6');
  mgr.markBusy(61);
  mgr.onStop('p6');
  assert.strictEqual(ch, 'lingya-stop-task');
  assert.strictEqual(mgr.isBusy(61), false);
  mgr.stopRemote();
});
test('profileId 不存在时广播提示', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  mgr.onUserMessage('x', 'no-such-profile');
  assert.ok(got.some(m => m.type === 'sys' && /不可用/.test(m.text)));
  mgr.stopRemote();
});
test('流式事件按 profile 累加并节流广播', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p7', 71);
  mountWindow(ctx, 'w7');
  mgr.broadcastAiEvent(71, 'stream', { text: 'ab' });
  mgr.broadcastAiEvent(71, 'stream', { text: 'cd' });
  await new Promise((r) => setTimeout(r, 60));
  const s = got.find(m => m.type === 'stream');
  assert.ok(s);
  assert.strictEqual(s.profileId, 'p7');
  assert.strictEqual(s.text, 'abcd');
  mgr.stopRemote();
});
