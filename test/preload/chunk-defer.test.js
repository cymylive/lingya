/**
 * 分批发送暂缓兜底回归测试
 *
 * 背景（P0）：awaitingNextInitialChunk 置位后只依赖 lingya-ai-response 复位。
 * 若 AI 每轮回复都含工具调用，会一直走「暂缓」分支 → 标志永久为 true →
 * 同时屏蔽计划续跑/中断续跑/停滞监督三条路径 → 整条 Agent 循环静默死亡。
 *
 * 修复：暂缓计数 + 时长双阈值，任一超限就强制合并剩余段发出。
 * 本测试锁住三条不变式：
 *   1. 暂缓有次数上限
 *   2. 暂缓有超时上限
 *   3. flush 一定清干净所有分批状态（不能只发消息不清标志）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OBSERVER = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'intercept-observer.js');
const CHAT_INPUT = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js');
const STATE = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'state.js');

test('必须定义暂缓次数上限常量', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  assert.ok(/INITIAL_CHUNK_DEFER_MAX\s*=\s*\d+/.test(src), '缺少 INITIAL_CHUNK_DEFER_MAX 常量');
});

test('必须定义暂缓超时上限常量', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  assert.ok(/INITIAL_CHUNK_DEFER_TIMEOUT_MS\s*=\s*\d+/.test(src), '缺少 INITIAL_CHUNK_DEFER_TIMEOUT_MS 常量');
});

test('暂缓分支必须累计计数并在超限时强制放行', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  const idx = src.indexOf('INITIAL_CHUNK_DEFER_MAX');
  assert.ok(idx > 0);
  // 暂缓分支附近必须有 flushRemainingInitialChunks 调用
  assert.ok(src.includes('flushRemainingInitialChunks'), '缺少强制放行调用');
  // 且必须检查 overLimit
  assert.ok(/overLimit/.test(src), '缺少超限判断');
});

test('state 必须定义暂缓计数字段', () => {
  const src = fs.readFileSync(STATE, 'utf-8');
  assert.ok(/initialChunkDeferCount\s*:/.test(src), '缺少 initialChunkDeferCount');
  assert.ok(/initialChunkDeferAt\s*:/.test(src), '缺少 initialChunkDeferAt');
});

test('flush 必须清干净所有分批状态（不能只发消息不清标志）', () => {
  const src = fs.readFileSync(CHAT_INPUT, 'utf-8');
  const start = src.indexOf('function flushRemainingInitialChunks');
  assert.ok(start > 0, '缺少 flushRemainingInitialChunks 函数');
  const body = src.slice(start, start + 1800);
  // 三个关键状态都要在函数里被清掉
  assert.ok(body.includes('awaitingNextInitialChunk = false'), 'flush 未清 awaitingNextInitialChunk');
  assert.ok(body.includes('initialPromptChunks = null'), 'flush 未清 initialPromptChunks');
  assert.ok(body.includes('initialChunkDeferCount = 0'), 'flush 未清暂缓计数');
});

test('flush 必须在发送前先清标志（发送失败也不能继续屏蔽续跑）', () => {
  const src = fs.readFileSync(CHAT_INPUT, 'utf-8');
  const start = src.indexOf('function flushRemainingInitialChunks');
  const body = src.slice(start, start + 1800);
  const clearPos = body.indexOf('awaitingNextInitialChunk = false');
  const sendPos = body.indexOf('return sendInitialPromptToInput');
  assert.ok(clearPos > 0 && sendPos > 0);
  assert.ok(clearPos < sendPos, '必须先清标志再发送，否则发送失败时会永久屏蔽续跑');
});

test('sendInitialPromptToInput 必须用快照而非实时读 state（防切会话空指针）', () => {
  const src = fs.readFileSync(CHAT_INPUT, 'utf-8');
  const start = src.indexOf('async function sendInitialPromptToInput');
  const body = src.slice(start, start + 2600);
  assert.ok(/chunksSnapshot/.test(body), '缺少快照变量，setTimeout 回调里读 state 有空指针风险');
});

test('初始化发送延迟必须随机抖动（固定节拍是 bot 指纹）', () => {
  const src = fs.readFileSync(CHAT_INPUT, 'utf-8');
  const start = src.indexOf('async function sendInitialPromptToInput');
  const body = src.slice(start, start + 2600);
  assert.ok(/Math\.random\(\)/.test(body), '初始延迟缺少随机抖动');
});
