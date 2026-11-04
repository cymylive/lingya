'use strict';
/**
 * 状态栏 token 多视图渲染测试
 *
 * 覆盖纯函数逻辑：
 * - upsertTokenEntry：新增 / 覆盖
 * - pruneTokenEntries：按活跃视图集合清理
 * - 格式化沿用现有规则（万 / 亿）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { upsertTokenEntry, pruneTokenEntries, formatTokenCount } =
  require('../../src/preload/shell-token-utils');

test('upsertTokenEntry：新增一个条目', () => {
  const m = new Map();
  const next = upsertTokenEntry(m, 'v1', 100);
  assert.strictEqual(next.get('v1'), 100);
  assert.strictEqual(m.size, 0, '不得修改入参');
});

test('upsertTokenEntry：覆盖已有条目', () => {
  const m = new Map([['v1', 100]]);
  const next = upsertTokenEntry(m, 'v1', 250);
  assert.strictEqual(next.get('v1'), 250);
  assert.strictEqual(m.get('v1'), 100, '入参保持不变');
});

test('upsertTokenEntry：非法 viewKey 或非数值时原样返回', () => {
  const m = new Map([['v1', 1]]);
  assert.strictEqual(upsertTokenEntry(m, '', 5), m);
  assert.strictEqual(upsertTokenEntry(m, 'v1', NaN), m);
  assert.strictEqual(upsertTokenEntry(m, 'v1', 'abc'), m);
});

test('pruneTokenEntries：删除不在活跃集合中的 key', () => {
  const m = new Map([['v1', 1], ['v2', 2], ['v3', 3]]);
  const next = pruneTokenEntries(m, ['v1', 'v3']);
  assert.strictEqual(next.size, 2);
  assert.strictEqual(next.has('v2'), false);
  assert.strictEqual(m.size, 3, '入参保持不变');
});

test('pruneTokenEntries：活跃集合为空时清空', () => {
  const m = new Map([['v1', 1]]);
  const next = pruneTokenEntries(m, []);
  assert.strictEqual(next.size, 0);
});

test('pruneTokenEntries：非数组入参按空集合处理', () => {
  const m = new Map([['v1', 1]]);
  assert.strictEqual(pruneTokenEntries(m, null).size, 0);
});

test('formatTokenCount：万 / 亿 / 原样', () => {
  assert.strictEqual(formatTokenCount(0), '0');
  assert.strictEqual(formatTokenCount(9999), '9999');
  assert.strictEqual(formatTokenCount(12345), '1.23万');
  assert.strictEqual(formatTokenCount(123456789), '1.23亿');
  assert.strictEqual(formatTokenCount(-1), '0');
  assert.strictEqual(formatTokenCount(NaN), '0');
});
