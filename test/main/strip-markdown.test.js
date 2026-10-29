/**
 * Markdown 剥离回归测试（2026-10-30）
 *
 * 背景：QQ / 微信 / 飞书都不渲染 Markdown，AI 回复里的 **粗体**、`行内代码`、
 * ### 标题 会原样显示，读起来是乱码。推送前统一用 stripMarkdown 剥掉。
 *
 * 关键约束：代码块（三个反引号包围）内部内容一律不动。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { stripMarkdown } = require('../../src/main/channel-panel');

test('空值安全', () => {
  assert.strictEqual(stripMarkdown(''), '');
  assert.strictEqual(stripMarkdown(null), '');
  assert.strictEqual(stripMarkdown(undefined), '');
  assert.strictEqual(stripMarkdown(123), '');
});

test('剥粗体 **xxx**', () => {
  assert.strictEqual(stripMarkdown('这是**重点**内容'), '这是重点内容');
});

test('剥粗体 __xxx__', () => {
  assert.strictEqual(stripMarkdown('这是__重点__内容'), '这是重点内容');
});

test('剥斜体 *xxx*', () => {
  assert.strictEqual(stripMarkdown('这是*强调*内容'), '这是强调内容');
});

test('剥行内代码 `xxx`', () => {
  assert.strictEqual(stripMarkdown('运行 `npm test` 验证'), '运行 npm test 验证');
});

test('剥删除线 ~~xxx~~', () => {
  assert.strictEqual(stripMarkdown('这是~~删除~~内容'), '这是删除内容');
});

test('剥行首标题 ###', () => {
  const out = stripMarkdown('### 一级标题\n## 二级标题\n# 三级标题');
  assert.strictEqual(out, '一级标题\n二级标题\n三级标题');
});

test('行中的 # 不剥（只有行首才剥）', () => {
  assert.strictEqual(stripMarkdown('C# 是一门语言'), 'C# 是一门语言');
});

test('链接 [文字](url) → 文字', () => {
  assert.strictEqual(
    stripMarkdown('详见[官方文档](https://example.com)'),
    '详见官方文档'
  );
});

test('代码块内部内容完全不动', () => {
  const input = '看这段：\n```\nconst x = **1**;\n# 这是注释不是标题\n```\n结束';
  const out = stripMarkdown(input);
  assert.ok(out.indexOf('const x = **1**;') !== -1, '代码块内的 ** 应保留');
  assert.ok(out.indexOf('# 这是注释不是标题') !== -1, '代码块内的 # 应保留');
});

test('代码块外的符号照剥，块内不动（混合场景）', () => {
  const input = '**重点**：\n```\n**代码里的星号**\n```\n还有 *斜体*';
  const out = stripMarkdown(input);
  assert.ok(out.indexOf('重点：') !== -1, '块外粗体应剥');
  assert.ok(out.indexOf('**代码里的星号**') !== -1, '块内星号应保留');
  assert.ok(out.indexOf('还有 斜体') !== -1, '块外斜体应剥');
});

test('多个代码块互不串位', () => {
  const input = '```A``` 中间 **粗** ```B```';
  const out = stripMarkdown(input);
  assert.ok(out.indexOf('```A```') !== -1);
  assert.ok(out.indexOf('```B```') !== -1);
  assert.ok(out.indexOf('中间 粗') !== -1);
});

test('真实场景：整条推送消息剥离', () => {
  const body = [
    '🤖 AI：',
    '我**理解**你的需求：\n',
    '### 步骤',
    '1. 运行 `npm test`',
    '2. 查看[日志](http://example.com)',
  ].join('\n');
  const out = stripMarkdown(body);
  assert.ok(out.indexOf('**') === -1, '不应残留 **');
  assert.ok(out.indexOf('###') === -1, '不应残留 ###');
  assert.ok(out.indexOf('`') === -1, '不应残留反引号');
  assert.ok(out.indexOf('理解') !== -1);
  assert.ok(out.indexOf('日志') !== -1);
  assert.ok(out.indexOf('http://example.com') === -1, '链接 url 应被移除');
});
