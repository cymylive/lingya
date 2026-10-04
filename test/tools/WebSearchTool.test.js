'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBingResults, parseExaResponse } = require('../../tools/WebSearchTool');

test('parseExaResponse 解析直连 JSON', () => {
  const body = JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: A\nURL: https://a' }] } });
  assert.strictEqual(parseExaResponse(body), 'Title: A\nURL: https://a');
});

test('parseExaResponse 解析 SSE data 行', () => {
  const body = 'event: message\ndata: ' + JSON.stringify({ result: { content: [{ type: 'text', text: 'SSE 正文' }] } });
  assert.strictEqual(parseExaResponse(body), 'SSE 正文');
});

test('parseExaResponse 无内容返回 null', () => {
  assert.strictEqual(parseExaResponse(''), null);
  assert.strictEqual(parseExaResponse('not json'), null);
  assert.strictEqual(parseExaResponse(JSON.stringify({ result: { content: [] } })), null);
});

test('parseBingResults 仍可用（降级路径）', () => {
  const html = '<li class="b_algo"><h2><a href="https://x.com">标题</a></h2><div class="b_caption"><p>摘要</p></div></li>';
  const out = parseBingResults(html, 5);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].url, 'https://x.com');
});
