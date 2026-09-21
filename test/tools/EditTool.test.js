'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseEditArgs, formatEditOutput, formatDryRunOutput } = require('../../tools/EditTool');

test('parseEditArgs 正常', () => {
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', false), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: false, dryRun: false });
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', true), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: true, dryRun: false });
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', true, true), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: true, dryRun: true });
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', false, false), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: false, dryRun: false });
  // dryRun 参数缺失或非 true 时统一为 false（老版本兼容）
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', false, undefined), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: false, dryRun: false });
  assert.deepStrictEqual(parseEditArgs('a.txt', 'old', 'new', false, 1), { filePath: 'a.txt', oldString: 'old', newString: 'new', replaceAll: false, dryRun: false });
});

test('parseEditArgs 空 filePath', () => {
  assert.throws(() => parseEditArgs('', 'o', 'n', false), /file_path must be a non-empty string/);
});

test('parseEditArgs 空 old_string', () => {
  assert.throws(() => parseEditArgs('a.txt', '', 'n', false), /old_string must be a non-empty string/);
  assert.throws(() => parseEditArgs('a.txt', null, 'n', false), /old_string must be a non-empty string/);
});

test('parseEditArgs new_string 非字符串', () => {
  assert.throws(() => parseEditArgs('a.txt', 'o', 123, false), /new_string must be a string/);
});

test('parseEditArgs old === new 抛错', () => {
  assert.throws(() => parseEditArgs('a.txt', 'same', 'same', false), /old_string and new_string must differ/);
});

test('formatEditOutput 唯一/全部替换', () => {
  assert.match(formatEditOutput('a.txt', false), /updated successfully/);
  assert.match(formatEditOutput('a.txt', false), /Replaced 1 occurrence/);
  assert.match(formatEditOutput('a.txt', true, 3), /Replaced 3 occurrences/);
  // 省略 occurrences 时默认为 1
  assert.match(formatEditOutput('a.txt', true), /Replaced 1 occurrence/);
  // 单数/复数
  assert.match(formatEditOutput('a.txt', true, 2), /Replaced 2 occurrences/);
});

test('formatDryRunOutput 预览', () => {
  assert.match(formatDryRunOutput('a.txt', 'x', 'y', 1, false), /DRY-RUN/);
  assert.match(formatDryRunOutput('a.txt', 'x', 'y', 1, false), /将替换 1 处/);
  assert.match(formatDryRunOutput('a.txt', 'x', 'y', 3, true), /将全部替换 3 处/);
  // 非 replaceAll 时始终显示将替换 1 处，即使 occurrences 大于 1
  assert.match(formatDryRunOutput('a.txt', 'x', 'y', 3, false), /将替换 1 处/);
  // 删除场景（空 new_string）
  assert.match(formatDryRunOutput('a.txt', 'x', '', 1, false), /old: "x" → new: ""/);
});
