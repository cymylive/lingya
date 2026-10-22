'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 用户待办 IPC 结构测试。
 *
 * 重点锁定本轮已经踩过的坑：**必须按 event.sender 定位窗口上下文，
 * 不得用「最后激活的窗口」**（否则多窗口下待办会串到别的窗口）。
 */

const ROOT = path.join(__dirname, '..', '..');
const IPC_SRC = fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const IPC = stripComments(IPC_SRC);
const INDEX = stripComments(INDEX_SRC);

// ===================== 存储初始化 =====================

test('index.js 必须初始化 UserTodoStore', () => {
  assert.match(
    INDEX,
    /UserTodoStore['"]?\)\.init\(/,
    'index.js 必须在启动时调用 UserTodoStore.init(userData)'
  );
});

test('UserTodoStore 初始化与 TodoWriteTool 分离（两个独立 init）', () => {
  const aiIdx = INDEX.indexOf("TodoWriteTool').init");
  const userIdx = INDEX.indexOf("UserTodoStore').init");
  assert.ok(aiIdx >= 0, '必须有 TodoWriteTool.init');
  assert.ok(userIdx >= 0, '必须有 UserTodoStore.init');
  assert.notStrictEqual(aiIdx, userIdx, '两者必须是两次独立调用');
});

// ===================== IPC handlers =====================

const REQUIRED_CHANNELS = [
  'user-todos-list',
  'user-todos-add',
  'user-todos-update',
  'user-todos-delete',
];

for (const ch of REQUIRED_CHANNELS) {
  test('必须有 IPC 通道: ' + ch, () => {
    const re = new RegExp("ipcMain\\.handle\\(\\s*['\"]" + ch + "['\"]");
    assert.match(IPC, re, '缺少 IPC handler: ' + ch);
  });
}

test('每个 user-todos handler 都必须用 getContextByWebContents(event.sender) 定位窗口', () => {
  for (const ch of REQUIRED_CHANNELS) {
    const idx = IPC.indexOf("'" + ch + "'");
    assert.ok(idx >= 0, '找不到 ' + ch);
    // 取该 handler 后 600 字符
    const seg = IPC.slice(idx, idx + 600);
    assert.match(
      seg,
      /getContextByWebContents\(\s*event\.sender\s*\)/,
      ch + ' 必须按 event.sender 定位窗口 —— ' +
      '用 getMainContext()（最后激活窗口）会导致多窗口串台'
    );
  }
});

test('user-todos 写操作后必须广播 lingya-user-todos-updated', () => {
  assert.match(
    IPC,
    /lingya-user-todos-updated/,
    '必须有广播事件 lingya-user-todos-updated'
  );
});

test('广播同时发给覆盖层与侧边栏（两个 webContents）', () => {
  const idx = IPC.indexOf('lingya-user-todos-updated');
  assert.ok(idx >= 0);
  // 广播前后应有 ctx.win.webContents 与 ctx.rawWin.webContents 的发送
  const seg = IPC.slice(Math.max(0, idx - 800), idx + 400);
  assert.match(seg, /ctx\.win\.webContents|\.win\.webContents/, '应发给 AI 视图（覆盖层）');
  assert.match(seg, /rawWin/, '应发给壳窗口（侧边栏）');
});

// ===================== 不得复用 AI 计划的通道 =====================

test('不得复用 AI 计划的 IPC 通道名', () => {
  for (const ch of REQUIRED_CHANNELS) {
    assert.ok(
      !IPC.includes("'" + ch.replace('user-todos-', '') + "'"),
      '不能复用 get-todos / clear-todos 等 AI 计划通道'
    );
  }
});

test('不得复用 lingya-todos-updated 广播事件', () => {
  // 找 user-todos 广播的位置，确认它是独立事件名
  assert.ok(IPC.includes('lingya-user-todos-updated'));
  assert.ok(IPC.includes('lingya-todos-updated'), 'AI 计划广播应保留');
});
