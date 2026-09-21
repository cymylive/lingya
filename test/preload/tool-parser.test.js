'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseJsonWithRepair, repairJsonString, tryParseToolCall, extractJsonObject } = require('../../src/preload/dom/tool-parser');

test('parseJsonWithRepair 严格 JSON 直接解析', () => {
  assert.deepStrictEqual(parseJsonWithRepair('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseJsonWithRepair('[1,2,3]'), [1,2,3]);
});

test('parseJsonWithRepair 修复换行后解析', () => {
  const s = '{"a":"line1\nline2"}';
  const r = parseJsonWithRepair(s);
  assert.strictEqual(r.a, 'line1\nline2');
});

test('parseJsonWithRepair 无效返回 null', () => {
  assert.strictEqual(parseJsonWithRepair('not json'), null);
  assert.strictEqual(parseJsonWithRepair(''), null);
  assert.strictEqual(parseJsonWithRepair(null), null);
});

test('repairJsonString 转义字符串内引号', () => {
  const r = repairJsonString('{"a":"he said "hi""}');
  assert.ok(r.includes('\\"hi\\"') || r.includes('\\"hi\\"'));
});

test('tryParseToolCall 标准格式', () => {
  const r = tryParseToolCall('{"toolName":"bash","params":{"command":"echo hi"},"callId":"c1"}');
  assert.strictEqual(r.toolName, 'bash');
  assert.deepStrictEqual(r.params, { command: 'echo hi' });
  assert.strictEqual(r.callId, 'c1');
});

test('tryParseToolCall 支持 tool 与 parameters', () => {
  const r = tryParseToolCall('{"tool":"read","parameters":{"file_path":"a.txt"}}');
  assert.strictEqual(r.toolName, 'read');
  assert.strictEqual(r.params.file_path, 'a.txt');
  assert.ok(r.callId);
});

test('tryParseToolCall 代码块格式', () => {
  const code = '```json\n{"toolName":"bash","params":{}}\n```';
  const r = tryParseToolCall(code);
  assert.strictEqual(r.toolName, 'bash');
});

test('tryParseToolCall 混合文本提取', () => {
  const text = '前面说明 {"toolName":"bash","params":{}} 后面';
  const r = tryParseToolCall(text);
  assert.strictEqual(r.toolName, 'bash');
});

test('tryParseToolCall 缺少工具名返回 null', () => {
  assert.strictEqual(tryParseToolCall('{"params":{}}'), null);
  assert.strictEqual(tryParseToolCall('hello'), null);
  assert.strictEqual(tryParseToolCall(null), null);
});

test('extractJsonObject 完整提取', () => {
  const s = 'prefix {"a":{"b":1}} suffix';
  const start = s.indexOf('{');
  assert.strictEqual(extractJsonObject(s, start), '{"a":{"b":1}}');
});

test('extractJsonObject 未闭合返回 null', () => {
  assert.strictEqual(extractJsonObject('{"a":1', 0), null);
});
