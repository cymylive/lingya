const { test } = require('node:test');
const assert = require('node:assert');

const phrases = require('../../src/preload/dom/reply-phrases');

// ===== pickEmptyOutput =====
test('pickEmptyOutput 返回非空字符串', () => {
  const s = phrases.pickEmptyOutput();
  assert.strictEqual(typeof s, 'string');
  assert.ok(s.length > 0);
});

test('pickEmptyOutput 池子至少 8 条', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(phrases.pickEmptyOutput());
  assert.ok(seen.size >= 8, '实际池子大小: ' + seen.size);
});

test('pickEmptyOutput 连续两次不返回同一条', () => {
  let prev = null;
  let sameCount = 0;
  for (let i = 0; i < 50; i++) {
    const cur = phrases.pickEmptyOutput();
    if (cur === prev) sameCount++;
    prev = cur;
  }
  assert.strictEqual(sameCount, 0, '连续重复次数应为 0，实际 ' + sameCount);
});

// ===== pickErrorRetry =====
test('pickErrorRetry 包含错误文本', () => {
  const s = phrases.pickErrorRetry('ENOENT: no such file');
  assert.ok(s.indexOf('ENOENT: no such file') >= 0, '应包含错误原文');
});

test('pickErrorRetry 池子至少 8 条', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(phrases.pickErrorRetry('E'));
  assert.ok(seen.size >= 8, '实际池子大小: ' + seen.size);
});

test('pickErrorRetry 连续两次不返回同一条', () => {
  let prev = null;
  let sameCount = 0;
  for (let i = 0; i < 50; i++) {
    const cur = phrases.pickErrorRetry('E');
    if (cur === prev) sameCount++;
    prev = cur;
  }
  assert.strictEqual(sameCount, 0);
});

test('pickErrorRetry 空错误文本时用占位符而非 undefined', () => {
  const s = phrases.pickErrorRetry('');
  assert.ok(s.indexOf('undefined') < 0, '不应出现 undefined');
  assert.ok(s.length > 0);
});

// ===== pickImageAttached =====
test('pickImageAttached 包含图片数量', () => {
  const s = phrases.pickImageAttached(3);
  assert.ok(s.indexOf('3') >= 0, '应包含数量 3');
});

test('pickImageAttached 池子至少 8 条', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(phrases.pickImageAttached(1));
  assert.ok(seen.size >= 8);
});

test('pickImageAttached 连续两次不返回同一条', () => {
  let prev = null;
  let sameCount = 0;
  for (let i = 0; i < 50; i++) {
    const cur = phrases.pickImageAttached(1);
    if (cur === prev) sameCount++;
    prev = cur;
  }
  assert.strictEqual(sameCount, 0);
});

// ===== pickQueueError =====
test('pickQueueError 包含错误详情', () => {
  const s = phrases.pickQueueError('TypeError: x is not a function');
  assert.ok(s.indexOf('TypeError: x is not a function') >= 0);
});

test('pickQueueError 保留「别重复做」意图', () => {
  // 所有变体都必须包含这层指令意图（允许措辞不同，但要有对应关键词）
  // 「别重来」「避免重复操作」等变体都算，关键词放宽
  const keywords = ['重复', '重做', '重来', '生效', '确认', '核实'];
  for (let i = 0; i < 100; i++) {
    const s = phrases.pickQueueError('E');
    const has = keywords.some(function(k){ return s.indexOf(k) >= 0; });
    assert.ok(has, '第 ' + i + ' 条缺少「别重复做」相关意图: ' + s);
  }
});

test('pickQueueError 保留「做完告诉我」意图', () => {
  const keywords = ['完成', '做完', '告诉我', '说一声'];
  for (let i = 0; i < 100; i++) {
    const s = phrases.pickQueueError('E');
    const has = keywords.some(function(k){ return s.indexOf(k) >= 0; });
    assert.ok(has, '第 ' + i + ' 条缺少「做完告诉我」意图: ' + s);
  }
});

test('pickQueueError 池子至少 8 条', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(phrases.pickQueueError('E'));
  assert.ok(seen.size >= 8, '实际池子大小: ' + seen.size);
});

test('pickQueueError 连续两次不返回同一条', () => {
  let prev = null;
  let sameCount = 0;
  for (let i = 0; i < 50; i++) {
    const cur = phrases.pickQueueError('E');
    if (cur === prev) sameCount++;
    prev = cur;
  }
  assert.strictEqual(sameCount, 0);
});

// ===== 跨函数独立性 =====
test('4 个池子互相独立，不会串味', () => {
  const a = new Set();
  const b = new Set();
  for (let i = 0; i < 100; i++) { a.add(phrases.pickEmptyOutput()); b.add(phrases.pickErrorRetry('E')); }
  // 两个池子的文案不应有交集（语义完全不同）
  let overlap = 0;
  a.forEach(function(x){ if (b.has(x)) overlap++; });
  assert.strictEqual(overlap, 0, '空输出池与错误池不应有交集');
});
