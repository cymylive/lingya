/**
 * tool-lifecycle 单元测试
 * 验证：ID 自分配、外部 ID 拒绝、会话隔离、只清已完成
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('register 分配唯一 ID', () => {
  const tl = require('../../tools/tool-lifecycle');
  const a = tl.register('p::s1', 'read');
  const b = tl.register('p::s1', 'read');
  assert.notStrictEqual(a, b);
  assert.ok(a.startsWith('tl_'));
});

test('markDone 拒绝非本模块登记的 ID', () => {
  const tl = require('../../tools/tool-lifecycle');
  assert.strictEqual(tl.markDone('external-call-id'), false);
  assert.strictEqual(tl.markDone('js_123_abc'), false);
  assert.strictEqual(tl.attach('external-id', {}), false);
});

test('markDone 接受本模块登记的 ID', () => {
  const tl = require('../../tools/tool-lifecycle');
  const id = tl.register('p::s2', 'bash');
  assert.strictEqual(tl.markDone(id), true);
});

test('sweepSession 只清指定会话的已完成条目（会话隔离）', () => {
  const tl = require('../../tools/tool-lifecycle');
  const idA = tl.register('iso::A', 'read');
  const idB = tl.register('iso::B', 'read');
  const holderA = { data: 'x'.repeat(1000) };
  tl.attach(idA, holderA);
  tl.markDone(idA);
  tl.markDone(idB);

  const cleaned = tl.sweepSession('iso::A', 0);
  assert.strictEqual(cleaned, 1, '只应清理 A 会话的 1 条');
  assert.strictEqual(holderA.data, null, 'holder 应被释放');

  // B 会话的条目不该被 A 的清理影响
  const stats = tl.stats();
  assert.ok(stats.bySession['iso::B'] >= 1, 'B 会话条目应仍在');
});

test('sweep 不清理 running 状态的条目', () => {
  const tl = require('../../tools/tool-lifecycle');
  tl.register('run::test', 'sleepy'); // 不 markDone
  const before = tl.stats().running;
  tl.sweep(0);
  const after = tl.stats().running;
  assert.strictEqual(before, after, 'running 条目不应被 sweep 清掉');
});

test('attach 后 holder 引用在 sweep 时被释放', () => {
  const tl = require('../../tools/tool-lifecycle');
  const id = tl.register('rel::test', 'bigread');
  const holder = { data: 'large', output: 'logs', images: [1, 2, 3] };
  tl.attach(id, holder);
  tl.markDone(id);
  tl.sweepSession('rel::test', 0);
  assert.strictEqual(holder.data, null);
  assert.strictEqual(holder.output, '');
  assert.deepStrictEqual(holder.images, []);
});

test('stats 返回结构正确', () => {
  const tl = require('../../tools/tool-lifecycle');
  const s = tl.stats();
  assert.strictEqual(typeof s.total, 'number');
  assert.strictEqual(typeof s.running, 'number');
  assert.strictEqual(typeof s.done, 'number');
  assert.strictEqual(typeof s.bySession, 'object');
});
