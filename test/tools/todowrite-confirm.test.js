'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  TodoWriteTool,
} = require('../../tools/TodoWriteTool');
const {
  resetGate,
  setRequireConfirm,
  setRequireConfirmEnabled,
  isAwaitingConfirm,
} = require('../../tools/plan-gate');

/**
 * todoWrite 在首次建计划时，若开启确认，应：
 *   1. 返回值明确告知 AI「等用户确认，不要继续执行」
 *   2. 让 plan-gate 进入 awaitingConfirm 状态
 *
 * 后续 todoWrite（已进入 awaitingConfirm / 已确认）时不再重复要求。
 */

beforeEach(() => {
  resetGate('s1', 'p1');
  setRequireConfirmEnabled(false);
});

test('关闭确认时返回值不含确认提示', async () => {
  setRequireConfirm('s1', 'p1', false);
  const tool = new TodoWriteTool();
  const r = await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }],
  });
  assert.strictEqual(r.success, true);
  assert.ok(!/等待确认|确认执行/.test(r.data), '关闭确认时不应出现确认提示');
});

test('开启确认时首次建计划返回确认提示', async () => {
  setRequireConfirm('s1', 'p1', true);
  const tool = new TodoWriteTool();
  const r = await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }],
  });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /确认执行|等待.*确认/, '返回值必须要求 AI 等用户确认');
  assert.ok(isAwaitingConfirm('s1', 'p1'), 'plan-gate 应进入等待确认状态');
});

test('已有等待确认状态时，再次 todoWrite 仍提示（避免 AI 误解）', async () => {
  setRequireConfirm('s1', 'p1', true);
  const tool = new TodoWriteTool();
  await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'pending' }],
  });
  // 第二次更新（AI 可能重试）
  const r2 = await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'in_progress' }],
  });
  assert.match(r2.data, /确认执行|等待.*确认/, '仍在等待确认，必须继续提醒');
});

test('确认后 todoWrite 不再提示确认', async () => {
  setRequireConfirm('s1', 'p1', true);
  const tool = new TodoWriteTool();
  await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'pending' }],
  });
  // 模拟用户确认
  const { markConfirmed } = require('../../tools/plan-gate');
  markConfirmed('s1', 'p1');
  // 更新进度
  const r2 = await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'completed' }],
  });
  assert.ok(!/等待确认|确认执行/.test(r2.data), '已确认后不应再提示');
});

test('会话隔离：s2 不受 s1 等待确认影响', async () => {
  resetGate('s2', 'p1');
  setRequireConfirm('s1', 'p1', true);
  setRequireConfirm('s2', 'p1', false);
  const tool = new TodoWriteTool();
  const r1 = await tool.execute({
    sessionId: 's1', profileId: 'p1',
    todos: [{ content: 'A', status: 'pending' }],
  });
  const r2 = await tool.execute({
    sessionId: 's2', profileId: 'p1',
    todos: [{ content: 'B', status: 'pending' }],
  });
  assert.match(r1.data, /确认/);
  assert.ok(!/等待确认|确认执行/.test(r2.data));
});
