
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rot = require('../../src/main/token-rotation');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'token-rotation-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  rot.init(tmpDir);
  rot._resetForTest();
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('默认配置：关闭、阈值 10 万、上限 2MB', () => {
  const c = rot.getConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.thresholdWan, 10);
  assert.equal(c.historyMaxBytes, 2097152);
  assert.equal(c.maxRotations, 5);
  assert.equal(c.maxSessionHours, 4);
  assert.equal(c.preferDifferentAccount, true);
  assert.equal(c.targetBusyWaitMs, 60000);
  assert.deepEqual(c.pool, []);
  assert.equal(c.cursor, 0);
});

test('updateConfig 局部合并并落盘', () => {
  rot.updateConfig({ enabled: true, thresholdWan: 15 });
  const c = rot.getConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.thresholdWan, 15);
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'token-rotation.json'), 'utf-8'));
  assert.equal(raw.thresholdWan, 15);
});

test('updateConfig 归一化非法值', () => {
  rot.updateConfig({ thresholdWan: -3, maxRotations: 'abc', historyMaxBytes: 0 });
  const c = rot.getConfig();
  assert.equal(c.thresholdWan, 10, '负数回落默认');
  assert.equal(c.maxRotations, 5, '非数字回落默认');
  assert.equal(c.historyMaxBytes, 2097152, '0 回落默认');
});

test('resetState 把 cursor 归零并清计数器', () => {
  rot.updateConfig({ cursor: 2 });
  rot.resetState();
  assert.equal(rot.getConfig().cursor, 0);
});

test('配置损坏时回落默认值不抛错', () => {
  fs.writeFileSync(path.join(tmpDir, 'token-rotation.json'), '{broken', 'utf-8');
  rot.init(tmpDir);
  assert.equal(rot.getConfig().thresholdWan, 10);
});


// ===== Task 2: selectNextIndex =====
const pool3 = [
  { profileId: 'p1', accountTag: 'A', enabled: true },
  { profileId: 'p2', accountTag: 'B', enabled: true },
  { profileId: 'p3', accountTag: 'C', enabled: true },
];
const allAvail = () => true;

test('按 cursor 顺序环形推进', () => {
  const o = { preferDifferentAccount: false, sourceAccountTag: 'A' };
  assert.equal(rot.selectNextIndex(pool3, 0, allAvail, o), 1);
  assert.equal(rot.selectNextIndex(pool3, 1, allAvail, o), 2);
  assert.equal(rot.selectNextIndex(pool3, 2, allAvail, o), 0);
});

test('跳过 disabled 与不可用窗口', () => {
  const pool = [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'B', enabled: false },
    { profileId: 'p3', accountTag: 'C', enabled: true },
  ];
  const avail = (id) => id === 'p3';
  assert.equal(rot.selectNextIndex(pool, 0, avail, { preferDifferentAccount: false }), 2);
});

test('优先不同账号', () => {
  const pool = [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'A', enabled: true },
    { profileId: 'p3', accountTag: 'B', enabled: true },
  ];
  const idx = rot.selectNextIndex(pool, 0, allAvail, { preferDifferentAccount: true, sourceAccountTag: 'A' });
  assert.equal(idx, 2, '跳过同账号的 p2');
});

test('全同账号时降级为顺序选，不返回 -1', () => {
  const pool = [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'A', enabled: true },
  ];
  const idx = rot.selectNextIndex(pool, 0, allAvail, { preferDifferentAccount: true, sourceAccountTag: 'A' });
  assert.equal(idx, 1, '放宽后仍能选中 p2');
});

test('无可用窗口返回 -1', () => {
  assert.equal(rot.selectNextIndex(pool3, 0, () => false, { preferDifferentAccount: false }), -1);
  assert.equal(rot.selectNextIndex([], 0, allAvail, { preferDifferentAccount: false }), -1);
});

// ===== Task 3: submit / ack / 看门狗 =====
test('submit 成功派发并推进 cursor（ack 后）', async () => {
  rot.updateConfig({
    enabled: true,
    pool: [
      { profileId: 'p1', accountTag: 'A', enabled: true },
      { profileId: 'p2', accountTag: 'B', enabled: true },
    ],
    cursor: 0,
  });
  let dispatched = null;
  const deps = {
    isAvailable: () => true,
    dispatch: async (pid, reqId, data) => { dispatched = { pid, reqId, data }; },
    onResult: () => {},
  };
  const r = await rot.submit('p1', 'A', { history: 'h', oldSessionId: 's1' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.targetProfileId, 'p2');
  assert.equal(dispatched.pid, 'p2');
  assert.equal(rot.getConfig().cursor, 0, 'ack 前不推进');
  rot.ack(r.requestId, true);
  assert.equal(rot.getConfig().cursor, 1, 'ack 后推进到 p2');
});

test('ack(false) 不推进 cursor', async () => {
  rot.updateConfig({
    enabled: true,
    pool: [
      { profileId: 'p1', accountTag: 'A', enabled: true },
      { profileId: 'p2', accountTag: 'B', enabled: true },
    ],
    cursor: 0,
  });
  const deps = { isAvailable: () => true, dispatch: async () => {}, onResult: () => {} };
  const r = await rot.submit('p1', 'A', { history: 'h' }, deps);
  rot.ack(r.requestId, false, 'target failed');
  assert.equal(rot.getConfig().cursor, 0);
  assert.equal(rot._pendingSize(), 0);
});

test('未启用时直接返回 disabled', async () => {
  rot.updateConfig({ enabled: false });
  const r = await rot.submit('p1', 'A', {}, { isAvailable: () => true, dispatch: async () => {}, onResult: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
});

test('无可用窗口返回 no-target', async () => {
  rot.updateConfig({ enabled: true, pool: [{ profileId: 'p1', accountTag: 'A', enabled: true }] });
  const r = await rot.submit('p1', 'A', {}, { isAvailable: () => false, dispatch: async () => {}, onResult: () => {} });
  assert.equal(r.reason, 'no-target');
});

test('ack 超时后回告失败', async (t) => {
  rot.updateConfig({ enabled: true, pool: [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'B', enabled: true },
  ], cursor: 0 });
  let result = null;
  const deps = { isAvailable: () => true, dispatch: async () => {}, onResult: (sid, r) => { result = r; } };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await rot.submit('p1', 'A', {}, deps);
  t.mock.timers.tick(90001);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(rot._pendingSize(), 0);
});

test('dispatch 抛错返回 dispatch-failed 且不留 pending', async () => {
  rot.updateConfig({ enabled: true, pool: [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'B', enabled: true },
  ], cursor: 0 });
  const deps = { isAvailable: () => true, dispatch: async () => { throw new Error('boom'); }, onResult: () => {} };
  const r = await rot.submit('p1', 'A', {}, deps);
  assert.equal(r.reason, 'dispatch-failed');
  assert.equal(rot._pendingSize(), 0);
});




// ===== Review Focus 1：目标窗口忙时等待 =====
test('全池都忙时先等 targetBusyWaitMs 再重试，期间转空闲则成功', async () => {
  rot.updateConfig({ enabled: true, pool: [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'B', enabled: true },
  ], cursor: 0, targetBusyWaitMs: 50 });
  let p2Calls = 0;
  const deps = {
    // p1 始终忙；p2 前 2 次忙（两遍扫描各一次），之后转空闲（模拟 AI 生成结束）
    isAvailable: (pid) => {
      if (pid === 'p1') return false;
      p2Calls++;
      return p2Calls > 2;
    },
    dispatch: async () => {},
    onResult: () => {},
  };
  const r = await rot.submit('p1', 'A', {}, deps);
  assert.equal(r.ok, true, '等待后应能选中 p2');
  assert.equal(r.targetProfileId, 'p2');
  assert.ok(p2Calls >= 3, '必须重试过');
});

test('等待期满仍全忙则返回 no-target', async () => {
  rot.updateConfig({ enabled: true, pool: [
    { profileId: 'p1', accountTag: 'A', enabled: true },
    { profileId: 'p2', accountTag: 'B', enabled: true },
  ], cursor: 0, targetBusyWaitMs: 30 });
  const deps = { isAvailable: () => false, dispatch: async () => {}, onResult: () => {} };
  const r = await rot.submit('p1', 'A', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-target');
});
