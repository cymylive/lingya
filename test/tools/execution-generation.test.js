'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'child_process') {
    return { execFileSync: () => Buffer.from(''), spawn: () => { throw new Error('not used'); } };
  }
  return origLoad.apply(this, arguments);
};
const ap = require('../../tools/active-processes');
Module._load = origLoad;

/**
 * 执行代际（execution generation）
 *
 * 【为什么必须存在】抢占如果用 markAborted(key) 实现，新脚本启动时读的是同一个 key，
 * 会被自己刚设的中止标记拦住 —— 功能完全不生效。代际把「谁被中止」精确到某一次执行：
 * 抢占让旧代际失效，新执行拿新代际，互不干扰。
 */

beforeEach(() => {
  ap.killAll();
  ap.clearAborted();
});

test('beginExecution 返回递增的 id', () => {
  const k = 'k1';
  const a = ap.beginExecution(k);
  const b = ap.beginExecution(k);
  assert.ok(b > a, '第二次执行应拿到更大的代际号');
});

test('新执行开始后，旧代际立即失效', () => {
  const k = 'k2';
  const a = ap.beginExecution(k);
  assert.strictEqual(ap.isCurrentExecution(k, a), true);
  ap.beginExecution(k);
  assert.strictEqual(ap.isCurrentExecution(k, a), false, '旧执行必须失效，否则两个脚本会同时跑');
});

test('killRunning 让当前代际失效，但不产生 abort 标记', () => {
  const k = 'k3';
  const a = ap.beginExecution(k);
  ap.killRunning(k);
  assert.strictEqual(ap.isCurrentExecution(k, a), false);
  assert.strictEqual(ap.isAborted(k), false, '抢占不得留下中止标记 —— 否则新执行一启动就被自己拦住');
});

test('killRunning 后新执行可正常开始并被视为当前', () => {
  const k = 'k4';
  ap.beginExecution(k);
  ap.killRunning(k);
  const b = ap.beginExecution(k);
  assert.strictEqual(ap.isCurrentExecution(k, b), true, '抢占后的新执行必须能正常跑');
});

test('endExecution 只清理匹配的代际，不误删新执行', () => {
  const k = 'k5';
  const a = ap.beginExecution(k);
  const b = ap.beginExecution(k);
  ap.endExecution(k, a);   // 旧执行收尾
  assert.strictEqual(ap.isCurrentExecution(k, b), true, '旧执行收尾不得把新执行的状态清掉');
});

test('不同 key 的代际互不影响', () => {
  const a = ap.beginExecution('kA');
  const b = ap.beginExecution('kB');
  assert.strictEqual(ap.isCurrentExecution('kA', a), true);
  assert.strictEqual(ap.isCurrentExecution('kB', b), true);
  ap.killRunning('kA');
  assert.strictEqual(ap.isCurrentExecution('kA', a), false);
  assert.strictEqual(ap.isCurrentExecution('kB', b), true, 'B 不受 A 抢占影响');
});
