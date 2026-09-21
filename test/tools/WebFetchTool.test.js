'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFetchArgs, formatFetchOutput } = require('../../tools/WebFetchTool');

test('parseFetchArgs 正常', () => {
  assert.deepStrictEqual(parseFetchArgs('https://example.com'), { url: 'https://example.com' });
});

test('parseFetchArgs 空/非字符串抛错', () => {
  assert.throws(() => parseFetchArgs(''), /url must be a non-empty string/);
  assert.throws(() => parseFetchArgs(null), /url must be a non-empty string/);
  assert.throws(() => parseFetchArgs(123), /url must be a non-empty string/);
});

test('formatFetchOutput html 转 markdown', () => {
  const html = '<h1>标题</h1><p>内容</p>';
  const out = formatFetchOutput('https://example.com', 200, 'html', html, false);
  assert.match(out, /Fetched https:\/\/example\.com \(HTTP 200\)/);
  assert.match(out, /标题/);
  assert.match(out, /内容/);
});

test('formatFetchOutput text 原样', () => {
  const out = formatFetchOutput('https://example.com', 200, 'text', 'plain text', false);
  assert.match(out, /plain text/);
});

test('formatFetchOutput 截断 footer', () => {
  const long = 'x'.repeat(30000);
  const out = formatFetchOutput('https://example.com', 200, 'text', long, false);
  assert.match(out, /\(Content truncated/);
});

test('formatFetchOutput 显式 truncated 参数', () => {
  const out = formatFetchOutput('https://example.com', 200, 'text', 'abc', true);
  assert.match(out, /\(Content truncated/);
});
