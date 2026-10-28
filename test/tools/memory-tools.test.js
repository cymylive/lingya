'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { registry } = require('../../tools');
const { MemoryRecallTool, MemoryListTool } = require('../../tools/MemoryTool');

/**
 * 回归测试：memory_list 必须注册进 registry
 *
 * 背景：tools/index.js 曾 require 并导出了 MemoryListTool，但漏了 registry.register()。
 * 后果：memory-store.js 的注入文案让 AI「先调用 memoryList()」，实际调用报
 *       「未知工具: memory_list」，记忆检索链路断裂。
 */
test('memory_list 已注册进 registry', () => {
  const tool = registry.get('memory_list');
  assert.ok(tool, 'memory_list 必须存在于 registry（漏注册会让 AI 调用时报未知工具）');
  assert.strictEqual(tool.name, 'memory_list');
});

test('七个记忆工具全部注册', () => {
  const expected = [
    'memory_save', 'memory_update', 'memory_delete',
    'memory_list', 'memory_recall', 'memory_get', 'memory_get_full',
  ];
  const names = new Set(registry.listNames());
  for (const n of expected) {
    assert.ok(names.has(n), '缺少工具: ' + n);
  }
});

test('memory_list 继承 MemoryRecallTool 的检索能力', () => {
  const tool = registry.get('memory_list');
  assert.ok(tool instanceof MemoryRecallTool, 'memory_list 应复用 memory_recall 的实现');
  assert.strictEqual(tool.signature, 'memoryList({ query })');
});

/**
 * 回归测试：提示词 section 不能重复
 *
 * ToolRegistry.getPromptSections 只 push 不按 name 去重。
 * MemoryListTool 继承 MemoryRecallTool 的 getPromptSection 时，
 * 会向 systemPrompt 注入第二份 tool:memory_recall，导致提示词重复且指令矛盾。
 */
test('memory_list 的 getPromptSection 必须返回 null', () => {
  const tool = registry.get('memory_list');
  assert.strictEqual(tool.getPromptSection(), null,
    'memory_list 不应贡献 section，否则与 memory_recall 重复注入');
});

test('registry 中 tool:memory_recall section 只出现一次', () => {
  const sections = registry.getPromptSections();
  const recallSections = sections.filter((s) => s.name === 'tool:memory_recall');
  assert.strictEqual(recallSections.length, 1,
    'tool:memory_recall section 应恰好 1 份，实际 ' + recallSections.length + ' 份');
});

test('memory_list 空 query 返回错误（继承校验行为）', async () => {
  const tool = registry.get('memory_list');
  const r = await tool.execute({ query: '' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /query 不能为空/);
});
