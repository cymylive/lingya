'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planMerge, planUnmerge, planUnmergeAll, planUnmergeOne, normalizeDirection } = require('../../src/main/window-merge');

function mkSource(over = {}) {
  const view = { webContents: { id: 'src-wc' } };
  return Object.assign({
    id: 'source',
    tabs: new Map([['tab-1', { id: 'tab-1', view }]]),
    activeTabId: 'tab-1',
    attachedViews: [],
    splitDirection: null,
  }, over);
}

function mkTarget(over = {}) {
  return Object.assign({
    id: 'target',
    tabs: new Map([['tab-2', { id: 'tab-2', view: { webContents: { id: 'tgt-wc' } } }]]),
    activeTabId: 'tab-2',
    attachedViews: [],
    splitDirection: null,
  }, over);
}

test('normalizeDirection 只接受 horizontal / vertical', () => {
  assert.strictEqual(normalizeDirection('horizontal'), 'horizontal');
  assert.strictEqual(normalizeDirection('vertical'), 'vertical');
  assert.strictEqual(normalizeDirection('diagonal'), null);
  assert.strictEqual(normalizeDirection(undefined), null);
});

test('正常合并：host 保留，返回 source 的 active 视图', () => {
  const r = planMerge(mkTarget(), mkSource(), 'horizontal');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.direction, 'horizontal');
  assert.strictEqual(r.view.webContents.id, 'src-wc');
  assert.strictEqual(r.targetCount, 2);
});

test('合并方向非法时返回错误', () => {
  const r = planMerge(mkTarget(), mkSource(), 'diagonal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /方向/);
});

test('不能把窗口合并到自己', () => {
  const s = mkSource();
  const r = planMerge(s, s, 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /自己/);
});

test('来源窗口没有 active 视图时拒绝合并', () => {
  const r = planMerge(mkTarget(), mkSource({ activeTabId: null }), 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /没有/);
});

test('来源窗口已经分屏时拒绝被合并', () => {
  const r = planMerge(mkTarget(), mkSource({ attachedViews: [{ webContents: { id: 'x' } }] }), 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /被合并的窗口已处于分屏/);
});

test('宿主已有分屏时，同方向可继续拉入（3 个起）', () => {
  const host = mkTarget({ attachedViews: [{ webContents: { id: 'a1' } }], splitDirection: 'horizontal' });
  const r = planMerge(host, mkSource(), 'horizontal');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.targetCount, 3);
});

test('宿主已有分屏但方向不同时拒绝', () => {
  const host = mkTarget({ attachedViews: [{ webContents: { id: 'a1' } }], splitDirection: 'horizontal' });
  const r = planMerge(host, mkSource(), 'vertical');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /方向/);
});

test('planUnmerge 无附加视图时返回错误', () => {
  const r = planUnmerge(mkTarget());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /没有/);
});

test('planUnmergeAll 返回全部附加视图', () => {
  const tgt = mkTarget({ attachedViews: [{ view: { webContents: { id: 'a1' } } }, { view: { webContents: { id: 'a2' } } }], splitDirection: 'vertical' });
  const r = planUnmergeAll(tgt);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.views.length, 2);
});

test('planUnmergeOne 按 webContents id 挑出指定视图', () => {
  const tgt = mkTarget({ attachedViews: [{ view: { webContents: { id: 'a1' } } }, { view: { webContents: { id: 'a2' } } }], splitDirection: 'horizontal' });
  const r = planUnmergeOne(tgt, 'a2');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.webContents.id, 'a2');
});

test('planUnmergeOne 找不到指定 id 时返回错误', () => {
  const tgt = mkTarget({ attachedViews: [{ view: { webContents: { id: 'a1' } } }] });
  const r = planUnmergeOne(tgt, 'nope');
  assert.strictEqual(r.ok, false);
});

test('planUnmerge 兼容旧调用：单个附加视图返回 view', () => {
  const tgt = mkTarget({ attachedViews: [{ view: { webContents: { id: 'only' } } }] });
  const r = planUnmerge(tgt);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.webContents.id, 'only');
});

test('planUnmerge 兼容旧调用：多个附加视图返回 views', () => {
  const tgt = mkTarget({ attachedViews: [{ view: { webContents: { id: 'a1' } } }, { view: { webContents: { id: 'a2' } } }] });
  const r = planUnmerge(tgt);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.views.length, 2);
});
