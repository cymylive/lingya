'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 侧边栏「我的待办」测试。
 * 侧边栏渲染在 shell-renderer.js 的 renderPlanView 里，用 sh- 类名体系。
 */

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/preload/shell-renderer.js'), 'utf8');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('renderPlanView 必须渲染「我的待办」区块', () => {
  const idx = CODE.indexOf('function renderPlanView');
  assert.ok(idx >= 0, '必须有 renderPlanView');
  const seg = CODE.slice(idx, idx + 4000);
  assert.match(seg, /sh-utodo/, 'renderPlanView 内必须有 sh-utodo 前缀的 DOM');
});

test('「我的待办」必须排在「任务计划」之前', () => {
  const idx = CODE.indexOf('function renderPlanView');
  const seg = CODE.slice(idx, idx + 4000);
  const uIdx = seg.indexOf('sh-utodo');
  const planIdx = seg.indexOf('sh-plan-body');
  assert.ok(uIdx >= 0 && planIdx >= 0, '两个区块都必须存在');
  assert.ok(uIdx < planIdx, '我的待办必须在任务计划之前，实际 utodo=' + uIdx + ', plan=' + planIdx);
});

test('侧边栏必须调用 shellAPI.userTodosList', () => {
  assert.match(CODE, /shellAPI\.userTodosList|userTodosList/, '必须调用 userTodosList');
});

test('侧边栏必须订阅 onUserTodosUpdated', () => {
  assert.match(CODE, /onUserTodosUpdated/, '必须订阅广播');
});

test('侧边栏必须有添加待办的输入框与按钮', () => {
  const idx = CODE.indexOf('sh-utodo');
  const seg = CODE.slice(Math.max(0, idx - 500), idx + 2500);
  assert.match(seg, /sh-utodo-input/, '缺少输入框');
  assert.match(seg, /sh-utodo-add/, '缺少添加按钮');
});

test('侧边栏必须转义文本（esc 函数）', () => {
  const idx = CODE.indexOf('sh-utodo');
  const seg = CODE.slice(Math.max(0, idx - 500), idx + 2500);
  assert.match(seg, /esc\(/, '侧边栏必须用 esc() 转义文本');
});


test('侧边栏广播订阅必须有防重复注册守卫', () => {
  assert.match(
    CODE,
    /__lingyaUserTodoSubscribed/,
    'shell-renderer 必须有 __lingyaUserTodoSubscribed 守卫 —— ' +
    'renderPlanView 每次切到计划视图都会重新执行，无守卫会累积监听器'
  );
});

test('侧边栏订阅通过 window 级回调转发（切视图后仍指向最新渲染函数）', () => {
  assert.match(CODE, /__lingyaUserTodoDraw/, '必须有 window.__lingyaUserTodoDraw 回调转发');
});
