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
 * 被抢占方必须拿到「抢占」语义的失败，而不是「用户停止」。
 * AI 看到不同文案会做不同决策：
 *  - "用户停止" → 应停下来等用户，不再自动重试
 *  - "被抢占"   → 说明有新一轮在跑，自己这轮的结果已被淘汰，不必重试
 */

beforeEach(() => {
  ap.killAll();
  ap.clearAborted();
});

test('PREEMPT_ERROR 含抢占与中止两个关键语义', () => {
  assert.match(ap.PREEMPT_ERROR, /抢占/);
  assert.match(ap.PREEMPT_ERROR, /中止/);
});

test('markAborted 可带 reason，isAborted 能区分抢占与用户停止', () => {
  const k = ap.abortKey('p1', 's1');
  ap.markAborted(k, 'preempt');
  assert.strictEqual(ap.isAborted(k), true);
  assert.strictEqual(ap.getAbortReason(k), 'preempt');
  ap.clearAborted(k);
});

test('不带 reason 的 markAborted 默认为用户停止', () => {
  const k = ap.abortKey('p2', 's2');
  ap.markAborted(k);
  assert.strictEqual(ap.getAbortReason(k), 'stop');
  ap.clearAborted(k);
});

test('getAbortReason 对未标记的 key 返回 null', () => {
  const k = ap.abortKey('p3', 's3');
  assert.strictEqual(ap.getAbortReason(k), null);
});

test('全局标记的 reason 也能被读出', () => {
  ap.markAborted(undefined, 'preempt');
  assert.strictEqual(ap.getAbortReason(ap.abortKey('p4', 's4')), 'preempt');
  ap.clearAborted();
});
