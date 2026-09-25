const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { AGENTS, getAgent, listAgents, DEFAULT_AGENT_ID } = require('../../src/main/agents');
const { ToolRegistry, Tool, ToolResult } = require('../../tools/ToolRegistry');
const { JsRunner } = require('../../tools/JsRunner');

function mkTool(name, jsApi) {
  const t = new Tool(name, name + ' desc', { type: 'object', properties: {} }, jsApi);
  t.getPromptSection = () => ({ name: 'tool:' + name, order: 100, text: 'section of ' + name });
  return t;
}

test('agents 定义：build 无禁用工具，plan 禁用写/改/删', () => {
  assert.deepStrictEqual(getAgent('build').deniedTools, []);
  const plan = getAgent('plan').deniedTools;
  assert.ok(plan.includes('write') && plan.includes('edit') && plan.includes('file_delete'));
});

test('agents 未知 id 回退默认', () => {
  assert.strictEqual(getAgent('unknown').id, DEFAULT_AGENT_ID);
  assert.strictEqual(listAgents().length, 2);
});

test('ToolRegistry.getFormattedJsApiForPrompt 按排除集过滤', () => {
  const reg = new ToolRegistry();
  reg.register(mkTool('read', 'read(fp)'));
  reg.register(mkTool('write', 'write(fp, c)'));
  reg.register(mkTool('edit', 'edit(fp, a, b)'));

  const full = reg.getFormattedJsApiForPrompt();
  assert.ok(full.includes('write(') && full.includes('edit(') && full.includes('read('));

  const filtered = reg.getFormattedJsApiForPrompt(new Set(['write', 'edit']));
  assert.ok(!filtered.includes('write('));
  assert.ok(!filtered.includes('edit('));
  assert.ok(filtered.includes('read('));
});

test('ToolRegistry.getFormattedPromptSections 按排除集过滤', () => {
  const reg = new ToolRegistry();
  reg.register(mkTool('read', 'read(fp)'));
  reg.register(mkTool('write', 'write(fp, c)'));
  const secs = reg.getFormattedPromptSections(['write']);
  assert.ok(!secs.includes('section of write'));
  assert.ok(secs.includes('section of read'));
});

test('agent-store 默认/持久化/隔离/清除', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-test-'));
  delete require.cache[require.resolve('../../src/main/agent-store')];
  const agentStore = require('../../src/main/agent-store');
  agentStore.init(tmp);

  assert.strictEqual(agentStore.getAgentId('p1'), 'build');
  agentStore.setAgentId('p1', 'plan');
  assert.strictEqual(agentStore.getAgentId('p1'), 'plan');
  assert.strictEqual(agentStore.getAgentId('p2'), 'build');
  assert.throws(() => agentStore.setAgentId('p1', 'bogus'));
  agentStore.clearProfile('p1');
  assert.strictEqual(agentStore.getAgentId('p1'), 'build');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('JsRunner 执行层硬拒绝 plan 禁用工具', async () => {
  const reg = new ToolRegistry();
  const w = new Tool('write', 'w', { type: 'object', properties: {} }, 'write(fp,c)');
  w.execute = async () => ToolResult.success('WROTE');
  reg.register(w);
  const runner = new JsRunner(reg);

  const denied = await runner.run('return await write("a.txt","hi")', process.cwd(), { deniedTools: ['write'] });
  assert.strictEqual(denied.success, false);
  assert.ok(denied.error.includes('禁止'));

  const allowed = await runner.run('return await write("a.txt","hi")', process.cwd(), { deniedTools: [] });
  assert.strictEqual(allowed.success, true);
});

// ===== 方案 B：Plan 模式只读守卫 =====
const { isWriteCommand } = require('../../tools/readonly-guard');

test('readonly-guard 放行只读命令', () => {
  const readOnly = [
    'cat a.txt', 'ls -la', 'dir', 'type a.txt', 'grep foo bar',
    'git status', 'git log --oneline', 'git diff', 'find . -name *.js',
    'echo hello', 'node script.js', 'python test.py', 'pwd', 'head -5 a.txt',
  ];
  for (const c of readOnly) {
    assert.strictEqual(isWriteCommand(c), false, '误判只读: ' + c);
  }
});

test('readonly-guard 拦截写命令', () => {
  const writes = [
    'echo x > a.txt', 'echo x >> a.txt', 'rm a.txt', 'mkdir foo', 'cp a b', 'mv a b',
    'del a.txt', 'copy a b', 'touch new.txt', 'sed -i s/a/b/ f', 'tee out.txt',
    'Set-Content a hi', 'Out-File a', 'Remove-Item a', 'New-Item -ItemType File a',
    'git add .', 'git commit -m x', 'git push', 'npm install', 'pip install x',
  ];
  for (const c of writes) {
    assert.strictEqual(isWriteCommand(c), true, '漏判写操作: ' + c);
  }
});

test('readonly-guard 忽略 fd 合并与转义重定向', () => {
  assert.strictEqual(isWriteCommand('echo x >&2'), false, '>&2 非写文件');
  assert.strictEqual(isWriteCommand('cmd 2>nul'), false, 'nul 非写文件');
  assert.strictEqual(isWriteCommand('echo a ^> b'), false, 'cmd 转义 ^> 非重定向');
});

test('BashTool readonlyShell 拒绝写命令 / 放行只读', async () => {
  const { BashTool } = require('../../tools/BashTool');
  const tool = new BashTool();

  const w = await tool.execute({ command: 'echo x > blocked.txt', projectDir: process.cwd(), readonlyShell: true });
  assert.strictEqual(w.success, false, 'plan 模式应拒绝重定向写');
  assert.ok(String(w.error).includes('只读'));

  const r = await tool.execute({ command: 'echo hello', projectDir: process.cwd(), readonlyShell: true });
  assert.strictEqual(r.success, true, 'plan 模式应放行只读 echo');
});

test('JsRunner readonlyShell 拦截 bash 写操作', async () => {
  const reg = new ToolRegistry();
  const runner = new JsRunner(reg);
  const denied = await runner.run('return await bash("echo x > blocked.txt")', process.cwd(), { readonlyShell: true });
  assert.strictEqual(denied.success, false);
  assert.ok(String(denied.error).includes('只读'));
});

