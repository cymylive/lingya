'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTodoList, formatTodoOutput, STATUSES, TodoWriteTool, getTodos, todoEvents } = require('../../tools/TodoWriteTool');

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

test('getTodos 按 profileId 隔离', async () => {
  const tool = new TodoWriteTool();
  await tool.execute({ profileId: 'pA', todos: [{ content: 'A-1', status: 'pending' }] });
  await tool.execute({ profileId: 'pB', todos: [{ content: 'B-1', status: 'pending' }] });

  assert.deepStrictEqual(getTodos(null, 'pA').todos.map(t => t.content), ['A-1']);
  assert.deepStrictEqual(getTodos(null, 'pB').todos.map(t => t.content), ['B-1']);
  assert.deepStrictEqual(getTodos(null, 'pC').todos, []);
});

test('todoEvents 事件携带 profileId 与 todos', async () => {
  const tool = new TodoWriteTool();
  let payload = null;
  const on = (p) => { payload = p; };
  todoEvents.once('change', on);
  await tool.execute({ profileId: 'pE', todos: [{ content: 'E-1', status: 'in_progress' }] });
  assert.ok(payload);
  assert.strictEqual(payload.profileId, 'pE');
  assert.strictEqual(payload.todos[0].content, 'E-1');
});

test('无 profileId 归入 __default', async () => {
  const tool = new TodoWriteTool();
  await tool.execute({ todos: [{ content: 'D-1', status: 'pending' }] });
  assert.deepStrictEqual(getTodos().todos.map(t => t.content), ['D-1']);
});

test('同一窗口不同会话互相隔离（sessionId 优先）', async () => {
  const tool = new TodoWriteTool();
  // 同一 profileId、不同 sessionId
  await tool.execute({ profileId: 'winA', sessionId: 'sess1', todos: [{ content: '会话1-计划', status: 'pending' }] });
  await tool.execute({ profileId: 'winA', sessionId: 'sess2', todos: [{ content: '会话2-计划', status: 'pending' }] });

  assert.deepStrictEqual(getTodos('sess1', 'winA').todos.map(t => t.content), ['会话1-计划']);
  assert.deepStrictEqual(getTodos('sess2', 'winA').todos.map(t => t.content), ['会话2-计划']);
  // 未指定 sessionId 时读临时键（pending:winA），此前没写过 → 空
  assert.deepStrictEqual(getTodos(null, 'winA').todos, []);
});


// ===================== 计划全部完成时的收尾提示 =====================
// 背景：todoWrite 已经把 archived 算出来了（知道"这是最后一步"），但没传给 AI。
// 结果 AI 收尾汇报可能漏写「任务已完成」→ DONE_HINT_RE 不命中 →
// supervisor 误判任务停滞 → 多催一轮，白费一次对话。
// 修复：archived=true 时在返回值末尾注入收尾指令。

test('计划全部完成时返回值包含收尾指令', async () => {
  const tool = new TodoWriteTool();
  const res = await tool.execute({
    profileId: 'pDone',
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
    ],
  });
  assert.strictEqual(res.success, true);
  assert.ok(res.data.includes('计划已全部完成'), '应包含「计划已全部完成」提示');
  assert.ok(res.data.includes('请收尾'), '应明确要求收尾');
});

test('收尾指令包含「任务已完成」四个字（保证命中 DONE_HINT_RE）', async () => {
  const tool = new TodoWriteTool();
  const res = await tool.execute({
    profileId: 'pDone2',
    todos: [{ content: 'X', status: 'completed' }],
  });
  // 与 intercept-observer 的 DONE_HINT_RE 保持一致
  const DONE_HINT_RE = /(任务已?完成|全部完成|所有(任务|步骤)?(已|都)?完成|均已?完成)/i;
  assert.ok(
    DONE_HINT_RE.test(res.data),
    '工具返回值本身应命中 DONE_HINT_RE，才能确保 AI 照抄后触发停止监督'
  );
});

test('计划未全部完成时不含收尾指令', async () => {
  const tool = new TodoWriteTool();
  const res = await tool.execute({
    profileId: 'pNotDone',
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ],
  });
  assert.strictEqual(res.success, true);
  assert.ok(!res.data.includes('计划已全部完成'), '未完成时不应出现收尾指令');
  assert.ok(!res.data.includes('请收尾'), '未完成时不应要求收尾');
});

test('单条计划全部完成也触发收尾指令', async () => {
  const tool = new TodoWriteTool();
  const res = await tool.execute({
    profileId: 'pSingle',
    todos: [{ content: 'only', status: 'completed' }],
  });
  assert.ok(res.data.includes('请收尾'));
});

test('收尾指令明确要求不要继续调工具', async () => {
  const tool = new TodoWriteTool();
  const res = await tool.execute({
    profileId: 'pNoMoreTool',
    todos: [{ content: 'Z', status: 'completed' }],
  });
  assert.ok(
    /不需要再调用|无需再调用|不要再调用/.test(res.data),
    '收尾指令应明确告知不必再调工具，避免 AI 反复试探'
  );
});

test('formatTodoOutput 本身行为不变（收尾指令不污染它）', () => {
  const counts = { pending: 0, inProgress: 0, completed: 2 };
  assert.strictEqual(
    formatTodoOutput(counts),
    'Updated todo list: 0 pending, 0 in progress, 2 completed.',
    'formatTodoOutput 必须保持纯净，收尾指令在 execute() 层追加'
  );
});
