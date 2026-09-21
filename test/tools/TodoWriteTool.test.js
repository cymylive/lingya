'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTodoList, formatTodoOutput, STATUSES } = require('../../tools/TodoWriteTool');

test('parseTodoList 正常列表', () => {
  const list = [
    { content: 'task1', status: 'pending' },
    { content: 'task2', status: 'in_progress' },
    { content: 'task3', status: 'completed' },
  ];
  const r = parseTodoList(list, false);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].content, 'task1');
  assert.strictEqual(r[1].status, 'in_progress');
});

test('parseTodoList content trim', () => {
  const r = parseTodoList([{ content: '  hello  ', status: 'pending' }], false);
  assert.strictEqual(r[0].content, 'hello');
});

test('parseTodoList 非数组抛错', () => {
  assert.throws(() => parseTodoList('not array', false), /todos must be an array/);
  assert.throws(() => parseTodoList(null, false), /todos must be an array/);
});

test('parseTodoList item 非对象抛错', () => {
  assert.throws(() => parseTodoList(['x'], false), /item must be an object/);
  assert.throws(() => parseTodoList([null], false), /item must be an object/);
});

test('parseTodoList content 空抛错', () => {
  assert.throws(() => parseTodoList([{ content: '', status: 'pending' }], false), /content must be a non-empty string/);
  assert.throws(() => parseTodoList([{ status: 'pending' }], false), /content must be a non-empty string/);
});

test('parseTodoList 重复 content 抛错', () => {
  const list = [
    { content: 'dup', status: 'pending' },
    { content: 'dup', status: 'pending' },
  ];
  assert.throws(() => parseTodoList(list, false), /duplicate content/);
});

test('parseTodoList 非法 status 抛错', () => {
  assert.throws(() => parseTodoList([{ content: 'a', status: 'invalid' }], false), /invalid todo status/);
});

test('parseTodoList 多个 in_progress 串行模式抛错', () => {
  const list = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ];
  assert.throws(() => parseTodoList(list, false), /at most one task may be in_progress/);
});

test('parseTodoList 多个 in_progress 并行模式允许', () => {
  const list = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' },
  ];
  const r = parseTodoList(list, true);
  assert.strictEqual(r.length, 2);
});

test('formatTodoOutput 统计', () => {
  const counts = { pending: 1, inProgress: 2, completed: 3 };
  const out = formatTodoOutput(counts);
  assert.strictEqual(out, 'Updated todo list: 1 pending, 2 in progress, 3 completed.');
});

test('STATUSES 包含正确状态', () => {
  assert.deepStrictEqual(STATUSES, ['pending', 'in_progress', 'completed']);
});
