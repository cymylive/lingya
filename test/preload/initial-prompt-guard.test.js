'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { decideInitialPromptAccept, resetInitialPromptGuard, markBatchHandled } = require('../../src/preload/dom/initial-prompt-guard');

/**
 * initial-prompt 接收端守卫
 *
 * 【真实事故】同一批 systemPrompt 的 4 个分段被完整发送了两遍，中间夹着用户真实提问。
 * 根因：chat-input.js 的 initial-prompt 监听器每收到事件就无条件重置
 * initialPromptChunks / ChunkIndex / SentChunks，把幂等防护清空 →
 * 第二次事件到达时从第 1 段重头再发一遍。
 *
 * 这个模块把「要不要接受这批」的决策抽出来，便于测试。
 * 三层防护：
 *   1. batchId 去重 —— 同一批次只处理一次
 *   2. 进行中守卫 —— 上一批还没发完就拒绝新批次
 *   3. 空批次拒绝
 */

const EMPTY_STATE = {
  chunks: null,
  chunkIndex: 0,
  handledBatchIds: new Set(),
};

beforeEach(() => {
  resetInitialPromptGuard();
});

test('首次收到批次 → 接受', () => {
  const r = decideInitialPromptAccept({
    batchId: 'b1',
    chunkCount: 3,
    state: EMPTY_STATE,
  });
  assert.strictEqual(r.accept, true);
});

test('同一 batchId 重复到达 → 拒绝（去重）', () => {
  resetInitialPromptGuard();
  const state = { chunks: null, chunkIndex: 0 };
  const first = decideInitialPromptAccept({ batchId: 'b1', chunkCount: 3, state });
  assert.strictEqual(first.accept, true);
  markBatchHandled('b1');

  const second = decideInitialPromptAccept({ batchId: 'b1', chunkCount: 3, state });
  assert.strictEqual(second.accept, false);
  assert.match(second.reason, /批次|重复|已处理/);
});

test('上一批还没发完 → 拒绝新批次（进行中守卫）', () => {
  const state = {
    chunks: ['a', 'b', 'c'],
    chunkIndex: 0,          // 只发了第 1 段
  };
  const r = decideInitialPromptAccept({
    batchId: 'b2',
    chunkCount: 3,
    state,
  });
  assert.strictEqual(r.accept, false);
  assert.match(r.reason, /进行|未完成|发完/);
});

test('上一批已发完 → 接受新批次', () => {
  const state = {
    chunks: null,           // 发完后被置 null
    chunkIndex: 0,
  };
  const r = decideInitialPromptAccept({
    batchId: 'b2',
    chunkCount: 3,
    state,
  });
  assert.strictEqual(r.accept, true);
});

test('没有 batchId（旧版主进程）→ 按进行中守卫判断，不因缺 ID 就拒绝', () => {
  const state = { chunks: null, chunkIndex: 0 };
  const r = decideInitialPromptAccept({ batchId: null, chunkCount: 3, state });
  assert.strictEqual(r.accept, true, '缺 batchId 时退化为只做进行中检查，兼容旧版');
});

test('空批次 → 拒绝', () => {
  const r = decideInitialPromptAccept({ batchId: 'b1', chunkCount: 0, state: EMPTY_STATE });
  assert.strictEqual(r.accept, false);
});

test('chunkIndex 到达末段仍算进行中（还没被置 null）', () => {
  const state = {
    chunks: ['a', 'b', 'c'],
    chunkIndex: 2,          // 最后一段，但 chunks 未清空
  };
  const r = decideInitialPromptAccept({ batchId: 'b9', chunkCount: 3, state });
  assert.strictEqual(r.accept, true, 'chunkIndex 到末段时不应判定为进行中');
});

test('handledBatchIds 有上限，不会无限增长', () => {
  resetInitialPromptGuard();
  for (let i = 0; i < 200; i++) {
    markBatchHandled('b' + i);
  }
  // 早期批次应已被淘汰
  const early = decideInitialPromptAccept({
    batchId: 'b0',
    chunkCount: 2,
    state: { chunks: null, chunkIndex: 0 },
  });
  assert.strictEqual(early.accept, true, 'b0 应已被淘汰出记录，可以再次处理');
  // 最近批次仍在记录中
  const recent = decideInitialPromptAccept({
    batchId: 'b199',
    chunkCount: 2,
    state: { chunks: null, chunkIndex: 0 },
  });
  assert.strictEqual(recent.accept, false, 'b199 是最近的，应仍被去重拦住');
});
