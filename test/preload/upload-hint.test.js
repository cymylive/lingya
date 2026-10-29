/**
 * 上传引导语回归测试（2026-10-30 三版）
 *
 * 演进历史：
 *   1. 初版：恒定「请阅读附件 lingya-input.md 并按其中内容执行。」——强机器指纹
 *   2. 二版：20 条文案池随机，约一半带文件名——降低指纹，但界面上仍有文字
 *   3. 三版（当前）：恒定零宽空格 \u200B——视觉上等于「没有引导语」
 *
 * 三版的实测依据见 src/preload/dom/upload-hint.js 顶部注释。
 * 本测试文件已同步更新为三版行为。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { pickHint, ZERO_WIDTH, FALLBACK_HINT } = require('../../src/preload/dom/upload-hint');

test('pickHint 返回非空字符串（满足平台 value 非空校验）', () => {
  for (let i = 0; i < 30; i++) {
    const h = pickHint('笔记-103015.md');
    assert.strictEqual(typeof h, 'string');
    assert.ok(h.length > 0, '空引导语会让发送按钮保持 disabled');
  }
});

test('pickHint 不再返回固定原文案', () => {
  const OLD = '请阅读附件 lingya-input.md 并按其中内容执行。';
  for (let i = 0; i < 60; i++) {
    assert.notStrictEqual(pickHint('任务-103015.md'), OLD);
  }
});

test('pickHint 恒定返回零宽空格（视觉上等于无引导语）', () => {
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(pickHint('草稿-' + i + '.md'), ZERO_WIDTH);
  }
});

test('ZERO_WIDTH 是单个 U+200B 字符（length=1 但不可见）', () => {
  assert.strictEqual(ZERO_WIDTH.length, 1);
  assert.strictEqual(ZERO_WIDTH, '\u200B');
  // trim 不去掉零宽空格，这是它能通过平台校验的关键
  assert.strictEqual(ZERO_WIDTH.trim().length, 1);
});

test('FALLBACK_HINT 是可见且非空的兜底字符', () => {
  assert.strictEqual(typeof FALLBACK_HINT, 'string');
  assert.ok(FALLBACK_HINT.length > 0);
  assert.strictEqual(FALLBACK_HINT.trim().length, FALLBACK_HINT.length,
    '兜底字符本身不应含首尾空白');
});

test('pickHint 忽略 fileName 参数（保留兼容性但不再使用）', () => {
  assert.strictEqual(pickHint('任意名字.md'), pickHint(''));
  assert.strictEqual(pickHint(undefined), ZERO_WIDTH);
});
