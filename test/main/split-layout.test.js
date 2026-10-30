'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSplitLayout, computeSplitBounds } = require('../../src/main/split-layout');

const AREA = { x: 46, y: 40, width: 900, height: 800 };

test('单视图占满整个区域', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 1, 0);
  assert.deepStrictEqual(r[0], { x: 46, y: 40, width: 900, height: 800 });
});

test('三视图左右均分', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 3, 0);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].x, 46);
  assert.strictEqual(r[0].width, 300);
  assert.strictEqual(r[1].x, 346);
  assert.strictEqual(r[2].x, 646);
  assert.strictEqual(r[2].width, 300);
  // 覆盖到右边界
  assert.strictEqual(r[2].x + r[2].width, 46 + 900);
});

test('三视图上下均分', () => {
  const r = computeSplitLayout(AREA, 'vertical', 3, 0);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].y, 40);
  assert.strictEqual(r[0].height, 266);
  assert.strictEqual(r[2].y + r[2].height, 40 + 800);
});

test('四视图左右均分带间隙', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 4, 4);
  assert.strictEqual(r.length, 4);
  for (let i = 1; i < 4; i++) {
    assert.strictEqual(r[i].x, r[i-1].x + r[i-1].width + 4);
  }
  assert.strictEqual(r[3].x + r[3].width, 46 + 900);
});

test('不可整除时最后一段吸收余数，不留缝', () => {
  const r = computeSplitLayout({ x: 0, y: 0, width: 100, height: 50 }, 'horizontal', 3, 0);
  const last = r[2];
  assert.strictEqual(last.x + last.width, 100);
});

test('computeSplitBounds 兼容两视图旧签名', () => {
  const r = computeSplitBounds(AREA, 'horizontal', 0);
  assert.strictEqual(r.main.width, 450);
  assert.strictEqual(r.attached.x, 496);
});

test('computeSplitBounds 方向非法返回 null', () => {
  assert.strictEqual(computeSplitBounds(AREA, 'diagonal', 0), null);
});

test('computeSplitLayout 方向非法返回 null', () => {
  assert.strictEqual(computeSplitLayout(AREA, 'diagonal', 3, 0), null);
});
