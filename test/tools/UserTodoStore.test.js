'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  init, list, add, update, remove, clear, parseBulk,
} = require('../../tools/UserTodoStore');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-utodo-'));
  init(tmpDir);
});

// ===================== add =====================

test('add 生成 ut_ 前缀 id 并持久化', () => {
  const a = add('s1', 'p1', '买牛奶');
  assert.match(a.id, /^ut_/);
  assert.strictEqual(a.text, '买牛奶');
  assert.strictEqual(a.done, false);
  assert.strictEqual(typeof a.createdAt, 'number');
  assert.strictEqual(list('s1', 'p1').length, 1);
});

test('add 拒绝空文本', () => {
  assert.throws(() => add('s1', 'p1', ''), /empty/i);
  assert.throws(() => add('s1', 'p1', '   '), /empty/i);
  assert.throws(() => add('s1', 'p1', null), /empty/i);
});

test('add 拒绝超长文本（>500）', () => {
  assert.throws(() => add('s1', 'p1', 'x'.repeat(501)), /too long/i);
  // 边界：500 字符允许
  assert.doesNotThrow(() => add('s1', 'p1', 'x'.repeat(500)));
});

test('add 自动 trim', () => {
  const a = add('s1', 'p1', '  待办  ');
  assert.strictEqual(a.text, '待办');
});

// ===================== 会话隔离 =====================

test('会话隔离：s1 的待办不出现在 s2', () => {
  add('s1', 'p1', 'A');
  add('s2', 'p1', 'B');
  assert.deepStrictEqual(list('s1', 'p1').map(t => t.text), ['A']);
  assert.deepStrictEqual(list('s2', 'p1').map(t => t.text), ['B']);
});

test('同一 sessionId 跨 profile 共享待办（会话本身是全局唯一的）', () => {
  // sessionId 是平台侧全局唯一 ID。两个窗口打开同一个会话时，
  // 看待办应是同一份 —— 否则用户在 A 窗口记的待办在 B 窗口看不到，会困惑。
  add('s1', 'p1', 'P1 记的');
  assert.deepStrictEqual(list('s1', 'p2').map(t => t.text), ['P1 记的']);
  add('s1', 'p2', 'P2 追加的');
  assert.deepStrictEqual(list('s1', 'p1').map(t => t.text), ['P1 记的', 'P2 追加的']);
});

test('无 sessionId 时用 pending:profileId 分键', () => {
  add(null, 'p9', 'X');
  assert.deepStrictEqual(list(null, 'p9').map(t => t.text), ['X']);
  // 不同 profile 不串
  assert.deepStrictEqual(list(null, 'p8'), []);
});

test('未知会话返回空数组', () => {
  assert.deepStrictEqual(list('never-used', 'p1'), []);
});

// ===================== update =====================

test('update 改文本', () => {
  const a = add('s1', 'p1', 'old');
  assert.strictEqual(update('s1', 'p1', a.id, { text: 'new' }), true);
  assert.strictEqual(list('s1', 'p1')[0].text, 'new');
});

test('update 改勾选状态', () => {
  const a = add('s1', 'p1', 'x');
  assert.strictEqual(update('s1', 'p1', a.id, { done: true }), true);
  assert.strictEqual(list('s1', 'p1')[0].done, true);
});

test('update 同时改文本与状态', () => {
  const a = add('s1', 'p1', 'old');
  update('s1', 'p1', a.id, { text: 'new', done: true });
  const got = list('s1', 'p1')[0];
  assert.strictEqual(got.text, 'new');
  assert.strictEqual(got.done, true);
});

test('update 对不存在的 id 返回 false', () => {
  assert.strictEqual(update('s1', 'p1', 'nope', { done: true }), false);
});

test('update 拒绝把文本改成空', () => {
  const a = add('s1', 'p1', 'x');
  assert.throws(() => update('s1', 'p1', a.id, { text: '   ' }), /empty/i);
});

test('update 保留 id 与 createdAt', () => {
  const a = add('s1', 'p1', 'x');
  update('s1', 'p1', a.id, { text: 'y' });
  const got = list('s1', 'p1')[0];
  assert.strictEqual(got.id, a.id);
  assert.strictEqual(got.createdAt, a.createdAt);
});

// ===================== remove / clear =====================

test('remove 删除指定项', () => {
  const a = add('s1', 'p1', 'A');
  const b = add('s1', 'p1', 'B');
  assert.strictEqual(remove('s1', 'p1', a.id), true);
  assert.deepStrictEqual(list('s1', 'p1').map(t => t.text), ['B']);
});

test('remove 对不存在的 id 返回 false', () => {
  assert.strictEqual(remove('s1', 'p1', 'nope'), false);
});

test('clear 清空该会话所有待办', () => {
  add('s1', 'p1', 'A');
  add('s1', 'p1', 'B');
  clear('s1', 'p1');
  assert.deepStrictEqual(list('s1', 'p1'), []);
});

test('clear 不影响其他会话', () => {
  add('s1', 'p1', 'A');
  add('s2', 'p1', 'B');
  clear('s1', 'p1');
  assert.deepStrictEqual(list('s2', 'p1').map(t => t.text), ['B']);
});

// ===================== 持久化 =====================

test('重启后数据仍在（重新 init 读回）', () => {
  add('s1', 'p1', '持久化');
  init(tmpDir); // 模拟重启
  assert.deepStrictEqual(list('s1', 'p1').map(t => t.text), ['持久化']);
});

test('存储文件名必须是 lingya-user-todos.json（与 AI 计划完全分离）', () => {
  add('s1', 'p1', 'x');
  const files = fs.readdirSync(tmpDir);
  assert.ok(files.includes('lingya-user-todos.json'), '实际文件: ' + files.join(','));
  assert.ok(!files.includes('lingya-todos.json'), '绝不能写到 AI 计划文件');
});

test('文件损坏时不崩溃，返回空', () => {
  fs.writeFileSync(path.join(tmpDir, 'lingya-user-todos.json'), '{坏JSON', 'utf-8');
  init(tmpDir);
  assert.deepStrictEqual(list('s1', 'p1'), []);
});

// ===================== parseBulk =====================

test('parseBulk 按数字列表拆条', () => {
  assert.deepStrictEqual(parseBulk('1. 买菜\n2. 做饭'), ['买菜', '做饭']);
});

test('parseBulk 按短横线拆条', () => {
  assert.deepStrictEqual(parseBulk('- a\n- b'), ['a', 'b']);
});

test('parseBulk 按圆点/星号拆条', () => {
  assert.deepStrictEqual(parseBulk('• a\n* b'), ['a', 'b']);
});

test('parseBulk 混合标记也拆', () => {
  assert.deepStrictEqual(parseBulk('1. a\n- b\n• c'), ['a', 'b', 'c']);
});

test('parseBulk 纯文本多行不拆（整段保留）', () => {
  assert.deepStrictEqual(parseBulk('这是\n一段话'), ['这是\n一段话']);
});

test('parseBulk 单行无标记返回单元素', () => {
  assert.deepStrictEqual(parseBulk('买牛奶'), ['买牛奶']);
});

test('parseBulk 空输入返回空数组', () => {
  assert.deepStrictEqual(parseBulk(''), []);
  assert.deepStrictEqual(parseBulk('   '), []);
  assert.deepStrictEqual(parseBulk(null), []);
});

test('parseBulk 过滤空行', () => {
  assert.deepStrictEqual(parseBulk('1. a\n\n2. b\n'), ['a', 'b']);
});

test('parseBulk 支持 1、2、 中文顿号与括号', () => {
  assert.deepStrictEqual(parseBulk('1、a\n2) b\n3. c'), ['a', 'b', 'c']);
});
