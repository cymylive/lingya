'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decide } = require('../../src/preload/dom/nudge-policy');

/** 构造一个「所有闸门都放行」的基线上下文 */
function base(overrides) {
  return Object.assign({
    stopped: false,
    awaitingNextInitialChunk: false,
    sessionId: 'sess-1',
    activatedSessions: new Set(['sess-1']),
    awaitingUserInput: false,
    taskDeclaredDone: false,
    xmlDetected: false,
    enabled: true,
    count: 0,
    max: 5,
    bypassGates: false,
  }, overrides || {});
}

test('全部闸门放行 → action=nudge', () => {
  const r = decide(base());
  assert.strictEqual(r.action, 'nudge');
});

// ===== 闸门 1: stopped =====
test('用户点了停止 → skip', () => {
  const r = decide(base({ stopped: true }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /停止/);
});

// ===== 闸门 2: awaitingNextInitialChunk =====
test('正在分批发送初始提示 → skip', () => {
  const r = decide(base({ awaitingNextInitialChunk: true }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /初始提示/);
});

// ===== 闸门 3: 会话未激活 =====
test('会话未激活 → skip', () => {
  const r = decide(base({ sessionId: 'sess-x' }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /未激活/);
});

test('sessionId 为空 → skip', () => {
  const r = decide(base({ sessionId: null }));
  assert.strictEqual(r.action, 'skip');
});

test('bypassGates=true 时跳过激活检查（中断兜底专用）', () => {
  const r = decide(base({ sessionId: null, bypassGates: true }));
  assert.strictEqual(r.action, 'nudge');
});

// ===== 闸门 4: 等用户（弱等待也永久不催，用户选 2B）=====
test('AI 在等用户（弱等待）→ skip，不再有 3 分钟超时', () => {
  const r = decide(base({ awaitingUserInput: true }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /等用户|提问/);
});

test('AI 在等用户（强等待）→ 同样 skip', () => {
  const r = decide(base({ awaitingUserInput: true, awaitingUserInputStrong: true }));
  assert.strictEqual(r.action, 'skip');
});

// ===== 闸门 5: 格式错误 → correct，不是 skip =====
test('本轮是 XML/DSML 格式错误 → action=correct', () => {
  const r = decide(base({ xmlDetected: true }));
  assert.strictEqual(r.action, 'correct');
  assert.match(r.reason, /格式/);
});

test('格式错误优先级高于催促（即使其他闸门都放行）', () => {
  const r = decide(base({ xmlDetected: true, count: 0, max: 5 }));
  assert.strictEqual(r.action, 'correct');
});

// ===== 闸门 6: AI 已声明完成 =====
test('AI 已声明任务完成 → skip', () => {
  const r = decide(base({ taskDeclaredDone: true }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /完成/);
});

// ===== 闸门 7: 配置关闭 =====
test('监督开关已关闭 → skip', () => {
  const r = decide(base({ enabled: false }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /关闭|禁用/);
});

// ===== 闸门 8: 超上限 =====
test('已催次数达到上限 → skip（降频由调用方处理）', () => {
  const r = decide(base({ count: 5, max: 5 }));
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /上限/);
});

test('count < max 时正常放行', () => {
  const r = decide(base({ count: 4, max: 5 }));
  assert.strictEqual(r.action, 'nudge');
});

// ===== 优先级顺序验证 =====
test('stopped 优先级最高（即使同时 xmlDetected）', () => {
  const r = decide(base({ stopped: true, xmlDetected: true }));
  assert.strictEqual(r.action, 'skip');
});

test('awaitingUserInput 优先于 xmlDetected（AI 在等回答时不该纠错）', () => {
  const r = decide(base({ awaitingUserInput: true, xmlDetected: true }));
  assert.strictEqual(r.action, 'skip');
});

test('xmlDetected 优先于 taskDeclaredDone（格式错了还是要纠）', () => {
  const r = decide(base({ xmlDetected: true, taskDeclaredDone: true }));
  assert.strictEqual(r.action, 'correct');
});

// ===== 边界 =====
test('max 为 0 或负数时视为无上限', () => {
  const r = decide(base({ count: 100, max: 0 }));
  assert.strictEqual(r.action, 'nudge');
});

test('decide 不修改传入的 activatedSessions', () => {
  const s = new Set(['sess-1']);
  decide(base({ activatedSessions: s }));
  assert.strictEqual(s.size, 1);
});
