'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOL_NAMES, hasTool, toolNamesList } = require('../../src/preload/tool-names');

test('TOOL_NAMES 包含全部工具名', () => {
  assert.ok(Array.isArray(TOOL_NAMES));
  assert.ok(TOOL_NAMES.length >= 16);
  assert.ok(TOOL_NAMES.includes('file_write'));
  assert.ok(TOOL_NAMES.includes('write'));
  assert.ok(TOOL_NAMES.includes('read'));
  assert.ok(TOOL_NAMES.includes('edit'));
  assert.ok(TOOL_NAMES.includes('bash'));
  assert.ok(TOOL_NAMES.includes('pwsh'));
  assert.ok(TOOL_NAMES.includes('todo_write'));
  assert.ok(TOOL_NAMES.includes('web_fetch'));
  assert.ok(TOOL_NAMES.includes('mcp_list_servers'));
  assert.ok(TOOL_NAMES.includes('mcp_get_tools'));
});

test('hasTool 判断存在性', () => {
  assert.strictEqual(hasTool('bash'), true);
  assert.strictEqual(hasTool('read'), true);
  assert.strictEqual(hasTool('nonexistent'), false);
  assert.strictEqual(hasTool(''), false);
});

test('toolNamesList 返回逗号分隔字符串', () => {
  const list = toolNamesList();
  assert.strictEqual(list, TOOL_NAMES.join(', '));
  assert.match(list, /bash/);
});
