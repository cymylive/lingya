'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSplitBounds } = require('../../src/main/split-layout');

const AREA = { x: 46, y: 40, width: 1000, height: 800 };
const GAP = 0;

test('无附加视图时返回 null（走原单视图逻辑）', () => {
  assert.strictEqual(computeSplitBounds(AREA, 'none', GAP), null);
});

test('左右分屏：主视图占左半，附加视图占右半，无间隙', () => {
  const r = computeSplitBounds(AREA, 'horizontal', GAP);
  assert.strictEqual(r.main.x, 46);
  assert.strictEqual(r.main.width, 500);
  assert.strictEqual(r.main.height, 800);
  assert.strictEqual(r.attached.x, 546);
  assert.strictEqual(r.attached.width, 500);
  assert.strictEqual(r.attached.y, 40);
});

test('左右分屏带分隔条：两视图等分剩余宽度', () => {
  const r = computeSplitBounds(AREA, 'horizontal', 4);
  assert.strictEqual(r.main.width, 498);
  assert.strictEqual(r.attached.x, 46 + 498 + 4);
  assert.strictEqual(r.attached.width, 498);
});

test('上下分屏：主视图占上半，附加视图占下半', () => {
  const r = computeSplitBounds(AREA, 'vertical', GAP);
  assert.strictEqual(r.main.y, 40);
  assert.strictEqual(r.main.height, 400);
  assert.strictEqual(r.main.width, 1000);
  assert.strictEqual(r.attached.y, 440);
  assert.strictEqual(r.attached.height, 400);
});

test('上下分屏带分隔条', () => {
  const r = computeSplitBounds(AREA, 'vertical', 4);
  assert.strictEqual(r.main.height, 398);
  assert.strictEqual(r.attached.y, 40 + 398 + 4);
  assert.strictEqual(r.attached.height, 398);
});

test('尺寸小于分隔条时不产生负宽度', () => {
  const tiny = { x: 0, y: 0, width: 3, height: 3 };
  const r = computeSplitBounds(tiny, 'horizontal', 4);
  assert.ok(r.main.width >= 0, '主视图宽度不能为负');
  assert.ok(r.attached.width >= 0, '附加视图宽度不能为负');
});

test('未知方向按 none 处理', () => {
  assert.strictEqual(computeSplitBounds(AREA, 'diagonal', GAP), null);
});
