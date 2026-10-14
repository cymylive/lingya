/**
 * data-dir 多实例支持测试
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { sanitizeInstanceName, resolveInstanceDir } = require('../../src/main/data-dir.js');

test('sanitizeInstanceName 过滤非法字符', () => {
  assert.strictEqual(sanitizeInstanceName('work-1'), 'work-1');
  assert.strictEqual(sanitizeInstanceName('a/b\\c..d'), 'abcd');
  assert.strictEqual(sanitizeInstanceName('中文'), '');
  assert.strictEqual(sanitizeInstanceName('x'.repeat(50)).length, 32);
});

test('sanitizeInstanceName 空输入返回空串', () => {
  assert.strictEqual(sanitizeInstanceName(''), '');
  assert.strictEqual(sanitizeInstanceName(null), '');
  assert.strictEqual(sanitizeInstanceName(undefined), '');
});

test('resolveInstanceDir 无 LINGYA_INSTANCE 返回 null', () => {
  assert.strictEqual(resolveInstanceDir('/base', {}), null);
  assert.strictEqual(resolveInstanceDir('/base', { LINGYA_INSTANCE: '' }), null);
  assert.strictEqual(resolveInstanceDir('/base', { LINGYA_INSTANCE: '   ' }), null);
});

test('resolveInstanceDir 有具名实例返回 instances/<name>', () => {
  const r = resolveInstanceDir('/base', { LINGYA_INSTANCE: 'work' });
  assert.strictEqual(r, path.join('/base', 'instances', 'work'));
});

test('resolveInstanceDir 清洗路径穿越', () => {
  const r = resolveInstanceDir('/base', { LINGYA_INSTANCE: '../evil' });
  assert.strictEqual(r, path.join('/base', 'instances', 'evil'));
});
