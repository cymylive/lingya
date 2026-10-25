'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('NameConversationTool 拒绝把对象当标题存入（避免 [object Object]）', async () => {
  const { NameConversationTool } = require('../../tools/NameConversationTool');
  const tool = new NameConversationTool();
  const r = await tool.execute({ title: { foo: 'bar', baz: 1 } });
  assert.strictEqual(r.success, false);
  assert.ok(String(r.error).includes('标题'), '错误信息应提示标题参数问题: ' + r.error);
});

test('NameConversationTool 从对象的 name/text/value 键兜底取标题', async () => {
  const { NameConversationTool } = require('../../tools/NameConversationTool');
  const tool = new NameConversationTool();
  // 没有 sessionStore 时会报「会话存储未就绪」，但说明标题已被正确解析（没走 '标题为空' 分支）
  const r1 = await tool.execute({ title: { name: '按name取' } });
  assert.ok(!String(r1.error || '').includes('标题为空'), '应能从 name 键取到标题');
  const r2 = await tool.execute({ title: { text: '按text取' } });
  assert.ok(!String(r2.error || '').includes('标题为空'), '应能从 text 键取到标题');
  const r3 = await tool.execute({ title: { value: '按value取' } });
  assert.ok(!String(r3.error || '').includes('标题为空'), '应能从 value 键取到标题');
});

test('NameConversationTool 空标题仍报错', async () => {
  const { NameConversationTool } = require('../../tools/NameConversationTool');
  const tool = new NameConversationTool();
  const r = await tool.execute({ title: '   ' });
  assert.strictEqual(r.success, false);
  assert.ok(String(r.error).includes('标题为空'));
});
