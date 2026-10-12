/**
 * 限流防护测试（纯 Node，不依赖 electron / DOM）
 * 覆盖：关键词识别、冷却计算、最小间隔递增与上限、getWaitMs 取最大值
 */
const test = require('node:test');
const assert = require('node:assert');
const rl = require('../../src/preload/dom/rate-limiter.js');

test('looksLikeRateLimit 识别中英文限流提示', () => {
  rl.__reset();
  assert.strictEqual(rl.looksLikeRateLimit('消息发送过于频繁，请稍后重试'), true);
  assert.strictEqual(rl.looksLikeRateLimit('Too many requests'), true);
  assert.strictEqual(rl.looksLikeRateLimit('rate limit exceeded'), true);
});

test('looksLikeRateLimit 不误判正常内容', () => {
  rl.__reset();
  assert.strictEqual(rl.looksLikeRateLimit('你好，请帮我写代码'), false);
  assert.strictEqual(rl.looksLikeRateLimit(''), false);
  assert.strictEqual(rl.looksLikeRateLimit(null), false);
  // 超长文本（AI 回复正文）不参与检测
  assert.strictEqual(rl.looksLikeRateLimit('x'.repeat(200) + 'too many requests'), false);
});

test('triggerCooldown 进入冷却且 getWaitMs 为正', () => {
  rl.__reset();
  assert.strictEqual(rl.isCooling(), false);
  rl.triggerCooldown(60000, 'test');
  assert.strictEqual(rl.isCooling(), true);
  assert.ok(rl.getCooldownRemaining() > 0);
  assert.ok(rl.getWaitMs() > 0);
});

test('冷却时长取最大值（短冷却不缩短已有冷却）', () => {
  rl.__reset();
  rl.triggerCooldown(60000, 'long');
  const before = rl.getCooldownRemaining();
  rl.triggerCooldown(1000, 'short');
  assert.ok(rl.getCooldownRemaining() >= before - 200);
});

test('最小间隔每次命中递增，且不超上限', () => {
  rl.__reset();
  const a = rl.computeAfterRateLimit(Date.now(), 1).minInterval;
  rl.triggerCooldown(1, 'x');
  const b = rl.computeAfterRateLimit(Date.now(), 1).minInterval;
  assert.ok(b > a, '应递增: ' + a + ' -> ' + b);
  for (let i = 0; i < 30; i++) rl.triggerCooldown(1, 'y');
  const capped = rl.computeAfterRateLimit(Date.now(), 1).minInterval;
  assert.ok(capped <= 30000, '不应超上限: ' + capped);
  assert.strictEqual(capped, 30000);
});

test('markSent 后短时间内 getWaitMs 反映最小间隔', () => {
  rl.__reset();
  // triggerCooldown 会同时写入真实 cooldownUntil，故用真实时间基准测试间隔维度
  rl.triggerCooldown(1, 'x');           // 抬升 minInterval 到 3000
  const t0 = Date.now();
  rl.markSent(t0);
  assert.ok(rl.getWaitMs(t0) > 0, '刚发送后应需等待最小间隔');
  assert.strictEqual(rl.getWaitMs(t0 + 3000), 0, '间隔已满无需等待');
});

test('__reset 清空全部状态', () => {
  rl.triggerCooldown(60000, 'x');
  rl.__reset();
  assert.strictEqual(rl.isCooling(), false);
  assert.strictEqual(rl.getWaitMs(), 0);
  assert.strictEqual(rl.getCooldownRemaining(), 0);
});