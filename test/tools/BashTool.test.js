'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { BashTool, DANGEROUS_CMDS } = require('../../tools/BashTool');

test('DANGEROUS_CMDS 定义完整', () => {
  assert.ok(Array.isArray(DANGEROUS_CMDS));
  assert.ok(DANGEROUS_CMDS.length >= 9);
});

test('BashTool 危险命令拒绝', async () => {
  const tool = new BashTool();
  const tests = [
    'rm -rf /',
    'format C:',
    'shutdown /s',
  ];
  for (const cmd of tests) {
    const r = await tool.execute({ command: cmd, description: 'test' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /安全策略拒绝/);
  }
});

test('BashTool 空命令拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: '', description: 'test' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /invalid command/);
});

test('BashTool 空描述不拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 'echo hi', description: '' });
  assert.strictEqual(r.success, true);
});

test('BashTool 缺失描述不拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 'echo hi' });
  assert.strictEqual(r.success, true);
});

test('BashTool 非字符串命令拒绝', async () => {
  const tool = new BashTool();
  const r = await tool.execute({ command: 123, description: 'test' });
  assert.strictEqual(r.success, false);
});
