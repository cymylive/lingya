'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkGate, markEstablished, resetGate } = require('../../tools/plan-gate');

test('无会话标识时放行（程序化调用）', () => {
  assert.strictEqual(checkGate('write', {}, null, null).allowed, true);
  assert.strictEqual(checkGate('bash', { command: 'rm a.txt' }, null, null).allowed, true);
});

test('只读工具不受门禁约束', () => {
  resetGate('s1', 'p1');
  assert.strictEqual(checkGate('read', {}, 's1', 'p1').allowed, true);
  assert.strictEqual(checkGate('glob', {}, 's1', 'p1').allowed, true);
  assert.strictEqual(checkGate('grep', {}, 's1', 'p1').allowed, true);
});

test('只读 bash 放行', () => {
  resetGate('s2', 'p1');
  assert.strictEqual(checkGate('bash', { command: 'ls -la' }, 's2', 'p1').allowed, true);
  assert.strictEqual(checkGate('bash', { command: 'git status' }, 's2', 'p1').allowed, true);
});

test('首次写操作被拦，第二次放行', () => {
  resetGate('s3', 'p1');
  const g1 = checkGate('write', { file_path: 'a.txt' }, 's3', 'p1');
  assert.strictEqual(g1.allowed, false);
  assert.ok(g1.error.includes('计划门禁'));
  // 第二次放行（兜底单步任务）
  assert.strictEqual(checkGate('write', { file_path: 'a.txt' }, 's3', 'p1').allowed, true);
});

test('建立计划后解除门禁', () => {
  resetGate('s4', 'p1');
  markEstablished('s4', 'p1');
  assert.strictEqual(checkGate('write', {}, 's4', 'p1').allowed, true);
  assert.strictEqual(checkGate('bash', { command: 'rm a.txt' }, 's4', 'p1').allowed, true);
});

test('写 bash 首次被拦', () => {
  resetGate('s5', 'p1');
  const g = checkGate('bash', { command: 'echo hi > out.txt' }, 's5', 'p1');
  assert.strictEqual(g.allowed, false);
});

test('会话隔离：不同 session 门禁独立', () => {
  resetGate('sa', 'p1');
  resetGate('sb', 'p1');
  markEstablished('sa', 'p1');
  assert.strictEqual(checkGate('write', {}, 'sa', 'p1').allowed, true);
  // sb 未建计划 → 首次仍被拦
  assert.strictEqual(checkGate('write', {}, 'sb', 'p1').allowed, false);
});
