/**
 * 可信输入回归测试
 *
 * 背景：DeepSeek 封号根因 ③-B2 —— 程序合成的 click / KeyboardEvent
 * 的 isTrusted 恒为 false，是平台识别脚本操作最直接的信号。
 *
 * 2026-10-24 修复：trustedClickElement / trustedPressEnter 去掉合成事件降级，
 * 宁可失败报错也不要静默伪装成真实输入。本测试锁住这条铁律，防止有人
 * 为了「发送成功率」把降级逻辑加回去。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHAT_INPUT = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js');

function readSrc() {
  return fs.readFileSync(CHAT_INPUT, 'utf-8');
}

function fnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName);
  assert.ok(start > 0, '找不到函数 ' + fnName);
  // 粗略取到下一个顶层 function 声明或文件末尾
  const rest = src.slice(start);
  // 下一个顶层函数（可能是 async function，也可能带注释前缀）
  const re = /\n(?:async\s+)?function\s+\w+/g;
  re.lastIndex = 10;
  const m = re.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

test('trustedClickElement 不得回退到 el.click()', () => {
  const body = fnBody(readSrc(), 'trustedClickElement');
  assert.ok(!/\.click\s*\(/.test(body), 'trustedClickElement 里出现了 el.click() 降级，必须删除');
});

test('trustedClickElement 必须走 electronAPI.trustedClick', () => {
  const body = fnBody(readSrc(), 'trustedClickElement');
  assert.ok(/trustedClick/.test(body), '缺少 trustedClick 调用');
});

test('trustedPressEnter 不得派发合成 KeyboardEvent', () => {
  const body = fnBody(readSrc(), 'trustedPressEnter');
  assert.ok(!/new KeyboardEvent/.test(body), 'trustedPressEnter 里出现了合成 KeyboardEvent 降级，必须删除');
  assert.ok(!/dispatchEvent/.test(body), 'trustedPressEnter 里出现了 dispatchEvent，必须删除');
});

test('trustedPressEnter 必须走 electronAPI.trustedKey', () => {
  const body = fnBody(readSrc(), 'trustedPressEnter');
  assert.ok(/trustedKey/.test(body), '缺少 trustedKey 调用');
});

test('fallbackSend 必须是 async 且 await 两个 trusted 调用', () => {
  const src = readSrc();
  const body = fnBody(src, 'fallbackSend');
  assert.ok(/async function fallbackSend/.test(src), 'fallbackSend 必须是 async');
  assert.ok(/await trustedClickElement/.test(body), '必须 await trustedClickElement');
  assert.ok(/await trustedPressEnter/.test(body), '必须 await trustedPressEnter');
});

test('fallbackSend 全部失败时必须提示用户', () => {
  const body = fnBody(readSrc(), 'fallbackSend');
  assert.ok(/showToast/.test(body), '全部失败时应弹 toast 提示用户手动恢复');
});

test('triggerSend 必须返回 Promise 且透传 fallbackSend 结果', () => {
  const body = fnBody(readSrc(), 'triggerSend');
  assert.ok(/return fallbackSend/.test(body), 'triggerSend 必须 return fallbackSend 的结果');
  assert.ok(/return result\.then/.test(body), 'Provider 异步分支必须 return result.then');
});

test('sendToChat 的延迟回调必须 await triggerSend 并在失败时跳过状态记录', () => {
  const src = readSrc();
  const idx = src.indexOf('setTimeout(async function()');
  assert.ok(idx > 0, '未找到 setTimeout(async function()');
  const body = src.slice(idx, idx + 1500);
  assert.ok(/await triggerSend/.test(body), '必须 await triggerSend');
  assert.ok(/if \(!sent\)/.test(body), '必须判断 sent 为 false 时跳过状态记录');
});
