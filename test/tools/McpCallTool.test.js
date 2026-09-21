'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { McpCallTool } = require('../../tools/McpCallTool');

test('McpCallTool 构造器', () => {
  const t = new McpCallTool();
  assert.strictEqual(t.name, 'mcp_call');
  assert.strictEqual(t.jsApi, 'mcpCall(server, tool, args)');
  assert.ok(t.parameters.required.includes('server'));
  assert.ok(t.parameters.required.includes('tool'));
});

test('McpCallTool getPromptSection', () => {
  const t = new McpCallTool();
  const s = t.getPromptSection();
  assert.strictEqual(s.name, 'tool:mcp');
  assert.strictEqual(s.order, 118);
  assert.match(s.text, /mcpCall/);
  assert.match(s.text, /mcpListServers/);
  assert.match(s.text, /mcpGetTools/);
});

test('McpCallTool 缺 server 返回错误', async () => {
  const t = new McpCallTool();
  const r = await t.execute({});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /server 不能为空/);
});

test('McpCallTool 缺 tool 返回错误', async () => {
  const t = new McpCallTool();
  const r = await t.execute({ server: 'everything' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /tool 不能为空/);
});
