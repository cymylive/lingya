'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 审查发现的 Critical 1：shell-renderer 的 AI 计划订阅没有防重复注册守卫。
 *
 * 我在同一个 renderPlanView 里给 user-todos 加了 __lingyaUserTodoSubscribed 守卫，
 * 却没给相邻的 onTodosUpdated / onSessionChanged 加 —— 同类问题的不一致处理。
 *
 * 后果：一旦 rendered['plan'] 被重置（类似 line 728 对 plugins 的做法），
 * 每次重新渲染都会再注册一个监听器，广播触发 N 次渲染 + 内存泄漏。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'shell-renderer.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('AI 计划订阅必须有防重复注册守卫', () => {
  assert.match(
    CODE,
    /__lingyaPlanSubscribed/,
    'onTodosUpdated 必须有 __lingyaPlanSubscribed 守卫 —— ' +
    '与 user-todos 的 __lingyaUserTodoSubscribed 保持一致，否则重置 rendered 后会累积监听器'
  );
});

test('onSessionChanged 订阅必须有防重复注册守卫', () => {
  assert.match(
    CODE,
    /__lingyaSessionChangedSubscribed/,
    'onSessionChanged 必须有 __lingyaSessionChangedSubscribed 守卫'
  );
});

test('守卫必须在调用 onTodosUpdated 之前设置', () => {
  const guardIdx = CODE.indexOf('__lingyaPlanSubscribed');
  const callIdx = CODE.indexOf('shellAPI.onTodosUpdated');
  assert.ok(guardIdx >= 0 && callIdx >= 0, '两者都必须存在');
  assert.ok(
    guardIdx < callIdx,
    '守卫必须在订阅调用之前设置，否则第一次就会漏'
  );
});

test('AI 计划订阅通过 window 级回调转发（切视图后仍指向最新渲染函数）', () => {
  assert.match(
    CODE,
    /__lingyaPlanDraw/,
    '必须有 window.__lingyaPlanDraw 回调转发 —— 否则切视图重建 DOM 后旧闭包指向失效的 DOM'
  );
});
