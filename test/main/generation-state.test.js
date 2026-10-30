/**
 * generation-state 单元测试
 * 覆盖：记录/读取、visible=false 清除、过期失效、prune、边界
 */
const test = require('node:test');
const assert = require('node:assert');
const gen = require('../../src/main/generation-state');

test.afterEach(() => {
  // 每个用例后清干净，避免互相污染
  for (const id of [1, 2, 3, 100]) gen.clear(id);
});

test('未记录时返回 null', () => {
  assert.strictEqual(gen.get(1), null);
});

test('记录后能读到 generating', () => {
  gen.set(1, { visible: true, kind: 'busy', text: 'AI 正在思考 / 生成中…' });
  const r = gen.get(1);
  assert.ok(r);
  assert.strictEqual(r.generating, true);
  assert.strictEqual(r.kind, 'busy');
  assert.match(r.text, /生成中/);
});

test('visible=false 清除记录', () => {
  gen.set(1, { visible: true, kind: 'busy', text: 'x' });
  assert.ok(gen.get(1));
  gen.set(1, { visible: false });
  assert.strictEqual(gen.get(1), null);
});

test('webContentsId 为 null 时安全忽略', () => {
  gen.set(null, { visible: true, kind: 'busy', text: 'x' });
  assert.strictEqual(gen.get(null), null);
});

test('超过 STALE_MS 后失效', () => {
  const now = Date.now();
  gen.set(2, { visible: true, kind: 'busy', text: 'x' });
  // 用注入的 now 模拟时间流逝
  assert.ok(gen.get(2, now + gen.STALE_MS - 1000));
  assert.strictEqual(gen.get(2, now + gen.STALE_MS + 1000), null);
});

test('prune 清掉过期条目', () => {
  gen.set(3, { visible: true, kind: 'busy', text: 'x' });
  gen.prune(Date.now() + gen.STALE_MS + 1000);
  assert.strictEqual(gen.get(3), null);
});

test('clear 立即移除', () => {
  gen.set(100, { visible: true, kind: 'busy', text: 'x' });
  gen.clear(100);
  assert.strictEqual(gen.get(100), null);
});

test('不同 webContents 互不干扰', () => {
  gen.set(1, { visible: true, kind: 'busy', text: 'A' });
  gen.set(2, { visible: true, kind: 'executing', text: 'B' });
  assert.strictEqual(gen.get(1).text, 'A');
  assert.strictEqual(gen.get(2).text, 'B');
});
