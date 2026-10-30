'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planMerge, planUnmerge, normalizeDirection } = require('../../src/main/window-merge');

function mkSource(over = {}) {
  const view = { webContents: { id: 'src-wc' } };
  return Object.assign({
    id: 'source',
    tabs: new Map([['tab-1', { id: 'tab-1', view }]]),
    activeTabId: 'tab-1',
    attachedView: null,
    splitDirection: null,
  }, over);
}

function mkTarget(over = {}) {
  return Object.assign({
    id: 'target',
    tabs: new Map([['tab-2', { id: 'tab-2', view: { webContents: { id: 'tgt-wc' } } }]]),
    activeTabId: 'tab-2',
    attachedView: null,
    splitDirection: null,
  }, over);
}

test('normalizeDirection 只接受 horizontal / vertical', () => {
  assert.strictEqual(normalizeDirection('horizontal'), 'horizontal');
  assert.strictEqual(normalizeDirection('vertical'), 'vertical');
  assert.strictEqual(normalizeDirection('diagonal'), null);
  assert.strictEqual(normalizeDirection(undefined), null);
});

test('正常合并：返回源窗口的 active 视图与方向', () => {
  const r = planMerge(mkSource(), mkTarget(), 'horizontal');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.direction, 'horizontal');
  assert.strictEqual(r.view.webContents.id, 'src-wc');
});

test('合并方向非法时返回错误', () => {
  const r = planMerge(mkSource(), mkTarget(), 'diagonal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /方向/);
});

test('不能把窗口合并到自己', () => {
  const s = mkSource();
  const r = planMerge(s, s, 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /自己/);
});

test('源窗口没有 active 视图时拒绝合并', () => {
  const r = planMerge(mkSource({ activeTabId: null }), mkTarget(), 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /没有/);
});

test('源窗口已经分屏（有 attachedView）时拒绝再合并', () => {
  const r = planMerge(mkSource({ attachedView: {} }), mkTarget(), 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /已处于分屏/);
});

test('目标窗口已经分屏时拒绝接受新的合并', () => {
  const r = planMerge(mkSource(), mkTarget({ attachedView: {} }), 'horizontal');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /已处于分屏/);
});

test('planUnmerge：宿主有 attachedView 时返回该视图', () => {
  const tgt = mkTarget({ attachedView: { webContents: { id: 'att' } }, splitDirection: 'vertical' });
  const r = planUnmerge(tgt);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.view.webContents.id, 'att');
});

test('planUnmerge：宿主没有 attachedView 时返回错误', () => {
  const r = planUnmerge(mkTarget());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /没有/);
});
