'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseReadArgs, buildWindow, formatReadOutput, READ_LIMIT, READ_MAX_LINE_LENGTH, READ_MAX_BYTES } = require('../../tools/ReadTool');

test('parseReadArgs 默认值', () => {
  const r = parseReadArgs('a.txt', undefined, undefined);
  assert.deepStrictEqual(r, { offset: 1, limit: READ_LIMIT });
});

test('parseReadArgs 自定义正整数', () => {
  assert.deepStrictEqual(parseReadArgs('a.txt', 3, 10), { offset: 3, limit: 10 });
});

test('parseReadArgs 空路径抛错', () => {
  assert.throws(() => parseReadArgs('', 1, 10), /file_path must be a non-empty string/);
  assert.throws(() => parseReadArgs(null, 1, 10), /file_path must be a non-empty string/);
});

test('parseReadArgs offset 非法', () => {
  assert.throws(() => parseReadArgs('a', 0, 10), /offset must be a positive integer/);
  assert.throws(() => parseReadArgs('a', 1.5, 10), /offset must be a positive integer/);
  assert.throws(() => parseReadArgs('a', -1, 10), /offset must be a positive integer/);
});

test('parseReadArgs limit 非法和超上限', () => {
  assert.throws(() => parseReadArgs('a', 1, 0), /limit must be a positive integer/);
  assert.throws(() => parseReadArgs('a', 1, READ_LIMIT + 1), /limit must be less than or equal to/);
});

test('buildWindow 基本窗口', () => {
  const req = { offset: 1, limit: 5, maxLineLength: 100, maxBytes: 10000 };
  const w = buildWindow('line1\nline2\nline3', req, 'f.txt');
  assert.strictEqual(w.totalLines, 3);
  assert.strictEqual(w.lines.length, 3);
  assert.deepStrictEqual(w.lines.map(l => l.text), ['line1', 'line2', 'line3']);
  assert.deepStrictEqual(w.lines.map(l => l.number), [1, 2, 3]);
});

test('buildWindow offset 与 limit 分段', () => {
  const req = { offset: 2, limit: 1, maxLineLength: 100, maxBytes: 10000 };
  const w = buildWindow('a\nb\nc', req, 'f.txt');
  assert.strictEqual(w.totalLines, 3);
  assert.strictEqual(w.lines.length, 1);
  assert.strictEqual(w.lines[0].text, 'b');
  assert.strictEqual(w.lines[0].number, 2);
});

test('buildWindow offset 越界抛错', () => {
  const req = { offset: 5, limit: 5, maxLineLength: 100, maxBytes: 10000 };
  assert.throws(() => buildWindow('a\nb\nc', req, 'f.txt'), /offset 5 is out of range/);
});

test('buildWindow 空文件 offset=1 不抛错', () => {
  const req = { offset: 1, limit: 5, maxLineLength: 100, maxBytes: 10000 };
  const w = buildWindow('', req, 'empty.txt');
  assert.strictEqual(w.totalLines, 1);
  assert.strictEqual(w.lines.length, 1);
  assert.strictEqual(w.lines[0].text, '');
});

test('buildWindow 超长行截断', () => {
  const long = 'x'.repeat(10);
  const req = { offset: 1, limit: 5, maxLineLength: 5, maxBytes: 10000 };
  const w = buildWindow(long, req, 'f.txt');
  assert.strictEqual(w.lines[0].text, 'xxxxx... (line truncated to 5 chars)');
});

test('buildWindow 字节上限截断', () => {
  const req = { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 10 };
  const w = buildWindow('hello\nworld\n!', req, 'f.txt');
  assert.strictEqual(w.truncatedByBytes, true);
  assert.ok(w.lines.length < 3);
});

test('formatReadOutput 完整文件', () => {
  const out = { offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }], totalLines: 2, truncatedByBytes: false };
  const s = formatReadOutput('f.txt', out);
  assert.match(s, /<path>f.txt<\/path>/);
  assert.match(s, /1: a/);
  assert.match(s, /2: b/);
  assert.match(s, /\(End of file - total 2 lines\)/);
});

test('formatReadOutput 无行仅有 footer', () => {
  const out = { offset: 2, lines: [], totalLines: 1, truncatedByBytes: false };
  const s = formatReadOutput('f.txt', out);
  assert.match(s, /\(End of file/);
});
