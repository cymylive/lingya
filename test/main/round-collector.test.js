/**
 * 轮次收集器单测
 *
 * 覆盖：一轮完整生命周期、多轮切换、工具链摘要、异常兜底（tool-end 丢失）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const rc = require('../../src/main/round-collector');

function fresh() { rc.resetAll(); }

test('完整一轮：用户→AI→工具→AI→收尾', () => {
  fresh();
  rc.onUserMessage('p1', '帮我读文件');
  rc.onAiStart('p1');
  rc.onAiReply('p1', '我先看看', false);
  rc.onToolStart('p1', 'read');
  rc.onToolEnd('p1');
  rc.onAiReply('p1', '读完了，内容是 xxx', false);

  const round = rc.finish('p1');
  assert.strictEqual(round.userText, '帮我读文件');
  assert.deepStrictEqual(round.replies, ['我先看看', '读完了，内容是 xxx']);
  assert.strictEqual(round.tools.length, 1);
  assert.strictEqual(round.tools[0].name, 'read');
  assert.strictEqual(round.tools[0].done, true);
  assert.ok(round.durationMs >= 0);
});

test('多轮切换：新用户消息重置上一轮', () => {
  fresh();
  rc.onUserMessage('p1', '第一轮');
  rc.onAiReply('p1', '回复1', false);
  rc.onUserMessage('p1', '第二轮');
  rc.onAiReply('p1', '回复2', false);

  const round = rc.finish('p1');
  assert.strictEqual(round.userText, '第二轮');
  assert.deepStrictEqual(round.replies, ['回复2']);
});

test('ai-start 每轮只通知一次', () => {
  fresh();
  rc.onUserMessage('p1', 'q');
  assert.strictEqual(rc.onAiStart('p1').shouldNotify, true);
  assert.strictEqual(rc.onAiStart('p1').shouldNotify, false);
  assert.strictEqual(rc.onAiStart('p1').shouldNotify, false);
});

test('tool-end 丢失时，下一条 tool-start 兜底标记上一条完成', () => {
  fresh();
  rc.onToolStart('p1', 'bash');
  // 故意不发 tool-end
  rc.onToolStart('p1', 'read');
  const round = rc.finish('p1');
  assert.strictEqual(round.tools.length, 2);
  assert.strictEqual(round.tools[0].name, 'bash');
  assert.strictEqual(round.tools[0].done, true, '上一条应被兜底标记完成');
  assert.strictEqual(round.tools[1].name, 'read');
});

test('finish 时所有未完成工具标记为完成', () => {
  fresh();
  rc.onToolStart('p1', 'bash');
  // 不发 tool-end，直接 finish
  const round = rc.finish('p1');
  assert.strictEqual(round.tools[0].done, true);
});

test('finish 后状态清空，重复 finish 返回 null', () => {
  fresh();
  rc.onUserMessage('p1', 'q');
  rc.finish('p1');
  assert.strictEqual(rc.finish('p1'), null);
});

test('空 profileId 不崩（各函数都应能调用）', () => {
  fresh();
  rc.onUserMessage('', 'q');
  rc.onAiStart('');
  rc.onAiReply('', 'r', false);
  rc.onToolStart('', 'bash');
  rc.onToolEnd('');
  const round = rc.finish('');
  assert.strictEqual(round.userText, 'q');
});

test('peek 不改变状态', () => {
  fresh();
  rc.onUserMessage('p1', 'q');
  rc.onAiReply('p1', 'r', true);
  const p1 = rc.peek('p1');
  const p2 = rc.peek('p1');
  assert.deepStrictEqual(p1, p2);
  assert.strictEqual(p1.replies.length, 1);
  assert.strictEqual(p1.hasTool, true);
});

test('buildToolChainSummary：空数组返回空串', () => {
  assert.strictEqual(rc.buildToolChainSummary([]), '');
  assert.strictEqual(rc.buildToolChainSummary(null), '');
  assert.strictEqual(rc.buildToolChainSummary(undefined), '');
});

test('buildToolChainSummary：链式拼接', () => {
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }];
  assert.strictEqual(rc.buildToolChainSummary(tools), 'bash → read → write');
});

test('buildToolTimeline：带序号与相对时间', () => {
  const now = Date.now();
  const tools = [
    { name: 'bash', at: now, done: true },
    { name: 'read', at: now + 1200, done: true },
  ];
  const s = rc.buildToolTimeline(tools, now);
  assert.ok(s.includes('1.'));
  assert.ok(s.includes('bash'));
  assert.ok(s.includes('2.'));
  assert.ok(s.includes('read'));
  assert.ok(s.includes('+1.2s'), '相对时间应正确');
});


test('thinking 独立保存，与正文分开', () => {
  fresh();
  rc.onUserMessage('p1', 'q');
  rc.onAiReply('p1', '正文', false, '思考内容');
  const round = rc.finish('p1');
  assert.deepStrictEqual(round.replies, ['正文']);
  assert.deepStrictEqual(round.thinkings, ['思考内容']);
});

test('thinking 为空时不进数组', () => {
  fresh();
  rc.onAiReply('p1', '只有正文', false);
  rc.onAiReply('p1', '', false, '   ');
  const round = rc.finish('p1');
  assert.deepStrictEqual(round.replies, ['只有正文']);
  assert.deepStrictEqual(round.thinkings, []);
});

test('纯思考轮次（无正文）也能保存 thinking', () => {
  fresh();
  rc.onAiReply('p1', '', false, '只有思考没有正文');
  const round = rc.finish('p1');
  assert.deepStrictEqual(round.replies, []);
  assert.deepStrictEqual(round.thinkings, ['只有思考没有正文']);
});

test('多轮 thinking 按顺序累积', () => {
  fresh();
  rc.onAiReply('p1', 'r1', false, 't1');
  rc.onAiReply('p1', 'r2', false, 't2');
  const round = rc.finish('p1');
  assert.deepStrictEqual(round.thinkings, ['t1', 't2']);
});

test('多个 profile 互不干扰', () => {
  fresh();
  rc.onUserMessage('A', 'qA');
  rc.onUserMessage('B', 'qB');
  rc.onAiReply('A', 'rA', false);
  rc.onAiReply('B', 'rB', false);

  const a = rc.finish('A');
  const b = rc.finish('B');
  assert.strictEqual(a.userText, 'qA');
  assert.strictEqual(b.userText, 'qB');
  assert.deepStrictEqual(a.replies, ['rA']);
  assert.deepStrictEqual(b.replies, ['rB']);
});
