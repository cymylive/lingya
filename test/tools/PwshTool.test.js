'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { PwshTool, DANGEROUS_PWSH_CMDS } = require('../../tools/PwshTool');

test('DANGEROUS_PWSH_CMDS 定义完整', () => {
  assert.ok(Array.isArray(DANGEROUS_PWSH_CMDS));
  assert.ok(DANGEROUS_PWSH_CMDS.length >= 13);
});

test('PwshTool 危险命令拒绝', async () => {
  const tool = new PwshTool();
  const cmds = [
    'rm -rf /',
    'format C:',
    'Stop-Computer',
    'Restart-Computer',
    'Clear-Disk',
  ];
  for (const cmd of cmds) {
    const r = await tool.execute({ command: cmd, description: 'test' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /安全策略拒绝/);
  }
});

test('PwshTool 空命令拒绝', async () => {
  const tool = new PwshTool();
  const r = await tool.execute({ command: '', description: 'test' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /invalid command/);
});

test('PwshTool 空描述不拒绝', async () => {
  const tool = new PwshTool();
  const r = await tool.execute({ command: 'Write-Output hi', description: '' });
  assert.strictEqual(r.success, true);
});
