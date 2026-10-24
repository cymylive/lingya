/**
 * 发送方式可见化回归测试
 *
 * 需求：用户要能在界面上看到 AI 消息到底是「点发送按钮」还是「按回车」发出去的。
 * 这两条走的是不同的可信输入路径（trusted-click / trusted-enter），
 * 排查发送失败时这是第一手线索。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHAT = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js');
const STATE = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'state.js');

test('state 必须定义 lastSendMethod 字段', () => {
  const src = fs.readFileSync(STATE, 'utf-8');
  assert.ok(/lastSendMethod\s*:/.test(src), 'state 缺少 lastSendMethod');
});

test('三条发送路径都要记录各自的 method 值', () => {
  const src = fs.readFileSync(CHAT, 'utf-8');
  assert.ok(src.includes("lastSendMethod = 'provider-native'"), '缺少站点原生标记');
  assert.ok(src.includes("lastSendMethod = 'trusted-click'"), '缺少可信点击标记');
  assert.ok(src.includes("lastSendMethod = 'trusted-enter'"), '缺少可信回车标记');
  assert.ok(src.includes("lastSendMethod = 'failed'"), '缺少失败标记');
});

test('发送成功后必须写入 history，让用户在界面看到方式', () => {
  const src = fs.readFileSync(CHAT, 'utf-8');
  assert.ok(src.includes('[发送方式]'), '缺少发送方式的 history 条目');
  assert.ok(/SEND_METHOD_LABEL/.test(src), '缺少方式到中文标签的映射');
});

test('发送方式 history 写入必须包 try（可观测性不得阻断发送）', () => {
  const src = fs.readFileSync(CHAT, 'utf-8');
  const idx = src.indexOf('[发送方式]');
  assert.ok(idx > 0);
  // 往前找最近的 try
  const before = src.slice(Math.max(0, idx - 800), idx);
  assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('catch'), 'history 写入必须包在 try 里');
});
