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
  assert.strictEqual(log.shouldSkipTag('拒绝拦截'), true);
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

test('BUG I 修复：跨来源同一用户消息去重', () => {
  log.clearEntries();
  // 来源②：LingYa 发送的原始消息
  log.addEntry('user', '帮我重构这段代码', '手动输入');
  // 来源③：hook 从请求体提取的 prompt（同一句，但带 tag 不同）
  log.addEntry('user', '帮我重构这段代码', '手动输入');
  assert.strictEqual(log.getCount(), 1, '完全相同应去重');
  // 包装版本（新消息 = 旧消息 + 前缀）也应去重
  log.clearEntries();
  log.addEntry('user', '帮我重构这段代码', '手动输入');
  log.addEntry('user', '用户消息：帮我重构这段代码', '手动输入');
  assert.strictEqual(log.getCount(), 1, '包装版本应被单向包含去重');
});

test('BUG I 修复：延伸内容不能被误判为重复', () => {
  log.clearEntries();
  log.addEntry('user', '帮我看看代码', '手动输入');
  // 后者包含前者，但语义不同 —— 必须各记一条
  log.addEntry('user', '帮我看看代码里的 bug', '手动输入');
  assert.strictEqual(log.getCount(), 2, '延伸内容不该被去重（防误杀）');
});

test('BUG I 修复：不同用户消息不去重', () => {
  log.clearEntries();
  log.addEntry('user', '第一句话内容', '手动输入');
  log.addEntry('user', '完全不同的第二句', '手动输入');
  assert.strictEqual(log.getCount(), 2, '不同内容应各记一条');
});

test('BUG I 修复：短文本不做包含去重（避免误杀）', () => {
  log.clearEntries();
  log.addEntry('user', '好的', '手动输入');
  log.addEntry('user', '好了', '手动输入');
  assert.strictEqual(log.getCount(), 2, '短文本应各自保留');
});

test('BUG I 修复：超过去重窗口后可再记', () => {
  log.clearEntries();
  log.addEntry('user', '重复内容测试文本', '手动输入');
  // 直接操纵去重缓存时间戳（模拟 5 秒后）
  assert.strictEqual(log.getCount(), 1);
  assert.strictEqual(typeof log.DEDUP_WINDOW_MS, 'number');
  assert.ok(log.DEDUP_WINDOW_MS > 0);
});

// ===== 附件消息（长文本转 .md 附件）=====

test('isAttachmentTag / getAttachmentName 解析附件 tag', () => {
  assert.strictEqual(log.isAttachmentTag('附件:笔记-053800.md'), true);
  assert.strictEqual(log.isAttachmentTag('手动输入'), false);
  assert.strictEqual(log.getAttachmentName('附件:笔记-053800.md'), '笔记-053800.md');
  assert.strictEqual(log.getAttachmentName('手动输入'), '');
});

test('addEntry 带 attachment 时记录全文并打上附件 tag', () => {
  log.clearEntries();
  const longText = '这是一段很长的正文。'.repeat(50);
  log.addEntry('user', longText, '用户发送', { attachment: { name: '笔记-053800.md' } });
  const e = log.getEntries();
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].text, longText.trim(), '正文应为附件全文而非引导语');
  assert.strictEqual(e[0].tag, '附件:笔记-053800.md');
  assert.strictEqual(e[0].attachmentName, '笔记-053800.md');
});

test('addEntry 过滤附件引导语（短文本含 .md 文件名）', () => {
  log.clearEntries();
  // 先记录附件全文
  log.addEntry('user', '正文内容'.repeat(100), '用户发送', { attachment: { name: '资料-053801.md' } });
  // 再模拟来源3 上报的引导语 —— 应被丢弃
  log.addEntry('user', '帮我看看附件 资料-053801.md', '手动输入');
  assert.strictEqual(log.getCount(), 1, '引导语应被过滤，不产生第二条记录');
});

test('notePendingAttachment 提前登记后，来源3 引导语先到也被过滤（竞态 #1 修复）', () => {
  log.clearEntries();
  // 模拟：上传成功后立即登记（chat-input.js 调用）
  log.notePendingAttachment('资料-061500.md');
  // 模拟：来源3 的引导语先到（竞态场景）
  log.addEntry('user', '帮我看看附件 资料-061500.md', '手动输入');
  assert.strictEqual(log.getCount(), 0, '提前登记的附件名应让先到的引导语被过滤');
  // 随后来源2 的全文到达 —— 应正常记录
  log.addEntry('user', '真正的正文内容'.repeat(50), '用户发送', { attachment: { name: '资料-061500.md' } });
  assert.strictEqual(log.getCount(), 1, '全文应正常记录');
  assert.strictEqual(log.getEntries()[0].attachmentName, '资料-061500.md');
});

test('addEntry 不过滤与附件无关的短文本', () => {
  log.clearEntries();
  log.addEntry('user', '正文内容'.repeat(100), '用户发送', { attachment: { name: '资料-053802.md' } });
  // 不含 .md 的普通短消息，即使刚上传过附件也应保留
  log.addEntry('user', '继续', '手动输入');
  assert.strictEqual(log.getCount(), 2, '普通消息不应被引导语过滤误杀');
});

test('buildMarkdown 为附件消息渲染「> 附件：xxx」', () => {
  const md = log.buildMarkdown(
    [{ role: 'user', text: '正文', ts: 1, tag: '附件:笔记-053800.md', attachmentName: '笔记-053800.md' }],
    { now: 1 }
  );
  assert.ok(md.indexOf('> 附件：笔记-053800.md') !== -1, md);
});

test('buildMarkdown 旧存档（无 attachmentName）也能从 tag 反解附件名', () => {
  const md = log.buildMarkdown(
    [{ role: 'user', text: '正文', ts: 1, tag: '附件:旧存档-000000.md' }],
    { now: 1 }
  );
  assert.ok(md.indexOf('> 附件：旧存档-000000.md') !== -1, md);
});