/**
 * 附件文件名拟真随机化回归测试
 *
 * 背景：所有自动消息都上传固定名 lingya-input.md + 固定引导语，
 * 对话里全是同一串字，构成强机器指纹。改为「随机词 + 时分秒」文件名，
 * 引导语从文案池随机取并带当前文件名。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const fileUpload = require('../../src/preload/dom/file-upload');

test('pickFileName 返回「词-时分秒.md」格式', () => {
  const name = fileUpload.pickFileName();
  assert.match(name, /^[\u4e00-\u9fa5]{2,4}-\d{6}\.md$/, '实际: ' + name);
});

test('pickFileName 不会返回固定的 lingya-input.md', () => {
  for (let i = 0; i < 50; i++) {
    const name = fileUpload.pickFileName();
    assert.notStrictEqual(name, 'lingya-input.md');
    assert.ok(!/lingya/i.test(name), '不应含 lingya 前缀: ' + name);
  }
});

test('pickFileName 词来自固定词池', () => {
  const words = new Set();
  for (let i = 0; i < 200; i++) {
    const name = fileUpload.pickFileName();
    words.add(name.split('-')[0]);
  }
  assert.ok(words.size >= 5, '200 次应至少命中 5 个不同词，实际 ' + words.size);
});
