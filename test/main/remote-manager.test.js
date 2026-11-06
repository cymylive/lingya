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

test('broadcastAiEvent ai-start 广播 ai-start', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p3', 31);
  mountWindow(ctx, 'w3');
  mgr.broadcastAiEvent(31, 'ai-start', {});
  assert.ok(got.some(m => m.type === 'ai-start' && m.profileId === 'p3'));
  assert.ok(mgr.isBusy(31));
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
  assert.ok(got.some(m => m.type === 'sys' && /正在执行任务/.test(m.text)));
  mgr.stopRemote();
});

test('onUserMessage 空闲时走 remote-user-message 通道', () => {
  const mgr = require('../../src/main/remote/manager.js');
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx = makeCtx('p5', 51);
  let sent = null;
  ctx.view.webContents.send = (ch, payload) => { sent = { ch, payload }; };
  mountWindow(ctx, 'w5');
  mgr.onUserMessage('hello', 'p5');
  assert.ok(sent);
  assert.strictEqual(sent.ch, 'remote-user-message');
  assert.strictEqual(sent.payload.text, 'hello');
  mgr.stopRemote();
});

test('onStop 发送停止通道并广播 ai-stop', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p6', 61);
  let ch = null;
  ctx.view.webContents.send = (c) => { ch = c; };
  mountWindow(ctx, 'w6');
  mgr.markBusy(61);
  mgr.onStop('p6');
  assert.strictEqual(ch, 'lingya-stop-task');
  assert.strictEqual(mgr.isBusy(61), false);
  assert.ok(got.some(m => m.type === 'ai-stop' && m.reason === 'user'));
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

test('流式事件按 profile 累加并节流广播 ai-stream', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p7', 71);
  mountWindow(ctx, 'w7');
  mgr.broadcastAiEvent(71, 'stream', { text: 'ab' });
  mgr.broadcastAiEvent(71, 'stream', { text: 'cd' });
  await new Promise((r) => setTimeout(r, 60));
  const s = got.find(m => m.type === 'ai-stream');
  assert.ok(s);
  assert.strictEqual(s.profileId, 'p7');
  assert.strictEqual(s.textDelta, 'abcd');
  assert.strictEqual(s.reset, false);
  mgr.stopRemote();
});

test('全量快照覆盖不重复（prefix 匹配时 reset=false）', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p8', 81);
  mountWindow(ctx, 'w8');
  mgr.broadcastAiEvent(81, 'stream', { full: 'abc' });
  await new Promise((r) => setTimeout(r, 40));
  mgr.broadcastAiEvent(81, 'stream', { full: 'abcdef' });
  await new Promise((r) => setTimeout(r, 40));
  const streams = got.filter(m => m.type === 'ai-stream');
  assert.strictEqual(streams[0].textDelta, 'abc');
  assert.strictEqual(streams[0].reset, false);
  assert.strictEqual(streams[1].textDelta, 'def');
  assert.strictEqual(streams[1].reset, false);
  mgr.stopRemote();
});

test('前缀不匹配触发 reset=true 且发全量', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p9', 91);
  mountWindow(ctx, 'w9');
  mgr.broadcastAiEvent(91, 'stream', { full: 'abcXYZ' });
  await new Promise((r) => setTimeout(r, 40));
  mgr.broadcastAiEvent(91, 'stream', { full: 'abc' });
  await new Promise((r) => setTimeout(r, 40));
  const streams = got.filter(m => m.type === 'ai-stream');
  const last = streams[streams.length - 1];
  assert.strictEqual(last.reset, true);
  assert.strictEqual(last.textDelta, 'abc');
  mgr.stopRemote();
});

test('ai-reply 清忙态并广播 ai-reply', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p10', 101);
  mountWindow(ctx, 'w10');
  mgr.markBusy(101);
  mgr.broadcastAiEvent(101, 'ai-reply', { text: 'final' });
  assert.ok(got.some(m => m.type === 'ai-reply' && m.text === 'final'));
  assert.strictEqual(mgr.isBusy(101), false);
  mgr.stopRemote();
});

test('error 清忙态并广播 ai-error', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p11', 111);
  mountWindow(ctx, 'w11');
  mgr.markBusy(111);
  mgr.broadcastAiEvent(111, 'error', { text: 'boom' });
  assert.ok(got.some(m => m.type === 'ai-error' && m.text === 'boom'));
  assert.strictEqual(mgr.isBusy(111), false);
  mgr.stopRemote();
});

test('tool-start / tool-end 广播 tool 事件', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const got = [];
  mgr.initRemote({ server: { broadcast: (m) => got.push(m) } });
  const ctx = makeCtx('p12', 121);
  mountWindow(ctx, 'w12');
  mgr.broadcastAiEvent(121, 'tool-start', { name: 'Read' });
  mgr.broadcastAiEvent(121, 'tool-end', { name: 'Read' });
  const tools = got.filter(m => m.type === 'tool');
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].name, 'Read');
  assert.strictEqual(tools[1].ended, true);
  mgr.stopRemote();
});

test('onNewClient 发送 history + 活跃流', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const sent = [];
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx = makeCtx('p13', 131);
  mountWindow(ctx, 'w13');
  mgr.broadcastAiEvent(131, 'ai-start', {});
  mgr.broadcastAiEvent(131, 'stream', { full: 'hello' });
  const fakeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  mgr.onNewClient(fakeWs);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sent.some(m => m.type === 'history'));
  assert.ok(sent.some(m => m.type === 'ai-stream' && m.textDelta === 'hello'));
  mgr.stopRemote();
});

test('onSelectProfile 切换目标并回报 profiles', () => {
  const mgr = require('../../src/main/remote/manager.js');
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx1 = makeCtx('pa', 141);
  const ctx2 = makeCtx('pb', 142);
  mountWindow(ctx1, 'wa');
  mountWindow(ctx2, 'wb');
  const sent = [];
  const fakeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  mgr.onSelectProfile('pb', fakeWs);
  assert.ok(sent.some(m => m.type === 'profiles' && m.currentProfileId === 'pb'));
  mgr.stopRemote();
});

test('cleanupStreamState 清理窗口状态', () => {
  const mgr = require('../../src/main/remote/manager.js');
  mgr.initRemote({ server: { broadcast: () => {} } });
  const ctx = makeCtx('p14', 151);
  mountWindow(ctx, 'w14');
  mgr.markBusy(151);
  mgr.broadcastAiEvent(151, 'ai-start', {});
  mgr.cleanupStreamState('p14');
  assert.strictEqual(mgr.isBusy(151), false);
  mgr.stopRemote();
});

/* ===== 历史补发（readHistoryForContext）===== */

test('readHistoryForContext：正常读历史 + 映射 user/assistant/system', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createConversationArchive } = require('../../src/main/conversation-archive');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-rm-hist-'));
  const a = createConversationArchive('ph1', tmp);
  a.appendEntry('sess-1', { role: 'user', text: '你好', ts: 1 });
  a.appendEntry('sess-1', { role: 'assistant', text: '你好呀', ts: 2 });
  a.appendEntry('sess-1', { role: 'user', text: '拒绝改写请求', ts: 3, tag: '拒绝改写请求' });
  a.flush();
  const dd = require('../../src/main/data-dir');
  const orig = dd.resolveDataDir;
  dd.resolveDataDir = () => tmp;
  try {
    const ctx = { profileId: 'ph1', sessionStore: { state: { currentSessionId: 'sess-1' } } };
    const h = mgr.readHistoryForContext(ctx);
    assert.strictEqual(h.length, 3);
    assert.strictEqual(h[0].t, 'user');
    assert.strictEqual(h[0].text, '你好');
    assert.strictEqual(h[1].t, 'assistant');
    assert.strictEqual(h[2].t, 'system');
  } finally {
    dd.resolveDataDir = orig;
  }
});

test('readHistoryForContext：无 sessionStore / 无 sessionId 返回空', () => {
  const mgr = require('../../src/main/remote/manager.js');
  assert.deepStrictEqual(mgr.readHistoryForContext(null), []);
  assert.deepStrictEqual(mgr.readHistoryForContext({ profileId: 'p' }), []);
  assert.deepStrictEqual(mgr.readHistoryForContext({ profileId: 'p', sessionStore: { state: {} } }), []);
});

test('readHistoryForContext：截断到最近 40 条', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createConversationArchive } = require('../../src/main/conversation-archive');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-rm-hist40-'));
  const a = createConversationArchive('ph2', tmp);
  for (let i = 0; i < 60; i++) {
    a.appendEntry('sess-2', { role: 'user', text: 'msg' + i, ts: i });
  }
  a.flush();
  const dd = require('../../src/main/data-dir');
  const orig = dd.resolveDataDir;
  dd.resolveDataDir = () => tmp;
  try {
    const ctx = { profileId: 'ph2', sessionStore: { state: { currentSessionId: 'sess-2' } } };
    const h = mgr.readHistoryForContext(ctx);
    assert.strictEqual(h.length, 40);
    assert.strictEqual(h[0].text, 'msg20');
    assert.strictEqual(h[39].text, 'msg59');
  } finally {
    dd.resolveDataDir = orig;
  }
});

test('readHistoryForContext：读盘异常 / 无存档返回空数组不抛', () => {
  const mgr = require('../../src/main/remote/manager.js');
  const dd = require('../../src/main/data-dir');
  const orig = dd.resolveDataDir;
  dd.resolveDataDir = () => 'Z:/definitely/not/exist/xyz';
  try {
    const ctx = { profileId: 'p9', sessionStore: { state: { currentSessionId: 'nope' } } };
    const h = mgr.readHistoryForContext(ctx);
    assert.deepStrictEqual(h, []);
  } finally {
    dd.resolveDataDir = orig;
  }
});

test('onNewClient：有历史时先发 history 再发活跃流', async () => {
  const mgr = require('../../src/main/remote/manager.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createConversationArchive } = require('../../src/main/conversation-archive');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-rm-onnew-'));
  const a = createConversationArchive('ph3', tmp);
  a.appendEntry('sess-3', { role: 'user', text: '历史消息', ts: 1 });
  a.flush();
  const dd = require('../../src/main/data-dir');
  const orig = dd.resolveDataDir;
  dd.resolveDataDir = () => tmp;
  const got = [];
  mgr.initRemote({ server: { broadcast: () => {} } });
  // 用 mountWindow + 直接给 win 加 sessionStore
  const ctx = makeCtx('ph3', 211);
  ctx.sessionStore = { state: { currentSessionId: 'sess-3' } };
  mountWindow(ctx, 'w21');
  // 让 getMainContext 命中该 ctx
  const ws = require('../../src/main/window');
  try { ws.setMainWindow && ws.setMainWindow(ctx.win, 'ph3', 'deepseek', {}, ctx.view); } catch (_) {}
  mgr.broadcastAiEvent(211, 'ai-start', {});
  mgr.broadcastAiEvent(211, 'stream', { full: '进行中' });
  const fakeWs = { readyState: 1, send: (raw) => got.push(JSON.parse(raw)) };
  mgr.onNewClient(fakeWs);
  await new Promise((r) => setTimeout(r, 60));
  const idxHistory = got.findIndex(m => m.type === 'history');
  const idxStream = got.findIndex(m => m.type === 'ai-stream');
  assert.ok(idxHistory >= 0, '应发 history');
  assert.ok(idxStream >= 0, '应发活跃流');
  assert.ok(idxHistory < idxStream, 'history 必须先于活跃流');
  mgr.stopRemote();
  dd.resolveDataDir = orig;
});
