/**
 * 定时任务严格窗口绑定回归测试
 *
 * 背景（2026-10-24 用户需求）：
 * 定时任务指定了目标窗口（如「番茄音乐项目在 A 窗口跑」），
 * 但原实现 resolveTargetCtx 在窗口不存在时会静默降级到主窗口，
 * 导致用错账号发内容、污染无关会话。
 *
 * 用户要求（B/A/A）：
 *   B - 未指定窗口的任务也报错（不再走主窗口兜底）
 *   A - 指定窗口未打开时直接失败，不尝试自动打开
 *   A - 不重试，本次作废
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCHEDULE_IPC = path.join(__dirname, '..', '..', 'src', 'main', 'schedule-ipc.js');
const SHELL_RENDERER = path.join(__dirname, '..', '..', 'src', 'preload', 'shell-renderer.js');

function readSrc(p) {
  return fs.readFileSync(p, 'utf-8');
}

test('resolveTargetCtx 返回结构化结果（ok/ctx/error）', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf('function resolveTargetCtx');
  assert.ok(start > 0, '找不到 resolveTargetCtx');
  const body = src.slice(start, start + 1200);
  assert.ok(body.includes('ok: false'), '必须有失败返回分支');
  assert.ok(body.includes('ok: true'), '必须有成功返回分支');
  assert.ok(body.includes('ctx'), '成功时必须返回 ctx');
  assert.ok(body.includes('error'), '失败时必须返回 error');
});

test('未指定 profileId 时必须报错，不得降级到主窗口', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf('function resolveTargetCtx');
  const body = src.slice(start, start + 1200);
  assert.ok(body.includes('!task.profileId') || body.includes('!task || !task.profileId'),
    '必须检查 profileId 是否为空');
  assert.ok(body.includes('任务未指定执行窗口'), '必须有明确的错误文案');
  assert.ok(!body.includes('getMainContext'),
    'resolveTargetCtx 里不得再降级到 getMainContext（会导致用错窗口）');
});

test('指定窗口未打开时必须报错并说明窗口名', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf('function resolveTargetCtx');
  const body = src.slice(start, start + 1200);
  assert.ok(body.includes('未打开'), '必须有「未打开」的错误提示');
  assert.ok(body.includes('已跳过本次执行'), '必须说明已跳过');
  assert.ok(body.includes('profileManager.getProfileById'), '应查出窗口名让用户看懂是哪个窗口');
});

test('runTask 使用新返回结构并写清楚失败原因', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf('async function runTask');
  assert.ok(start > 0);
  const body = src.slice(start, start + 1500);
  assert.ok(body.includes('res.ok'), '必须判断 res.ok');
  assert.ok(body.includes('res.ctx'), '成功时必须取 res.ctx');
  assert.ok(body.includes('res.error'), '失败时必须使用 res.error 作为原因');
  assert.ok(body.includes('已跳过'), '飞书通知应说明已跳过');
});

test('schedule-add 必须校验 profileId 非空', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf("ipcMain.handle('schedule-add'");
  assert.ok(start > 0);
  const body = src.slice(start, start + 800);
  assert.ok(body.includes('!profileId'), '必须检查 profileId');
  assert.ok(body.includes('必须选择执行窗口'), '必须有明确错误文案');
});

test('schedule-update 不得允许清空 profileId', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf("ipcMain.handle('schedule-update'");
  assert.ok(start > 0);
  const body = src.slice(start, start + 900);
  assert.ok(body.includes('hasOwnProperty') && body.includes('profileId'),
    '应检测 patch 里是否显式传了 profileId');
  assert.ok(body.includes('执行窗口不能为空'), '必须有明确错误文案');
});

test('前端下拉框不得再提供「当前活跃窗口」兜底选项', () => {
  const src = readSrc(SHELL_RENDERER);
  assert.ok(!src.includes('— 当前活跃窗口 —'),
    '「当前活跃窗口」选项必须移除（会让用户误以为可以不选）');
  assert.ok(src.includes('请选择执行窗口'), '应有明确的占位提示');
});

test('前端下拉框标注未打开的窗口会导致跳过', () => {
  const src = readSrc(SHELL_RENDERER);
  assert.ok(src.includes('未打开，任务将跳过'),
    '应提示用户该窗口未打开时任务会被跳过');
});

test('前端保存时必须校验 profileId', () => {
  const src = readSrc(SHELL_RENDERER);
  const idx = src.indexOf('if(!profileId)');
  assert.ok(idx > 0, '保存时必须有 profileId 校验');
  const around = src.slice(idx, idx + 100);
  assert.ok(around.includes('请选择执行窗口'), '校验失败应提示用户选择窗口');
});

test('pushFeishu 适配新返回结构（不能因返回结构变更而崩溃）', () => {
  const src = readSrc(SCHEDULE_IPC);
  const start = src.indexOf('async function pushFeishu');
  assert.ok(start > 0);
  const body = src.slice(start, start + 800);
  assert.ok(body.includes('res.ok'), 'pushFeishu 里也应判断 res.ok');
  assert.ok(body.includes('res.ctx'), '应从 res.ctx 取窗口');
});
