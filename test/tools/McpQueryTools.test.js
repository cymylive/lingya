'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { McpListServersTool, McpGetToolsTool } = require('../../tools/McpQueryTools');

test('McpListServersTool 构造器', () => {
  const t = new McpListServersTool();
  assert.strictEqual(t.name, 'mcp_list_servers');
  assert.strictEqual(t.jsApi, 'mcpListServers()');
});

test('McpListServersTool getPromptSection', () => {
  const t = new McpListServersTool();
  const s = t.getPromptSection();
  assert.strictEqual(s.name, 'tool:mcp-list');
  assert.strictEqual(s.order, 119);
  assert.match(s.text, /mcpListServers/);
});

test('McpGetToolsTool 构造器', () => {
  const t = new McpGetToolsTool();
  assert.strictEqual(t.name, 'mcp_get_tools');
  assert.strictEqual(t.jsApi, 'mcpGetTools(serverName)');
  assert.ok(t.parameters.required.includes('server'));
});

test('McpGetToolsTool getPromptSection', () => {
  const t = new McpGetToolsTool();
  const s = t.getPromptSection();
  assert.strictEqual(s.name, 'tool:mcp-get-tools');
  assert.strictEqual(s.order, 120);
  assert.match(s.text, /mcpGetTools/);
});

test('McpGetToolsTool 缺 server 返回错误', async () => {
  const t = new McpGetToolsTool();
  const r = await t.execute({});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /server 不能为空/);
});
