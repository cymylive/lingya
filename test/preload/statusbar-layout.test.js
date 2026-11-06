const { test } = require('node:test');
const assert = require('node:assert');
const { computeVisibleCount, ITEM_ESTIMATED_WIDTH, OVERFLOW_BUTTON_WIDTH } = require('../../src/preload/statusbar-layout');

test('全部放得下时 folded 为 0', () => {
  const r = computeVisibleCount(2000, [240, 240, 240]);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 0);
});

test('放不下时按宽度截断', () => {
  // 可用 1000，每块 240，溢出按钮 64 → 最多放 (1000-64)/240 = 3.9 → 3 个
  const widths = [240,240,240,240,240,240,240,240];
  const r = computeVisibleCount(1000, widths);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 5);
});

test('恰好放得下时不折叠', () => {
  const r = computeVisibleCount(720, [240, 240, 240]);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 0);
});

test('极窄宽度至少显示 0 个块 + 折叠全部', () => {
  const r = computeVisibleCount(100, [240, 240, 240]);
  assert.strictEqual(r.visible, 0);
  assert.strictEqual(r.folded, 3);
});

test('空列表返回 0/0', () => {
  const r = computeVisibleCount(1000, []);
  assert.strictEqual(r.visible, 0);
  assert.strictEqual(r.folded, 0);
});

test('未提供宽度数组时按估算宽度算', () => {
  const r = computeVisibleCount(1000, null, 8);
  assert.ok(r.visible >= 1);
  assert.strictEqual(r.visible + r.folded, 8);
});
