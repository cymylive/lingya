'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { JsRunner } = require('../../tools/JsRunner');
const { registry } = require('../../tools');

test('JsRunner 执行简单 JS 代码', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const x = 1 + 2; log(x);', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('3'));
});

test('JsRunner 空代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('', null);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无效的 JS 代码/);
});

test('JsRunner null 代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run(null, null);
  assert.strictEqual(r.success, false);
});

test('JsRunner 语法错误返回失败', async () => {
  const runner = new JsRunner(registry);
  let r;
  try { r = await runner.run('const = ;', process.cwd()); } catch (e) { r = { success: false, error: e.message }; }
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});

test('JsRunner 调用 read 工具', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const c = await read("package.json"); log(c.slice(0, 20));', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.length > 0);
});

test('JsRunner 未知工具报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('await read("a.txt")', null);
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});


test('JsRunner 每次工具调用都分配独立 lifecycle ID（会话隔离）', async () => {
  const tl = require('../../tools/tool-lifecycle');
  // 打桩记录
  const calls = [];
  const origRegister = tl.register;
  const origMarkDone = tl.markDone;
  tl.register = function (...a) { calls.push('reg:' + a[1]); return origRegister.apply(this, a); };
  tl.markDone = function (...a) { calls.push('done'); return origMarkDone.apply(this, a); };
  try {
    const runner = new JsRunner(registry);
    const code = 'await read("package.json"); await read("package-lock.json");';
    const r = await runner.run(code, process.cwd(), { profileId: 'testP', sessionId: 'testS' });
    assert.strictEqual(r.success, true);
    // 2 次工具调用 → 2 次 register + 2 次 markDone
    const regs = calls.filter(x => x.startsWith('reg:'));
    const dones = calls.filter(x => x === 'done');
    assert.strictEqual(regs.length, 2, '应有 2 次 register, 实际: ' + JSON.stringify(calls));
    assert.strictEqual(dones.length, 2, '应有 2 次 markDone');
  } finally {
    tl.register = origRegister;
    tl.markDone = origMarkDone;
  }
});
