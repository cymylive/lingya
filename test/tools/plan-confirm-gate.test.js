'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  checkGate, markEstablished, markConfirmed, resetGate,
  isAwaitingConfirm, setRequireConfirm,
} = require('../../tools/plan-gate');

/**
 * 计划执行前人工确认（默认开启，可关闭）。
 *
 * 设计（用户确认的推荐方案）：
 *   1. 只在「首次建计划」时要求确认（后续 todoWrite 更新进度直接放行）
 *   2. 确认方式：计划面板按钮 或 用户消息含确认词
 *   3. 默认开启，可关闭
 */

beforeEach(() => {
  resetGate('s1', 'p1');
});

// ===================== 基础门禁行为不变 =====================

test('未建计划时写操作被拦（原有行为）', () => {
  const r = checkGate('write', {}, 's1', 'p1');
  assert.strictEqual(r.allowed, false);
  assert.match(r.error, /计划门禁/);
});

test('markEstablished 后无确认要求时放行', () => {
  setRequireConfirm('s1', 'p1', false); // 关闭确认
  markEstablished('s1', 'p1');
  const r = checkGate('write', {}, 's1', 'p1');
  assert.strictEqual(r.allowed, true);
});

// ===================== 确认机制 =====================

test('开启确认时，markEstablished 后仍被拦（等待确认）', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  const r = checkGate('write', {}, 's1', 'p1');
  assert.strictEqual(r.allowed, false, '已建计划但未确认，应继续拦截');
  assert.match(r.error, /确认/, '错误信息应提示等待确认');
});

test('markConfirmed 后放行', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  markConfirmed('s1', 'p1');
  const r = checkGate('write', {}, 's1', 'p1');
  assert.strictEqual(r.allowed, true);
});

test('isAwaitingConfirm 状态查询', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), true, '建计划后应为等待确认');
  markConfirmed('s1', 'p1');
  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), false, '确认后不再等待');
});

test('关闭确认时 isAwaitingConfirm 恒为 false', () => {
  setRequireConfirm('s1', 'p1', false);
  markEstablished('s1', 'p1');
  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), false);
});

test('会话隔离：s1 等待确认不影响 s2', () => {
  resetGate('s2', 'p1');
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  setRequireConfirm('s2', 'p1', false);
  markEstablished('s2', 'p1');

  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), true);
  assert.strictEqual(isAwaitingConfirm('s2', 'p1'), false);
  assert.strictEqual(checkGate('write', {}, 's2', 'p1').allowed, true);
});

test('只读工具不受确认机制影响', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  // read 不在 WRITE_TOOLS 里
  assert.strictEqual(checkGate('read', {}, 's1', 'p1').allowed, true);
});

test('只读 bash 不受确认机制影响', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  assert.strictEqual(checkGate('bash', { command: 'ls -la' }, 's1', 'p1').allowed, true);
});

test('resetGate 清除等待状态', () => {
  setRequireConfirm('s1', 'p1', true);
  markEstablished('s1', 'p1');
  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), true);
  resetGate('s1', 'p1');
  assert.strictEqual(isAwaitingConfirm('s1', 'p1'), false);
});
