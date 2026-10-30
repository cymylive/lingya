'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

beforeEach(() => {
  delete require.cache[require.resolve('../../src/main/activity-tracker')];
});

test('未记录过的会话返回空活动', () => {
  const at = require('../../src/main/activity-tracker');
  const r = at.get('p1::s1');
  assert.strictEqual(r.running, 0);
  assert.strictEqual(r.lastToolName, null);
  assert.strictEqual(r.lastAt, 0);
  assert.strictEqual(r.lastOk, null);
});

test('start 后 running 加一，记录工具名', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'bash');
  const r = at.get('p1::s1');
  assert.strictEqual(r.running, 1);
  assert.strictEqual(r.lastToolName, 'bash');
  assert.ok(r.lastAt > 0);
});

test('多次 start 累加 running', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'read');
  at.start('p1::s1', 'grep');
  assert.strictEqual(at.get('p1::s1').running, 2);
});

test('end 成功：running 减一，lastOk 为 true', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'bash');
  at.end('p1::s1', true);
  const r = at.get('p1::s1');
  assert.strictEqual(r.running, 0);
  assert.strictEqual(r.lastOk, true);
});

test('end 失败：lastOk 为 false', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'bash');
  at.end('p1::s1', false);
  assert.strictEqual(at.get('p1::s1').lastOk, false);
});

test('end 不会让 running 变负', () => {
  const at = require('../../src/main/activity-tracker');
  at.end('p1::s1', true);
  at.end('p1::s1', true);
  assert.strictEqual(at.get('p1::s1').running, 0);
});

test('不同会话互不影响', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'bash');
  at.start('p2::s2', 'read');
  at.end('p1::s1', true);
  assert.strictEqual(at.get('p1::s1').running, 0);
  assert.strictEqual(at.get('p2::s2').running, 1);
});

test('clear 清空指定会话', () => {
  const at = require('../../src/main/activity-tracker');
  at.start('p1::s1', 'bash');
  at.clear('p1::s1');
  assert.strictEqual(at.get('p1::s1').running, 0);
  assert.strictEqual(at.get('p1::s1').lastToolName, null);
});
