'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 计划确认功能的 IPC / 配置 / preload API 结构测试。
 */

const ROOT = path.join(__dirname, '..', '..');
const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8');
const secSrc = fs.readFileSync(path.join(ROOT, 'src/main/security-store.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/preload/api.js'), 'utf8');
const shellSrc = fs.readFileSync(path.join(ROOT, 'src/preload/shell-preload.js'), 'utf8');

function strip(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const IPC = strip(ipcSrc), SEC = strip(secSrc), API = strip(apiSrc), SHELL = strip(shellSrc);

// ===================== 配置项 =====================

test('security-store 必须有 planConfirmEnabled 默认配置', () => {
  assert.match(SEC, /planConfirmEnabled\s*:/, 'DEFAULT_CONFIG 必须含 planConfirmEnabled');
});

test('planConfirmEnabled 默认应为 true（用户明确要求的功能）', () => {
  const m = SEC.match(/planConfirmEnabled\s*:\s*(true|false)/);
  assert.ok(m, '必须有明确的字面量默认值');
  assert.strictEqual(m[1], 'true', '该功能默认开启');
});

test('planConfirmEnabled 必须在允许的布尔键白名单里', () => {
  // security-store 的 setConfig 用白名单校验布尔类型
  assert.match(
    SEC,
    /planConfirmEnabled/,
    '必须出现在布尔键校验分支'
  );
  const idx = SEC.indexOf("key === 'ctfInjectionEnabled'");
  assert.ok(idx >= 0);
  const seg = SEC.slice(idx, idx + 800);
  assert.match(seg, /planConfirmEnabled/, 'planConfirmEnabled 必须在布尔键白名单中');
});

// ===================== IPC =====================

test('必须有 plan-confirm IPC 通道（用户点按钮时调用）', () => {
  assert.match(IPC, /ipcMain\.handle\(\s*['"]plan-confirm['"]/, '缺少 plan-confirm');
});

test('plan-confirm 必须按 event.sender 定位会话（不能用活跃窗口）', () => {
  const idx = IPC.indexOf("'plan-confirm'");
  assert.ok(idx >= 0);
  const seg = IPC.slice(idx, idx + 800);
  assert.match(seg, /getContextByWebContents\(\s*event\.sender\s*\)/, '必须按 event.sender 定位');
  assert.match(seg, /markConfirmed/, '必须调用 markConfirmed');
});

test('必须有 plan-confirm-status 查询通道（面板渲染按钮用）', () => {
  assert.match(
    IPC,
    /ipcMain\.handle\(\s*['"]plan-confirm-status['"]/,
    '缺少 plan-confirm-status —— 面板需知道当前是否等待确认'
  );
});

// ===================== preload API =====================

test('electronAPI 暴露 planConfirm', () => {
  assert.match(API, /planConfirm\s*:/, 'api.js 缺少 planConfirm');
  assert.ok(API.includes("'plan-confirm'"), 'IPC 通道名错误');
});

test('electronAPI 暴露 planConfirmStatus', () => {
  assert.match(API, /planConfirmStatus\s*:/, 'api.js 缺少 planConfirmStatus');
});

test('shellAPI 暴露 planConfirm', () => {
  assert.match(SHELL, /planConfirm\s*:/, 'shell-preload.js 缺少 planConfirm');
});
