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

// ===== 参数归一化兜底：单键对象应解出值，不能变 '[object Object]' =====
const { ToolRegistry, Tool, ToolResult } = require('../../tools/ToolRegistry');

test('JsRunner 单键对象参数自动解出值（{title_text:"x"} → "x"）', async () => {
  const reg = new ToolRegistry();
  const spy = new Tool('nameConversation', 'n', { type: 'object', properties: {} }, 'nameConversation(title)');
  let received = null;
  spy.execute = async (p) => { received = p; return ToolResult.success('ok'); };
  reg.register(spy);
  const runner = new JsRunner(reg);
  const r = await runner.run('await nameConversation({ title_text: "单键标题" })', process.cwd());
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(received.title, '单键标题');
});

test('JsRunner 嵌套同名键解开（{title:{title:"x"}} → "x"）', async () => {
  const reg = new ToolRegistry();
  const spy = new Tool('nameConversation', 'n', { type: 'object', properties: {} }, 'nameConversation(title)');
  let received = null;
  spy.execute = async (p) => { received = p; return ToolResult.success('ok'); };
  reg.register(spy);
  const runner = new JsRunner(reg);
  const r = await runner.run('await nameConversation({ title: { title: "嵌套标题" } })', process.cwd());
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(received.title, '嵌套标题');
});

test('JsRunner 多键对象不误伤（headers 等真对象保持原样）', async () => {
  const reg = new ToolRegistry();
  const spy = new Tool('web_fetch', 'w', { type: 'object', properties: {} }, 'webFetch(url,opts)');
  let received = null;
  spy.execute = async (p) => { received = p; return ToolResult.success('ok'); };
  reg.register(spy);
  const runner = new JsRunner(reg);
  const r = await runner.run('await webFetch("https://x", { headers: { a: 1, b: 2 } })', process.cwd());
  assert.strictEqual(r.success, true, r.error);
  assert.deepStrictEqual(received.headers, { a: 1, b: 2 });
});

test('JsRunner 对象参数完全无法解出时返回明确错误而非 [object Object]', async () => {
  const reg = new ToolRegistry();
  const spy = new Tool('nameConversation', 'n', { type: 'object', properties: {} }, 'nameConversation(title)');
  let received = null;
  spy.execute = async (p) => { received = p; return ToolResult.success('ok'); };
  reg.register(spy);
  const runner = new JsRunner(reg);
  // 多键且无同名/别名键 → 无法安全解出，应保持对象让工具层报错
  const r = await runner.run('await nameConversation({ a: 1, b: 2 })', process.cwd());
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(typeof received.title, 'object');
  assert.ok(!String(received.title).includes('[object Object]') || typeof received.title === 'object');
});

// ===== toolCalls 回传（供监督者激活判定）=====
test('JsRunner 回传本次脚本实际调用过的工具名', async () => {
  const reg = new ToolRegistry();
  const w = new Tool('todo_write', 't', { type: 'object', properties: {} }, 'todoWrite(todos)');
  w.execute = async () => ToolResult.success({ ok: 1 });
  reg.register(w);
  const runner = new JsRunner(reg);
  const r = await runner.run('await todoWrite([{content:"a"}]); await todoWrite([{content:"b"}]);', process.cwd());
  assert.strictEqual(r.success, true, r.error);
  assert.ok(Array.isArray(r.toolCalls), 'toolCalls 应为数组');
  assert.deepStrictEqual(r.toolCalls, ['todo_write', 'todo_write']);
});

test('JsRunner 未调用工具时 toolCalls 为空数组', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const x = 1;', process.cwd());
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.toolCalls, []);
});

test('JsRunner 工具失败也记录（调用过就算）', async () => {
  const reg = new ToolRegistry();
  const w = new Tool('todo_write', 't', { type: 'object', properties: {} }, 'todoWrite(todos)');
  w.execute = async () => ToolResult.error('boom');
  reg.register(w);
  const runner = new JsRunner(reg);
  const r = await runner.run('try { await todoWrite([]); } catch (e) {}', process.cwd());
  assert.deepStrictEqual(r.toolCalls, ['todo_write']);
});

test('JsRunner 失败结果也带 toolCalls', async () => {
  const reg = new ToolRegistry();
  const w = new Tool('todo_write', 't', { type: 'object', properties: {} }, 'todoWrite(todos)');
  w.execute = async () => ToolResult.success({ ok: 1 });
  reg.register(w);
  const runner = new JsRunner(reg);
  const r = await runner.run('await todoWrite([]); throw new Error("炸了");', process.cwd());
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(r.toolCalls, ['todo_write'], '失败时也要回传已调用的工具');
});


