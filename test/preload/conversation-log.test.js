/**
 * 对话记录 / Markdown 导出测试（纯 Node，不依赖 electron / DOM）
 */
const test = require('node:test');
const assert = require('node:assert');
const log = require('../../src/preload/dom/conversation-log.js');

test('stripToolBlocks 移除 lingya/js 代码块', () => {
  const BT = String.fromCharCode(96).repeat(3);
  const text = '好的，我来执行。' + String.fromCharCode(10) + BT + 'lingya' + String.fromCharCode(10) + 'read("a")' + String.fromCharCode(10) + BT;
  const out = log.stripToolBlocks(text);
  assert.ok(out.indexOf('好的，我来执行。') === 0);
  assert.ok(out.indexOf('lingya') === -1);
  assert.ok(out.indexOf('read(') === -1);
});

test('stripToolBlocks 无代码块时原样返回', () => {
  assert.strictEqual(log.stripToolBlocks('纯文本回复'), '纯文本回复');
  assert.strictEqual(log.stripToolBlocks(''), '');
  assert.strictEqual(log.stripToolBlocks(null), '');
});

test('shouldSkipTag 过滤系统消息', () => {
  assert.strictEqual(log.shouldSkipTag('自动续写'), true);
  assert.strictEqual(log.shouldSkipTag('监督续跑'), true);
  assert.strictEqual(log.shouldSkipTag('压缩-摘要'), true);
  assert.strictEqual(log.shouldSkipTag('工具=bash'), true);
  assert.strictEqual(log.shouldSkipTag('JS汇总'), true);
  assert.strictEqual(log.shouldSkipTag(''), false);
  assert.strictEqual(log.shouldSkipTag(undefined), false);
  assert.strictEqual(log.shouldSkipTag('手动输入'), false);
});

test('formatTime 输出可读时间', () => {
  const s = log.formatTime(new Date('2026-10-12T14:30:05').getTime());
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s), s);
  assert.ok(s.indexOf('2026-10-12') === 0);
});

test('addEntry 累积并按角色记录', () => {
  log.clearEntries();
  log.addEntry('user', '你好');
  log.addEntry('assistant', '你好，有什么可以帮你');
  assert.strictEqual(log.getCount(), 2);
  const e = log.getEntries();
  assert.strictEqual(e[0].role, 'user');
  assert.strictEqual(e[0].text, '你好');
  assert.strictEqual(e[1].role, 'assistant');
});

test('addEntry 去重连续相同内容', () => {
  log.clearEntries();
  log.addEntry('assistant', '同一句');
  log.addEntry('assistant', '同一句');
  assert.strictEqual(log.getCount(), 1);
  log.addEntry('assistant', '换一句');
  assert.strictEqual(log.getCount(), 2);
});

test('addEntry 忽略空内容', () => {
  log.clearEntries();
  log.addEntry('user', '');
  log.addEntry('user', '   ');
  log.addEntry('user', null);
  assert.strictEqual(log.getCount(), 0);
});

test('addEntry 超上限时丢弃最旧记录', () => {
  log.clearEntries();
  for (let i = 0; i < log.MAX_ENTRIES + 50; i++) log.addEntry('user', 'msg-' + i);
  assert.strictEqual(log.getCount(), log.MAX_ENTRIES);
  const e = log.getEntries();
  assert.ok(e[0].text !== 'msg-0', '最旧的应被丢弃');
  assert.strictEqual(e[e.length - 1].text, 'msg-' + (log.MAX_ENTRIES + 49));
});

test('buildMarkdown 生成含元信息的 Markdown', () => {
  const entries = [
    { role: 'user', text: '帮我看看代码', ts: new Date('2026-10-12T10:00:00').getTime() },
    { role: 'assistant', text: '好的，我来分析', ts: new Date('2026-10-12T10:00:05').getTime() },
  ];
  const md = log.buildMarkdown(entries, {
    sessionUrl: 'https://chat.deepseek.com/a/chat/s/abc',
    sessionId: 'abc',
    projectDir: 'C:/proj',
    platform: 'DeepSeek',
    now: new Date('2026-10-12T12:00:00').getTime(),
  });
  assert.ok(md.indexOf('# 会话导出') === 0);
  assert.ok(md.indexOf('DeepSeek') !== -1);
  assert.ok(md.indexOf('C:/proj') !== -1);
  assert.ok(md.indexOf('abc') !== -1);
  assert.ok(md.indexOf('## 用户') !== -1);
  assert.ok(md.indexOf('## AI') !== -1);
  assert.ok(md.indexOf('帮我看看代码') !== -1);
  assert.ok(md.indexOf('好的，我来分析') !== -1);
  assert.ok(md.indexOf('- 消息数：2') !== -1);
});

test('buildMarkdown 空记录时给出提示', () => {
  const md = log.buildMarkdown([], {});
  assert.ok(md.indexOf('尚无对话记录') !== -1);
});

test('buildMarkdown 默认剥离工具代码块', () => {
  const BT = String.fromCharCode(96).repeat(3);
  const entries = [{ role: 'assistant', text: '结果：' + BT + 'lingya' + String.fromCharCode(10) + 'x' + String.fromCharCode(10) + BT, ts: 0 }];
  const md = log.buildMarkdown(entries, {});
  assert.ok(md.indexOf('结果：') !== -1);
  assert.ok(md.indexOf('lingya') === -1, '工具块应被剥离');
  const md2 = log.buildMarkdown(entries, {}, { includeToolBlocks: true });
  assert.ok(md2.indexOf('lingya') !== -1, '开启后应保留');
});

test('clearEntries 清空', () => {
  log.addEntry('user', 'x');
  assert.ok(log.getCount() > 0);
  log.clearEntries();
  assert.strictEqual(log.getCount(), 0);
});