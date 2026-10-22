'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * preload API 暴露测试：两个 preload 都必须转发用户待办的 4 个 IPC + 1 个事件订阅。
 */

const ROOT = path.join(__dirname, '..', '..');
const API = fs.readFileSync(path.join(ROOT, 'src/preload/api.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'src/preload/shell-preload.js'), 'utf8');

const METHODS = [
  ['userTodosList', 'user-todos-list'],
  ['userTodosAdd', 'user-todos-add'],
  ['userTodosUpdate', 'user-todos-update'],
  ['userTodosDelete', 'user-todos-delete'],
];

for (const [method, channel] of METHODS) {
  test('electronAPI 暴露 ' + method, () => {
    assert.match(API, new RegExp(method + '\\s*:'), 'api.js 缺少方法 ' + method);
    assert.ok(API.includes("'" + channel + "'"), 'api.js 缺少 IPC 通道 ' + channel);
  });

  test('shellAPI 暴露 ' + method, () => {
    assert.match(SHELL, new RegExp(method + '\\s*:'), 'shell-preload.js 缺少方法 ' + method);
    assert.ok(SHELL.includes("'" + channel + "'"), 'shell-preload.js 缺少 IPC 通道 ' + channel);
  });
}

test('electronAPI 暴露 onUserTodosUpdated 订阅', () => {
  assert.match(API, /onUserTodosUpdated\s*:/, 'api.js 缺少 onUserTodosUpdated');
  assert.ok(API.includes("'lingya-user-todos-updated'"), 'api.js 事件名错误');
});

test('shellAPI 暴露 onUserTodosUpdated 订阅', () => {
  assert.match(SHELL, /onUserTodosUpdated\s*:/, 'shell-preload.js 缺少 onUserTodosUpdated');
  assert.ok(SHELL.includes("'lingya-user-todos-updated'"), 'shell-preload.js 事件名错误');
});

test('订阅函数返回取消函数（防内存泄漏）', () => {
  const idx = API.indexOf('onUserTodosUpdated');
  const seg = API.slice(idx, idx + 400);
  assert.match(seg, /removeListener/, 'onUserTodosUpdated 必须返回取消订阅函数');
});
