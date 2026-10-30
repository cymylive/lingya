'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSplitLayout, computeSplitBounds, computeScrollContentWidth } = require('../../src/main/split-layout');

const AREA = { x: 46, y: 40, width: 900, height: 800 };

test('单视图占满整个区域', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 1, 0);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].width, 900);
});

test('三视图左右均分（默认无最小宽）', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 3, 0);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].width, 300);
  assert.strictEqual(r[2].x + r[2].width, 46 + 900);
});

test('三视图左右均分，但设置最小宽 800 后每个都是 800', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 3, 0, 800);
  assert.strictEqual(r.length, 3);
  r.forEach(v => assert.strictEqual(v.width, 800));
  assert.strictEqual(r[0].x, 46);
  assert.strictEqual(r[1].x, 846);
  assert.strictEqual(r[2].x, 1646);
});

test('两视图均分 450 > 最小宽 400，按均分 450', () => {
  const r = computeSplitLayout(AREA, 'horizontal', 2, 0, 400);
  r.forEach(v => assert.strictEqual(v.width, 450));
});

test('computeScrollContentWidth 返回总内容宽度', () => {
  const w = computeScrollContentWidth(AREA, 'horizontal', 3, 0, 800);
  assert.strictEqual(w, 2400);
});

test('computeScrollContentWidth 内容窄于视口时返回视口宽', () => {
  const w = computeScrollContentWidth(AREA, 'horizontal', 2, 0, 100);
  assert.strictEqual(w, 900);
});

test('上下分屏不受最小宽影响', () => {
  const r = computeSplitLayout(AREA, 'vertical', 3, 0, 800);
  r.forEach(v => assert.strictEqual(v.width, 900));
  assert.strictEqual(r[0].height, 266);
});

test('computeSplitBounds 兼容旧签名', () => {
  const r = computeSplitBounds(AREA, 'horizontal', 0);
  assert.strictEqual(r.main.width, 450);
});
