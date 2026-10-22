'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 发送延迟可见性测试。
 *
 * 背景（用户反馈）：
 *   thinkRatio / thinkMaxDelay 只在「慢请求自适应」分支生效；
 *   快请求分支用的是固定 globalSendDelay。
 *   用户看不到当前走的是哪个分支，就误以为「延迟功能没生效」。
 *   尤其多窗口场景：A 窗口任务重（走自适应）、B 窗口任务轻（走固定），
 *   表现不同 → 用户以为是 bug。
 *
 * 修复：把延迟决策（分支 + 关键参数）记入历史面板，用户可直接看到。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SRC);

test('sendToChat 必须把延迟决策记入历史面板', () => {
  // 定位 sendToChat 函数体
  const start = CODE.indexOf('async function sendToChat');
  assert.ok(start >= 0, '必须有 sendToChat');
  const body = CODE.slice(start, start + 6000);

  assert.match(
    body,
    /addHistory\s*\(/,
    'sendToChat 必须调用 addHistory 记录延迟决策 —— ' +
    '否则用户无法判断延迟功能是否生效（尤其多窗口对比时）'
  );
});

test('延迟记录包含「发送延迟」标识，便于在历史面板识别', () => {
  const start = CODE.indexOf('async function sendToChat');
  const body = CODE.slice(start, start + 6000);
  assert.match(
    body,
    /发送延迟/,
    '记录文字必须含「发送延迟」前缀，否则在历史里和工具记录混在一起'
  );
});

test('延迟记录包含实际毫秒数与分支说明', () => {
  const start = CODE.indexOf('async function sendToChat');
  const body = CODE.slice(start, start + 6000);
  assert.match(body, /sendDelay/, '必须记录实际计算出的 sendDelay');
  assert.match(body, /branch/, '必须记录 branch（分支说明），否则看不出走了哪条路');
});

test('延迟记录包含关键配置项（便于排查参数是否生效）', () => {
  const start = CODE.indexOf('async function sendToChat');
  const body = CODE.slice(start, start + 6000);
  // 至少包含这几项中的大多数
  const keys = ['adaptiveThreshold', 'thinkRatio', 'thinkMaxDelay', 'globalSendDelay', 'lastThinkMs'];
  const hit = keys.filter((k) => body.includes(k));
  assert.ok(
    hit.length >= 4,
    '延迟记录应包含关键配置项（至少 4 项），实际命中: ' + hit.join(',')
  );
});

test('延迟记录有独立 try/catch，不能影响正常发送', () => {
  const start = CODE.indexOf('async function sendToChat');
  const body = CODE.slice(start, start + 6000);
  const idx = body.indexOf('发送延迟');
  assert.ok(idx >= 0, '必须有延迟记录');
  const before = body.slice(Math.max(0, idx - 600), idx);
  assert.ok(
    before.includes('try'),
    '延迟记录必须包在 try 里 —— 可观测性代码绝不能阻断消息发送'
  );
});
