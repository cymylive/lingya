/**
 * 上传引导语回归测试（2026-10-30 四版）
 *
 * 演进历史：
 *   1. 初版：恒定「请阅读附件 lingya-input.md 并按其中内容执行。」——强机器指纹
 *   2. 二版：20 条文案池随机，约一半带文件名——降低指纹，但界面上仍有文字
 *   3. 三版：恒定零宽空格 \u200B——视觉上等于「没有引导语」
 *   4. 四版（当前）：短句池随机，恢复可见文本
 *
 * 为什么撤掉零宽空格（三版的问题）：
 *   三版只验证了「前端发送按钮能不能点」，没验证「服务端收到什么」。
 *   零宽方案下服务端每条消息的 content 恰好是一个不可见字符，真人不可能
 *   连发几十条这种消息 —— 这是比行为特征更硬的内容特征。
 *
 * 四版的约束：
 *   - 必须是人类可读的短句（满足平台非空校验即可，不需要长）
 *   - 必须随机（不能恒返回同一条）
 *   - 不能恒返回零宽字符
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

test('pickHint 绝不能返回零宽空格（服务端会看到 content 是不可见字符）', () => {
  for (let i = 0; i < 100; i++) {
    const h = pickHint('草稿-' + i + '.md');
    assert.notStrictEqual(h, ZERO_WIDTH, '四版已撤掉零宽空格方案');
    assert.ok(!h.includes('\u200B'), '引导语不应包含零宽字符');
  }
});

test('pickHint 返回可读文本（至少含一个可见字符）', () => {
  for (let i = 0; i < 50; i++) {
    const h = pickHint('记录-' + i + '.md');
    // 有可见字符意味着去掉不可见字符后仍有内容
    const visible = h.replace(/[\u200B-\u200D\uFEFF\s]/g, '');
    assert.ok(visible.length > 0, '引导语必须含可见字符：' + JSON.stringify(h));
  }
});

test('pickHint 有随机性（多次调用不应恒返回同一串）', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickHint('分析-' + i + '.md'));
  assert.ok(seen.size >= 3, '引导语池随机性不足，200 次只出现 ' + seen.size + ' 种');
});

test('pickHint 连续两次不返回同一条', () => {
  // 池大小 > 1 时，实现会主动避免连续重复
  let sameCount = 0;
  for (let i = 0; i < 100; i++) {
    const a = pickHint('a.md');
    const b = pickHint('b.md');
    if (a === b) sameCount++;
  }
  assert.strictEqual(sameCount, 0, '出现了连续相同引导语 ' + sameCount + ' 次');
});

test('ZERO_WIDTH 常量仍导出（向后兼容），但不再被 pickHint 使用', () => {
  assert.strictEqual(ZERO_WIDTH, '\u200B');
});

test('FALLBACK_HINT 是可见且非空的兜底字符', () => {
  assert.strictEqual(typeof FALLBACK_HINT, 'string');
  assert.ok(FALLBACK_HINT.length > 0);
  assert.strictEqual(FALLBACK_HINT.trim().length, FALLBACK_HINT.length,
    '兜底字符本身不应含首尾空白');
});

test('pickHint 忽略 fileName 参数（引导语池不带文件名）', () => {
  // 参数保留是为了调用点兼容，但内容不应依赖它
  const results = new Set();
  for (let i = 0; i < 100; i++) results.add(pickHint('任意名字.md'));
  assert.ok(results.size >= 2, '引导语不应与 fileName 绑定成固定搭配');
});
