'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 方案 B：bashOutput 单次 wait 上限从 600000(10分钟) 降到 120000(2分钟)。
 *
 * 根因：processInterceptedResponse 走串行队列（processingChain），
 * 一次 10 分钟的 bashOutput 会堵死整个窗口的回复处理链 ——
 * 期间 AI 输出的所有代码块都排队不执行，UI 也完全无反馈（看起来像"没被拦截"）。
 *
 * 降为 2 分钟后，AI 会按工具提示多次轮询（提示词已写明可多次调用），
 * 每次轮询都会刷新 UI 状态，用户能持续看到进度。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'tools', 'BackgroundTaskTool.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('MAX_WAIT_MS 必须降到 120000（2 分钟）', () => {
  const m = CODE.match(/const\s+MAX_WAIT_MS\s*=\s*(\d+)/);
  assert.ok(m, '必须有 MAX_WAIT_MS 常量');
  const val = Number(m[1]);
  assert.strictEqual(
    val, 120000,
    'MAX_WAIT_MS 必须是 120000。原值 600000(10分钟) 会把串行处理队列堵死，' +
    '期间 AI 输出的代码块全部排队不执行（实际值 ' + val + '）'
  );
});

test('MAX_WAIT_MS 不得过大（上限 180000）', () => {
  const m = CODE.match(/const\s+MAX_WAIT_MS\s*=\s*(\d+)/);
  const val = Number(m[1]);
  assert.ok(val <= 180000, '单次等待不应超过 3 分钟，否则队列阻塞风险过高');
});

test('工具提示词必须引导 AI 多次轮询（而非一次等到底）', () => {
  assert.match(
    CODE,
    /再次调用|多次调用|继续等待/,
    '提示词必须明确告知 AI 可多次调用 bashOutput 持续监测 —— ' +
    '否则降低上限后 AI 可能在 2 分钟到时误以为任务失败'
  );
});

test('超时后返回文本必须提示继续轮询（已有，防回归）', () => {
  assert.match(
    CODE,
    /任务仍在运行/,
    '超时返回必须明确告知任务仍在运行'
  );
});
