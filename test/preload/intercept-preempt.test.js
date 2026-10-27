'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;

const { shouldPreempt } = require('../../src/preload/dom/intercept-preempt');

/**
 * 抢占判定：只有「回复里含 lingya 工具代码块」才抢占上一轮执行。
 * 纯聊天不抢占 —— 否则用户随口问一句就会把正在跑的构建杀掉。
 */

test('含 lingya 代码块的回复应触发抢占', () => {
  const text = '我来看看。' + String.fromCharCode(10) +
    FENCE + 'lingya' + String.fromCharCode(10) +
    'const out = await bash("dir");' + String.fromCharCode(10) +
    'log(out);' + String.fromCharCode(10) +
    FENCE;
  assert.strictEqual(shouldPreempt(text), true);
});

test('纯聊天回复不触发抢占', () => {
  assert.strictEqual(shouldPreempt('好的，我明白了，这就去办。'), false);
});

test('带问号的征询回复不触发抢占', () => {
  assert.strictEqual(shouldPreempt('你是要我选 A 还是 B？'), false);
});

test('空文本/null/非字符串不触发抢占', () => {
  assert.strictEqual(shouldPreempt(''), false);
  assert.strictEqual(shouldPreempt(null), false);
  assert.strictEqual(shouldPreempt(undefined), false);
  assert.strictEqual(shouldPreempt(123), false);
});

test('代码块但不是 lingya 围栏（普通示例代码）不触发抢占', () => {
  const text = FENCE + 'js' + String.fromCharCode(10) +
    'const x = 1;' + String.fromCharCode(10) +
    FENCE;
  assert.strictEqual(shouldPreempt(text), false);
});
