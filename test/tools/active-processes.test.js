'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// 【关键】拦截 child_process.execFileSync，避免测试真的调用 taskkill 杀进程。
// 不加这个会导致：① 每个 killAll 用例阻塞 100-700ms（真实启动 taskkill.exe）
// ② 万一假 pid 撞上真实进程，会真的杀掉它。
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'child_process') {
    return {
      execFileSync: () => Buffer.from(''),   // 假实现：立即返回，不启动进程
      spawn: () => { throw new Error('not used'); },
    };
  }
  return origLoad.apply(this, arguments);
};

const ap = require('../../tools/active-processes');

// 恢复，避免影响同进程其他测试
Module._load = origLoad;

/**
 * active-processes：用户点「停止」时 kill 进程树。
 *
 * 审计发现 0 测试覆盖，而它负责真实 kill（Windows 走 taskkill /T 杀整棵树）。
 * 出错后果：key 传错杀别的窗口、owner 未注册导致停止无效。
 *
 * 本测试用假 child 对象（只实现 pid 和 kill），不真的杀进程。
 * 注意：Windows 分支会调 execFileSync('taskkill')，因此测试前需保证 fakeChild.pid 为无效值，
 * 或者用 platform mock。这里选择：Windows 下 pid 用 0（taskkill 会失败但不抛，被 catch 兜住）。
 */

function fakeChild(pid) {
  return {
    pid,
    killed: false,
    kill() { this.killed = true; return true; },
  };
}

beforeEach(() => {
  ap.killAll();       // 清空 active
  ap.clearAborted();  // 清空中止标记
});

// ===================== register / unregister =====================

test('register 后 count 增加', () => {
  ap.register(fakeChild(1001), 'p1');
  assert.strictEqual(ap.count(), 1);
});

test('unregister 后 count 减少', () => {
  const c = fakeChild(1002);
  ap.register(c, 'p1');
  ap.unregister(c);
  assert.strictEqual(ap.count(), 0);
});

test('register 忽略无 kill 方法的对象（防误注册）', () => {
  ap.register({ pid: 999 }, 'p1');
  assert.strictEqual(ap.count(), 0, '没有 kill 方法的对象不应被登记');
});

test('register 忽略 null / undefined', () => {
  ap.register(null, 'p1');
  ap.register(undefined, 'p1');
  assert.strictEqual(ap.count(), 0);
});

test('unregister 不存在的 child 不报错', () => {
  assert.doesNotThrow(() => ap.unregister(fakeChild(1003)));
});

// ===================== killAll 按 key 隔离 =====================

test('killAll(key) 只杀属于该 key 的进程', () => {
  ap.register(fakeChild(2001), 'pA');
  ap.register(fakeChild(2002), 'pB');
  ap.register(fakeChild(2003), 'pA');

  const n = ap.killAll('pA');

  assert.strictEqual(n, 2, 'pA 有 2 个进程，应杀 2 个');
  assert.strictEqual(ap.count(), 1, '剩余 1 个（pB 的）');
});

test('killAll() 不带参杀全部', () => {
  ap.register(fakeChild(3001), 'pA');
  ap.register(fakeChild(3002), 'pB');
  ap.register(fakeChild(3003), null);

  const n = ap.killAll();
  assert.strictEqual(n, 3);
  assert.strictEqual(ap.count(), 0);
});

test('killAll(key) 对不存在的 key 返回 0 且不影响其他', () => {
  ap.register(fakeChild(4001), 'pA');
  const n = ap.killAll('pNotExist');
  assert.strictEqual(n, 0);
  assert.strictEqual(ap.count(), 1, '其他窗口的进程不受影响');
});

test('未注册 key 的进程在 killAll(key) 时不被误杀', () => {
  ap.register(fakeChild(5001));  // 不传 key
  const n = ap.killAll('pA');
  assert.strictEqual(n, 0, '没有归属信息的进程不该被任意 key 杀掉');
  assert.strictEqual(ap.count(), 1);
});

test('killAll 后 active 被清空（不留残骸）', () => {
  ap.register(fakeChild(6001), 'pA');
  ap.register(fakeChild(6002), 'pA');
  ap.killAll('pA');
  assert.strictEqual(ap.count(), 0);
});

test('kill 抛异常的 child 也会被从 active 移除（防泄漏）', () => {
  const bad = {
    pid: 7001,
    kill() { throw new Error('kill failed'); },
  };
  ap.register(bad, 'pA');
  ap.killAll('pA');
  assert.strictEqual(ap.count(), 0, '即使 kill 失败也要移除，否则永久泄漏');
});

// ===================== aborted 标志（三种语义）=====================

test('isAborted() 无参：任一 key 标记即返回 true', () => {
  assert.strictEqual(ap.isAborted(), false);
  ap.markAborted('pA');
  assert.strictEqual(ap.isAborted(), true, '无参查询是「有没有任何 key 被标记」');
});

test('isAborted(key) 只查该 key', () => {
  ap.markAborted('pA');
  assert.strictEqual(ap.isAborted('pA'), true);
  assert.strictEqual(ap.isAborted('pB'), false, 'pB 不受 pA 影响 —— 多窗口隔离的关键');
});

test('markAborted 不带 key 等价于全局标记，影响所有窗口', () => {
  ap.markAborted();
  assert.strictEqual(ap.isAborted('pA'), true);
  assert.strictEqual(ap.isAborted('pB'), true);
});

test('clearAborted(key) 只清该 key', () => {
  ap.markAborted('pA');
  ap.markAborted('pB');
  ap.clearAborted('pA');
  assert.strictEqual(ap.isAborted('pA'), false);
  assert.strictEqual(ap.isAborted('pB'), true, 'pB 的标记不受影响');
});

test('clearAborted() 不带参清空全部', () => {
  ap.markAborted('pA');
  ap.markAborted('pB');
  ap.clearAborted();
  assert.strictEqual(ap.isAborted(), false);
});

test('全局标记与具体 key 共存，clearAborted(key) 清不掉全局', () => {
  ap.markAborted();        // 全局
  ap.markAborted('pA');    // 具体
  ap.clearAborted('pA');
  assert.strictEqual(ap.isAborted('pA'), true, '全局标记仍在，pA 仍判定为中止');
  assert.strictEqual(ap.isAborted('pB'), true, '全局标记影响所有窗口');
});

// ===================== 多窗口隔离（核心不变量）=====================

test('多窗口隔离：A 停止不影响 B 的进程和状态', () => {
  ap.register(fakeChild(8001), 'pA');
  ap.register(fakeChild(8002), 'pB');

  ap.markAborted('pA');
  ap.killAll('pA');

  assert.strictEqual(ap.isAborted('pA'), true, 'A 已被标记中止');
  assert.strictEqual(ap.isAborted('pB'), false, 'B 不应被牵连');
  assert.strictEqual(ap.count(), 1, 'B 的进程仍在运行');
});
