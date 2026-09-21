'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Tool, ToolRegistry, ToolResult } = require('../../tools/ToolRegistry');

test('Tool 构造与 getDescription', () => {
  const t = new Tool('test', 'desc', { type: 'object' }, 'test()');
  assert.strictEqual(t.name, 'test');
  assert.strictEqual(t.description, 'desc');
  assert.deepStrictEqual(t.parameters, { type: 'object' });
  assert.strictEqual(t.jsApi, 'test()');
  assert.deepStrictEqual(t.getDescription(), { name: 'test', description: 'desc', parameters: { type: 'object' }, jsApi: 'test()' });
  assert.strictEqual(t.getPromptSection(), null);
});

test('Tool execute 默认抛错', async () => {
  const t = new Tool('test', 'desc', {});
  await assert.rejects(() => t.execute({}), /execute\(\) 必须由子类实现/);
});

test('ToolRegistry register/get/size/listNames', () => {
  const r = new ToolRegistry();
  const t = new Tool('a', 'A', {});
  r.register(t);
  assert.strictEqual(r.get('a'), t);
  assert.strictEqual(r.size(), 1);
  assert.deepStrictEqual(r.listNames(), ['a']);
});

test('ToolRegistry register 无 name 抛错', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({}), /工具必须有 name 属性/);
});

test('ToolRegistry 重复注册覆盖并警告', () => {
  const r = new ToolRegistry();
  const oldWarn = console.warn;
  console.warn = () => {};
  try {
    r.register(new Tool('x', 'X', {}));
    const t2 = new Tool('x', 'X2', {});
    r.register(t2);
    assert.strictEqual(r.get('x'), t2);
    assert.strictEqual(r.size(), 1);
  } finally {
    console.warn = oldWarn;
  }
});

test('ToolRegistry execute 未知工具返回 error', async () => {
  const r = new ToolRegistry();
  const result = await r.execute('nope', {});
  assert.strictEqual(result.success, false);
  assert.match(result.error, /未找到工具/);
});

test('ToolRegistry execute 工具抛错包装', async () => {
  const r = new ToolRegistry();
  class BadTool extends Tool {
    constructor() { super('bad', 'bad', {}); }
    async execute() { throw new Error('boom'); }
  }
  r.register(new BadTool());
  const result = await r.execute('bad', {});
  assert.strictEqual(result.success, false);
  assert.match(result.error, /工具执行失败: boom/);
});

test('ToolRegistry getDescriptions', () => {
  const r = new ToolRegistry();
  r.register(new Tool('a', 'A', { type: 'object' }, 'a()'));
  r.register(new Tool('b', 'B', { type: 'object' }, null));
  const descs = r.getDescriptions();
  assert.strictEqual(descs.length, 2);
  assert.strictEqual(descs[0].name, 'a');
});

test('ToolRegistry getFormattedToolsForPrompt 空与有内容', () => {
  const r = new ToolRegistry();
  assert.strictEqual(r.getFormattedToolsForPrompt(), '暂无可用工具');
  r.register(new Tool('a', 'A', { type: 'object', properties: { x: { type: 'string' } } }, 'a()'));
  const out = r.getFormattedToolsForPrompt();
  assert.match(out, /1\. \*\*a\*\*/);
  assert.match(out, /参数: x/);
});

test('ToolRegistry getFormattedJsApiForPrompt 过滤 null jsApi', () => {
  const r = new ToolRegistry();
  r.register(new Tool('a', 'A', {}, 'a()'));
  r.register(new Tool('b', 'B', {}, null));
  assert.strictEqual(r.getFormattedJsApiForPrompt(), '1. `a()` — A');
  assert.strictEqual(new ToolRegistry().getFormattedJsApiForPrompt(), '暂无可用工具');
});

test('ToolRegistry getPromptSections 排序与过滤', () => {
  const r = new ToolRegistry();
  class A extends Tool {
    constructor() { super('a', 'A', {}); }
    getPromptSection() { return { name: 'sec:a', order: 20, text: 'text A' }; }
  }
  class B extends Tool {
    constructor() { super('b', 'B', {}); }
    getPromptSection() { return { name: 'sec:b', order: 10, text: 'text B' }; }
  }
  class C extends Tool {
    constructor() { super('c', 'C', {}); }
    getPromptSection() { return null; }
  }
  r.register(new A());
  r.register(new B());
  r.register(new C());
  const sections = r.getPromptSections();
  assert.strictEqual(sections.length, 2);
  assert.strictEqual(sections[0].name, 'sec:b');
  assert.strictEqual(sections[1].name, 'sec:a');
  assert.strictEqual(sections[0].text, 'text B');
  assert.strictEqual(r.getFormattedPromptSections(), 'text B\n\ntext A');
  assert.strictEqual(new ToolRegistry().getFormattedPromptSections(), '');
});

test('ToolResult success/error/toString', () => {
  const s = ToolResult.success({ a: 1 });
  assert.strictEqual(s.success, true);
  assert.deepStrictEqual(s.data, { a: 1 });
  assert.strictEqual(s.error, null);
  assert.strictEqual(s.toString(), '✅ 成功: {"a":1}');
  const e = ToolResult.error('bad');
  assert.strictEqual(e.success, false);
  assert.strictEqual(e.error, 'bad');
  assert.strictEqual(e.toString(), '❌ 失败: bad');
});
