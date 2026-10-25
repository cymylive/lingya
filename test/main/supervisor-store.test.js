'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../../src/main/supervisor-store');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'supervisor-store-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  store.init(tmpDir);
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('初始状态：未激活任何会话', () => {
  assert.strictEqual(store.isActivated('sess-a'), false);
});

test('activate 后 isActivated 返回 true', () => {
  store.activate('sess-a');
  assert.strictEqual(store.isActivated('sess-a'), true);
});

test('不同会话的激活状态互相独立', () => {
  store.activate('sess-a');
  assert.strictEqual(store.isActivated('sess-a'), true);
  assert.strictEqual(store.isActivated('sess-b'), false);
});

test('重复 activate 同一会话是幂等的', () => {
  store.activate('sess-a');
  const first = store.getActivatedAt('sess-a');
  store.activate('sess-a');
  assert.strictEqual(store.isActivated('sess-a'), true);
  assert.strictEqual(store.getActivatedAt('sess-a'), first, 'activatedAt 不应被覆盖');
});

test('激活状态持久化到磁盘并可重载', () => {
  store.activate('sess-persist');
  store.init(tmpDir);  // 清缓存强制重读磁盘
  assert.strictEqual(store.isActivated('sess-persist'), true);
});

test('activate 空 sessionId 不报错也不记录', () => {
  store.activate('');
  store.activate(null);
  store.activate(undefined);
  assert.strictEqual(store.listActivated().length, 0);
});

test('listActivated 返回所有已激活会话', () => {
  store.activate('s1');
  store.activate('s2');
  const list = store.listActivated();
  assert.strictEqual(list.length, 2);
  assert.ok(list.includes('s1'));
  assert.ok(list.includes('s2'));
});

test('无上限：1000 个会话都能记录', () => {
  for (let i = 0; i < 1000; i++) store.activate('sess-' + i);
  assert.strictEqual(store.listActivated().length, 1000);
  assert.strictEqual(store.isActivated('sess-999'), true);
});

test('deactivate 可显式取消激活', () => {
  store.activate('sess-x');
  store.deactivate('sess-x');
  assert.strictEqual(store.isActivated('sess-x'), false);
});

test('deactivate 不存在的会话是幂等的', () => {
  assert.doesNotThrow(() => store.deactivate('never-existed'));
});

test('文件损坏时降级为空并继续工作', () => {
  fs.writeFileSync(path.join(tmpDir, 'lingya-supervisor-state.json'), '{ not json', 'utf-8');
  store.init(tmpDir);
  assert.strictEqual(store.isActivated('sess-a'), false);
  assert.doesNotThrow(() => store.activate('sess-a'));
  assert.strictEqual(store.isActivated('sess-a'), true);
});
