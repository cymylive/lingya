'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveStatus, summarizeTodos } = require('../../src/main/task-status');

const NOW = 1000000;

test('summarizeTodos 统计各状态数量', () => {
  const r = summarizeTodos([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'pending' },
  ]);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.completed, 1);
  assert.strictEqual(r.inProgress, 1);
  assert.strictEqual(r.pending, 2);
});

test('summarizeTodos 空列表', () => {
  const r = summarizeTodos([]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.completed, 0);
});

test('summarizeTodos 非数组返回全 0', () => {
  const r = summarizeTodos(null);
  assert.strictEqual(r.total, 0);
});

test('deriveStatus: 有工具在跑 → running', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'pending' }],
    activity: { running: 1, lastToolName: 'bash', lastAt: NOW - 1000, lastOk: null },
    now: NOW,
  });
  assert.strictEqual(s, 'running');
});

test('deriveStatus: 有 in_progress 且工具刚活动过 → running', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'in_progress' }],
    activity: { running: 0, lastToolName: 'read', lastAt: NOW - 3000, lastOk: true },
    now: NOW,
  });
  assert.strictEqual(s, 'running');
});

test('deriveStatus: 有 in_progress 但工具静默超过 60s → stuck', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'in_progress' }],
    activity: { running: 0, lastToolName: 'read', lastAt: NOW - 90000, lastOk: true },
    now: NOW,
  });
  assert.strictEqual(s, 'stuck');
});

test('deriveStatus: 全部完成 → done', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
    activity: { running: 0, lastToolName: null, lastAt: 0, lastOk: null },
    now: NOW,
  });
  assert.strictEqual(s, 'done');
});

test('deriveStatus: 有 pending 无 in_progress → waiting', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }],
    activity: { running: 0, lastToolName: null, lastAt: 0, lastOk: null },
    now: NOW,
  });
  assert.strictEqual(s, 'waiting');
});

test('deriveStatus: 空 todo 且无活动 → idle', () => {
  const s = deriveStatus({
    todos: [],
    activity: { running: 0, lastToolName: null, lastAt: 0, lastOk: null },
    now: NOW,
  });
  assert.strictEqual(s, 'idle');
});

test('deriveStatus: 最近一次工具失败且无 in_progress → error', () => {
  const s = deriveStatus({
    todos: [{ content: 'a', status: 'completed' }],
    activity: { running: 0, lastToolName: 'bash', lastAt: NOW - 5000, lastOk: false },
    now: NOW,
  });
  assert.strictEqual(s, 'error');
});

test('deriveStatus: activity 缺失时按空处理', () => {
  const s = deriveStatus({ todos: [], now: NOW });
  assert.strictEqual(s, 'idle');
});

test('deriveStatus: todos 缺失时按空处理', () => {
  const s = deriveStatus({ activity: { running: 0, lastAt: 0 }, now: NOW });
  assert.strictEqual(s, 'idle');
});
