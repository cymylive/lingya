'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 审查发现的 Critical 2：currentSessionId 被 AI 计划与用户待办共享。
 *
 * 两个 refresh 都是 async，并发时后返回的会覆盖前者。
 * 会话切换瞬间可能出现「待办渲染到错误会话」—— 正是用户反馈过的串扰类型。
 *
 * 修复：拆成 planSessionId / userTodoSessionId，各自独立维护。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'overlay', 'plan-panel.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('必须有独立的 planSessionId（AI 计划专用）', () => {
  assert.match(CODE, /let\s+planSessionId/, '缺少 planSessionId 变量');
});

test('必须有独立的 userTodoSessionId（用户待办专用）', () => {
  assert.match(CODE, /let\s+userTodoSessionId/, '缺少 userTodoSessionId 变量');
});

test('refreshTodos 写 planSessionId，不写共享变量', () => {
  const idx = CODE.indexOf('async function refreshTodos');
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 500);
  assert.match(seg, /planSessionId\s*=/, 'refreshTodos 必须写 planSessionId');
  assert.ok(!/currentSessionId\s*=/.test(seg), 'refreshTodos 不应再写 currentSessionId');
});

test('refreshUserTodos 写 userTodoSessionId，不写共享变量', () => {
  const idx = CODE.indexOf('async function refreshUserTodos');
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 500);
  assert.match(seg, /userTodoSessionId\s*=/, 'refreshUserTodos 必须写 userTodoSessionId');
  assert.ok(!/currentSessionId\s*=/.test(seg), 'refreshUserTodos 不应再写 currentSessionId');
});

test('AI 计划广播过滤用 planSessionId', () => {
  const idx = CODE.indexOf("onTodosUpdated");
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 800);
  assert.match(seg, /planSessionId/, 'AI 计划广播过滤必须用 planSessionId');
});

test('用户待办广播过滤用 userTodoSessionId', () => {
  const idx = CODE.indexOf("onUserTodosUpdated");
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 800);
  assert.match(seg, /userTodoSessionId/, '用户待办广播过滤必须用 userTodoSessionId');
});

test('不再有共享的 currentSessionId 变量', () => {
  assert.ok(
    !/let\s+currentSessionId/.test(CODE),
    'currentSessionId 必须被拆分为两个独立变量 —— 共享会导致并发竞态'
  );
});


// ===================== Important 3：编辑态跨会话切换 =====================

test('必须有 editingSessionId 记录编辑所属会话', () => {
  assert.match(CODE, /let\s+editingSessionId/, '缺少 editingSessionId —— 用于判断会话是否已切换');
});

test('renderUserTodos 会话切换时必须强制退出编辑态', () => {
  const idx = CODE.indexOf('function renderUserTodos');
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 900);
  assert.match(
    seg,
    /editingSessionId/,
    'renderUserTodos 必须检查 editingSessionId —— ' +
    '否则切到别的会话后 editingUserId 非空，新会话的待办永远渲染不出来'
  );
  assert.match(seg, /强制退出待办编辑态|editingUserId\s*=\s*null/, '会话切换时必须清空 editingUserId');
});

test('startEditUserTodo 必须记录 editingSessionId', () => {
  const idx = CODE.indexOf('function startEditUserTodo');
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 500);
  assert.match(seg, /editingSessionId\s*=\s*userTodoSessionId/, 'startEdit 必须记录当前会话 id');
});

// ===================== Important 4：静默 catch 加日志 =====================

test('用户待办操作失败不得静默吞错', () => {
  assert.ok(
    !/userTodos(Update|Delete)\([^)]*\)\.catch\(\(\) => \{\}\)/.test(CODE),
    'userTodosUpdate/Delete 的 catch 不能是空函数 —— 用户点了没反应却不知道为什么'
  );
  const warns = (CODE.match(/切换待办状态失败|删除待办失败|保存待办文本失败/g) || []).length;
  assert.ok(warns >= 3, '三个操作的失败路径都应有明确日志，实际 ' + warns + ' 处');
});

test('失败后必须回滚 UI（重新拉取真实状态）', () => {
  const idx = CODE.indexOf('切换待办状态失败');
  assert.ok(idx >= 0);
  const seg = CODE.slice(idx, idx + 200);
  assert.match(seg, /refreshUserTodos/, '失败后应 refreshUserTodos 回滚 UI');
});
