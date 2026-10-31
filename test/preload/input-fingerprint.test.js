'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 输入指纹测试。
 *
 * 【2026-10-31 改造】原实现走 nativeSetter + 合成 input 事件（textarea 路径）
 * 和合成 ClipboardEvent（contenteditable 路径），isTrusted 恒为 false。
 * 现在统一改走 CDP Input.insertText —— 浏览器内核级输入，isTrusted=true。
 *
 * 本文件的断言随之从「循环分段是否拟人」转为「是否还残留合成事件路径」。
 * 历史背景（DeepSeek 封号根因 ③-B1）保留在 plan 与 ledger 中。
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
  return CODE.slice(i, i + 3000);
}

test('正文写入必须走 CDP trustedInsertText', () => {
  const body = fillBody();
  assert.match(body, /trustedInsertText\(/, '必须调用 electronAPI.trustedInsertText');
});

test('禁止用合成 input 事件写正文', () => {
  const body = fillBody();
  assert.ok(
    !/dispatchEvent\(new Event\('input'/.test(body),
    '禁止 dispatchEvent(new Event(\'input\')) —— isTrusted=false 是脚本指纹'
  );
});

test('禁止用合成 ClipboardEvent 写正文', () => {
  const body = fillBody();
  assert.ok(
    !/new ClipboardEvent\('paste'/.test(body),
    '禁止合成 ClipboardEvent —— isTrusted=false 是脚本指纹'
  );
});

test('禁止 nativeSetter 一次性写完整正文', () => {
  const body = fillBody();
  assert.ok(
    !/nativeSetter\.call\(input,\s*msg\s*\)/.test(body),
    '禁止 nativeSetter.call(input, msg) —— 极强 bot 指纹'
  );
});

test('失败时不得降级为合成事件（必须有 return false）', () => {
  const body = fillBody();
  assert.match(body, /return false/, '失败必须显式返回 false，不得静默降级');
  // 且失败分支里不能出现 dispatchEvent
  const idx = body.indexOf('trustedInsertText');
  assert.ok(idx >= 0, '必须调用 trustedInsertText');
});

test('输入框必须先建选区再插入（否则追加而非替换）', () => {
  const body = fillBody();
  assert.match(body, /selectAllContent\(/, '必须先全选已有内容');
});

test('快请求默认延迟区间跨度必须足够（>= 3s）', () => {
  const mn = Number(/globalSendDelayMin:\s*(\d+)/.exec(STATE)[1]);
  const mx = Number(/globalSendDelayMax:\s*(\d+)/.exec(STATE)[1]);
  assert.ok(mx - mn >= 3000, '区间跨度至少 3s，当前 ' + mn + '~' + mx);
});
