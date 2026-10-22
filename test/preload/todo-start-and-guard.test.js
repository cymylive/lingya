'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ===================== 开始处理按钮 =====================

test('待办项必须有「开始处理」按钮', () => {
  const src = read('src/preload/overlay/plan-panel.js');
  assert.ok(src.includes('data-act="start"'), '必须有 data-act=start 按钮');
  assert.ok(src.includes('lingya-utodo-start'), '必须有对应 CSS 类');
});

test('点击开始处理必须自动发送待办内容', () => {
  const src = read('src/preload/overlay/plan-panel.js');
  const idx = src.indexOf("data-act=\"start\"");
  assert.ok(idx >= 0);
  const seg = src.slice(idx, idx + 1600);
  assert.ok(seg.includes('sendMessageToChat'), '必须调用 sendMessageToChat');
  assert.ok(seg.includes('auto: true'), '必须自动发送');
  assert.ok(seg.includes('item.text'), '内容必须包含待办文本');
});

test('开始处理必须防重复点击', () => {
  const src = read('src/preload/overlay/plan-panel.js');
  const idx = src.indexOf("data-act=\"start\"");
  const seg = src.slice(idx, idx + 1600);
  assert.ok(seg.includes('busy'), '必须有 busy 标记防重复');
});

test('开始处理按钮必须有 CSS 样式', () => {
  const src = read('src/preload/overlay/template.js');
  assert.ok(src.includes('.lingya-utodo-start'), '必须有 CSS 类定义');
  assert.ok(src.includes('cursor: pointer'), '必须可点击');
});
// ===================== 系统消息防护 =====================

test('存储层必须导出系统消息黑名单', () => {
  const src = read('tools/UserTodoStore.js');
  assert.ok(src.includes('SYSTEM_PREFIXES'), '必须定义黑名单');
  assert.ok(src.includes('【监督续跑】'), '必须包含监督续跑前缀');
  assert.ok(src.includes('must not be a system message'), '必须抛出明确错误');
});

test('前端提交前必须预检系统消息', () => {
  const src = read('src/preload/overlay/plan-panel.js');
  assert.ok(src.includes('SYSTEM_PREFIXES_UI'), '前端必须有黑名单副本');
  assert.ok(src.includes('系统消息'), '必须有友好提示文案');
});
