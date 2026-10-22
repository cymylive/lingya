'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 覆盖层「我的待办」面板测试。
 *
 * 关键不变量：
 *   1. HTML 元素必须在「任务计划」区块之前（用户要求放在上方）
 *   2. 必须有添加输入框 + 添加按钮
 *   3. 广播到达时按 currentSessionId 过滤（防跨会话串扰）
 *   4. 编辑期间暂停重渲染（防焦点丢失）
 *   5. 文本必须 escapeHtml（防 XSS）
 */

const ROOT = path.join(__dirname, '..', '..');
const TPL = fs.readFileSync(path.join(ROOT, 'src/preload/overlay/template.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, 'src/preload/overlay/plan-panel.js'), 'utf8');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const TPL_CODE = stripComments(TPL);
const PANEL_CODE = stripComments(PANEL);

// ===================== HTML 结构 =====================

const REQUIRED_IDS = [
  'lingya-utodo-count',
  'lingya-utodo-list',
  'lingya-utodo-input',
  'lingya-utodo-add-btn',
];

for (const id of REQUIRED_IDS) {
  test('HTML 必须包含 #' + id, () => {
    assert.ok(TPL_CODE.includes(id), 'template.js 缺少 ' + id);
  });
}

test('「我的待办」必须排在「任务计划」之前', () => {
  const uIdx = TPL_CODE.indexOf('lingya-utodo-list');
  const aiIdx = TPL_CODE.indexOf('lingya-plan-list');
  assert.ok(uIdx >= 0 && aiIdx >= 0, '两个列表都必须存在');
  assert.ok(
    uIdx < aiIdx,
    '我的待办必须排在 AI 任务计划之前（用户明确要求），实际 utodo=' + uIdx + ', plan=' + aiIdx
  );
});

test('必须有「我的待办」标签文字', () => {
  assert.match(TPL_CODE, /我的待办/, '缺少「我的待办」标题文字');
});

// ===================== JS 逻辑 =====================

test('plan-panel 必须有 renderUserTodos 函数', () => {
  assert.match(PANEL_CODE, /function\s+renderUserTodos/, '缺少 renderUserTodos');
});

test('plan-panel 必须调用 userTodosList 拉取', () => {
  assert.match(PANEL_CODE, /userTodosList/, '必须调用 electronAPI.userTodosList');
});

test('plan-panel 必须订阅 onUserTodosUpdated', () => {
  assert.match(PANEL_CODE, /onUserTodosUpdated/, '必须订阅广播');
});

test('广播必须按 currentSessionId 过滤（防跨会话串扰）', () => {
  const idx = PANEL_CODE.indexOf('onUserTodosUpdated');
  assert.ok(idx >= 0);
  const seg = PANEL_CODE.slice(idx, idx + 800);
  assert.match(
    seg,
    /sessionId/,
    'onUserTodosUpdated 回调内必须检查 sessionId，否则其他会话的变更会串到当前面板'
  );
});

test('必须用 escapeHtml 处理文本（防 XSS）', () => {
  const idx = PANEL_CODE.indexOf('renderUserTodos');
  assert.ok(idx >= 0);
  const seg = PANEL_CODE.slice(idx, idx + 2500);
  assert.match(seg, /escapeHtml/, 'renderUserTodos 必须转义文本');
});

test('编辑期间必须暂停重渲染（防焦点丢失）', () => {
  assert.match(
    PANEL_CODE,
    /editingUserId/,
    '必须有 editingUserId 状态变量，编辑期间跳过重渲染 —— ' +
    '否则广播到达时正在编辑的输入框会消失'
  );
  // 必须在 renderUserTodos 开头做早退判断。
  // 注意：审查修复后早退逻辑升级为「同会话才早退，跨会话强制退出编辑态」，
  // 结构从单行 if 变成嵌套 if/else，故改为断言「存在 editingUserId 判断 + return」。
  const idx = PANEL_CODE.indexOf('function renderUserTodos');
  const seg = PANEL_CODE.slice(idx, idx + 900);
  assert.match(seg, /if\s*\(\s*editingUserId\s*\)/, 'renderUserTodos 开头必须检查 editingUserId');
  assert.match(seg, /return/, '编辑期间必须 return（跳过重渲染）');
});

test('绑定函数必须导出并挂到 bindPlanPanelEvents', () => {
  const bindIdx = PANEL_CODE.indexOf('function bindPlanPanelEvents');
  assert.ok(bindIdx >= 0);
  const seg = PANEL_CODE.slice(bindIdx, bindIdx + 1200);
  assert.match(seg, /bindUserTodoPanel|refreshUserTodos/, 'bindPlanPanelEvents 必须调用用户待办初始化');
});

// ===================== CSS =====================

test('必须有用户待办的 CSS 类', () => {
  for (const cls of ['lingya-utodo-item', 'lingya-utodo-check', 'lingya-utodo-text', 'lingya-utodo-del']) {
    assert.ok(TPL_CODE.includes(cls), 'template.js 缺少 CSS 类 ' + cls);
  }
});


test('广播订阅必须有防重复注册守卫（renderPlanView 每次切视图都重建）', () => {
  assert.match(
    PANEL_CODE,
    /__lingyaUserTodoSubscribed/,
    'overlay 必须有 __lingyaUserTodoSubscribed 守卫，否则重复调用会累积监听器'
  );
});
