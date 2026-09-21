'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 只测纯函数：generateId、formatTime、truncate
// escapeHtml 等需要 DOM 的函数单独 mock

// 用简单 DOM stub
const mkEl = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } });
global.document = {
  createElement: () => mkEl(),
  getElementById: () => null,
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
};
global.requestAnimationFrame = (fn) => fn();
global.window = { location: { href: 'https://chat.deepseek.com/' } };
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = (fn, ms) => 0;
global.clearTimeout = () => {};

const ui = require('../../src/preload/overlay/ui');

test('generateId 格式', () => {
  const id1 = ui.generateId();
  const id2 = ui.generateId();
  assert.match(id1, /^cmd_\d+_\d+$/);
  assert.notStrictEqual(id1, id2);
});

test('formatTime 格式 HH:mm:ss', () => {
  const s = ui.formatTime(new Date(2026, 0, 1, 9, 5, 3).getTime());
  assert.strictEqual(s, '09:05:03');
});

test('truncate 基本与默认长度', () => {
  assert.strictEqual(ui.truncate('hello'), 'hello');
  assert.strictEqual(ui.truncate('abcdefghij', 5), 'abcde...');
  assert.strictEqual(ui.truncate(''), '');
  assert.strictEqual(ui.truncate(null), '');
  const long = 'x'.repeat(60);
  assert.strictEqual(ui.truncate(long).length, 53);
});

test('escapeHtml 返回字符串', () => {
  assert.strictEqual(typeof ui.escapeHtml('<script>'), 'string');
});

test('updateHomeMode 首页模式', () => {
  assert.doesNotThrow(() => ui.updateHomeMode());
});

test('showToast 不抛错', () => {
  assert.doesNotThrow(() => ui.showToast('test'));
});

test('setTaskStatus 不抛错', () => {
  assert.doesNotThrow(() => ui.setTaskStatus(true));
});

test('showOverlay/hideOverlay/forceShowOverlay 不抛错', () => {
  assert.doesNotThrow(() => ui.showOverlay());
  assert.doesNotThrow(() => ui.hideOverlay());
  assert.doesNotThrow(() => ui.forceShowOverlay());
});

test('displayCommand 更新预览', () => {
  assert.doesNotThrow(() => ui.displayCommand({ command: 'echo hi' }));
});

test('handleExecute/handleIgnore 不抛错', async () => {
  await ui.handleExecute();
  ui.handleIgnore();
});

test('addHistory 添加记录', () => {
  ui.commandHistory.length = 0;
  ui.addHistory({ id: '1', command: 'echo', success: true, canceled: false, output: 'x', timestamp: Date.now() });
  assert.strictEqual(ui.commandHistory.length, 1);
  assert.strictEqual(ui.commandHistory[0].id, '1');
});

test('renderHistory 空列表', () => {
  ui.commandHistory.length = 0;
  assert.doesNotThrow(() => ui.renderHistory());
});

test('flashBadge 不抛错', () => {
  assert.doesNotThrow(() => ui.flashBadge('test'));
});

test('startOverlayWatcher 不抛错', () => {
  assert.doesNotThrow(() => ui.startOverlayWatcher());
});
