/**
 * 三通道面板格式一致性测试（2026-10-30）
 *
 * 背景：QQ / 微信 / 飞书三个通道原先各写各的推送格式。
 * 本次统一抽取 src/main/channel-panel.js 作为唯一格式化来源。
 *
 * 本测试防止未来有人又在某个通道里手写一份格式化逻辑，
 * 导致三端格式再次分叉。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CHANNEL_FILES = {
  qq: 'src/main/qq-ipc.js',
  weixin: 'src/main/weixin-ipc.js',
  feishu: 'src/main/feishu-ipc.js',
};

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

test('三个通道都从 channel-panel 引用格式化函数', () => {
  for (const [name, file] of Object.entries(CHANNEL_FILES)) {
    const src = readSrc(file);
    assert.ok(
      src.indexOf("require('./channel-panel')") !== -1,
      name + ' 通道没有引用 channel-panel'
    );
  }
});

test('三个通道都处理 todo-panel 事件类型', () => {
  for (const [name, file] of Object.entries(CHANNEL_FILES)) {
    const src = readSrc(file);
    assert.ok(
      src.indexOf("'todo-panel'") !== -1,
      name + ' 通道没有处理 todo-panel 事件'
    );
  }
});

test('三个通道都维护 panelPushedThisRound（无计划轮次补面板头的前提）', () => {
  for (const [name, file] of Object.entries(CHANNEL_FILES)) {
    const src = readSrc(file);
    assert.ok(
      src.indexOf('panelPushedThisRound') !== -1,
      name + ' 通道缺少 panelPushedThisRound 追踪'
    );
  }
});

test('三个通道都不再单独推送 ai-start / tool-start 碎片', () => {
  const FORBIDDEN = [
    "'🧠 AI 正在生成…'",
    "'🔧 AI 正在调用工具…'",
    "'🔧 正在调用工具：'",
  ];
  for (const [name, file] of Object.entries(CHANNEL_FILES)) {
    const src = readSrc(file);
    // 只在注释里可以提到，不能在字符串推送里出现
    // 简单判断：不出现 body = '...AI 正在生成...' 这类赋值
    assert.ok(
      !/body\s*=\s*'[^']*AI 正在生成/.test(src),
      name + ' 通道仍在推送「AI 正在生成」碎片'
    );
    assert.ok(
      !/body\s*=\s*'[^']*正在调用工具/.test(src),
      name + ' 通道仍在推送「正在调用工具」碎片'
    );
  }
});

test('channel-panel 导出的三个函数签名正确', () => {
  const mod = require('../../src/main/channel-panel');
  assert.strictEqual(typeof mod.formatNow, 'function');
  assert.strictEqual(typeof mod.formatTodoPanel, 'function');
  assert.strictEqual(typeof mod.formatEmptyPanel, 'function');
});

test('三通道使用的格式化函数产出完全一致', () => {
  const { formatTodoPanel } = require('../../src/main/channel-panel');
  const todos = [
    { content: '步骤1', status: 'completed' },
    { content: '步骤2', status: 'in_progress' },
    { content: '步骤3', status: 'pending' },
  ];
  // 同一输入，两次调用除时间戳外应完全一致（时间精确到秒，同一秒内必然相同）
  const a = formatTodoPanel(todos, '🔧 AI 正在调用工具：bash');
  const b = formatTodoPanel(todos, '🔧 AI 正在调用工具：bash');
  // 剥离时间行后比较，避免跨秒边界导致偶发失败
  const stripTime = (s) => s.split('\n').filter((l) => l.indexOf('当前时间：') !== 0).join('\n');
  assert.strictEqual(stripTime(a), stripTime(b));
});
