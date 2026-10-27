'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// 同 active-processes.test.js：拦截 execFileSync，避免真调 taskkill
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'child_process') {
    return {
      execFileSync: () => Buffer.from(''),
      spawn: () => { throw new Error('not used'); },
    };
  }
  return origLoad.apply(this, arguments);
};

const ap = require('../../tools/active-processes');

Module._load = origLoad;

/**
 * preempt-execution IPC 的底层行为验证。
 * IPC handler 本身需要 electron 环境，这里只验证它依赖的 active-processes 语义：
 *  1. 抢占后 abortKey 处于 aborted 状态（让旧脚本下一次工具调用立即失败）
 *  2. 抢占只杀前台，后台任务必须存活（否则构建/服务被误杀）
 */

function fakeChild(pid) {
  return { pid, killed: false, kill() { this.killed = true; return true; } };
}

beforeEach(() => {
  ap.killAll();
  ap.clearAborted();
});

test('preempt 后 abortKey 处于 aborted 状态', () => {
  const key = ap.abortKey('p1', 's1');
  ap.markAborted(key);
  assert.strictEqual(ap.isAborted(key), true);
  ap.clearAborted(key);
  assert.strictEqual(ap.isAborted(key), false);
});

test('preempt 清理不影响后台进程', () => {
  const bg = fakeChild(99);
  const key = ap.abortKey('p2', 's2');
  ap.register(bg, key, 'background');
  const n = ap.killForeground(key);
  assert.strictEqual(n, 0, '后台进程不该被抢占杀掉');
  assert.strictEqual(ap.count(), 1, '后台进程仍在跟踪列表中');
  ap.unregister(bg);
});

test('preempt 杀掉前台但保留后台', () => {
  const key = ap.abortKey('p3', 's3');
  ap.register(fakeChild(101), key, 'foreground');
  ap.register(fakeChild(102), key, 'foreground');
  ap.register(fakeChild(103), key, 'background');

  const n = ap.killForeground(key);

  assert.strictEqual(n, 2, '两个前台被杀');
  assert.strictEqual(ap.count(), 1, '只剩后台');
});

test('preempt 的 abortKey 带 sessionId，跨会话隔离', () => {
  const keyA = ap.abortKey('p4', 'sA');
  const keyB = ap.abortKey('p4', 'sB');
  ap.markAborted(keyA);
  assert.strictEqual(ap.isAborted(keyA), true);
  assert.strictEqual(ap.isAborted(keyB), false, 'B 会话不得被 A 会话的抢占牵连');
});

test('PREEMPT_ERROR 文案含「抢占」且可被 AI 理解', () => {
  assert.match(ap.PREEMPT_ERROR, /抢占/);
  assert.match(ap.PREEMPT_ERROR, /中止/);
});
