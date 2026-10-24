'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 输入指纹测试（DeepSeek 封号根因 ③-B1）。
 *
 * 旧实现：nativeSetter.call(input, msg) 一次灌全文 + 只派发 1 次 input 事件。
 * 真人打字是数百次 input + IME composition；一次事件塞十万字符无可辩驳是脚本。
 * contenteditable 分支早有分段 paste，但 DeepSeek 走 textarea，那段完全不生效。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js'),
  'utf8'
);
const STATE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'state.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

function fillBody() {
  const i = CODE.indexOf('async function setInputContent');
  assert.ok(i >= 0, '必须有 setInputContent');
  return CODE.slice(i, i + 2200);
}

test('textarea 分支禁止一次性灌入完整消息', () => {
  assert.ok(
    !/nativeSetter\.call\(input,\s*msg\s*\)/.test(fillBody()),
    '禁止 nativeSetter.call(input, msg) —— 那是极强 bot 指纹'
  );
});

test('textarea 分支必须循环分段写入', () => {
  const body = fillBody();
  assert.match(body, /while\s*\(/, '必须有分段循环');
  assert.match(body, /nativeSetter\.call/, '必须有 nativeSetter.call');
});

test('input 事件必须在循环内逐段派发', () => {
  const body = fillBody();
  const whileAt = body.indexOf('while (');
  const dispatchAt = body.indexOf("dispatchEvent(new Event('input'");
  assert.ok(whileAt >= 0, '必须有循环');
  assert.ok(dispatchAt > whileAt, 'input 事件派发必须落在循环内，否则等于只派发一次');
});

test('段长与段间隔必须带随机抖动', () => {
  assert.match(fillBody(), /Math\.random\(\)/, '必须有随机抖动，避免等长分段的机械特征');
});

test('快请求默认延迟区间跨度必须足够（>= 3s）', () => {
  const mn = Number(/globalSendDelayMin:\s*(\d+)/.exec(STATE)[1]);
  const mx = Number(/globalSendDelayMax:\s*(\d+)/.exec(STATE)[1]);
  assert.ok(mx - mn >= 3000, '区间跨度至少 3s，当前 ' + mn + '~' + mx);
});
