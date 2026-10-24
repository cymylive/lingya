/**
 * 计划监督回归测试
 *
 * 2026-10-24 用户反馈：「计划监督机制没有了，有计划未完成也不催了」。
 * 排查发现两个 bug 叠加：
 *
 *   bug 1（主因）：continueIfPlanUnfinished 里，lastPlanContinueAt 在判断
 *     「是否超过续跑上限」之前就被刷新了。AI 每回一条消息就刷新一次窗口，
 *     导致 3 分钟窗口永不过期 → 计数到 max 后永久卡死，再也不催。
 *
 *   bug 2：flushRemainingInitialChunks 在 initialPromptChunks 非数组时直接
 *     return，没清 awaitingNextInitialChunk。该标志为 true 时会屏蔽
 *     计划续跑 / 中断续跑 / 停滞监督三条路径 → Agent 静默死亡。
 *
 * 本测试锁住这两条，防止回归。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OBSERVER = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'intercept-observer.js');
const CHAT = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js');

test('计划续跑：时间戳必须在超限判断之后才更新', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  const start = src.indexOf('async function continueIfPlanUnfinished');
  assert.ok(start > 0, '找不到 continueIfPlanUnfinished');
  const body = src.slice(start, start + 3000);

  const limitCheckPos = body.indexOf('planContinueCount >= planContinueMax');
  assert.ok(limitCheckPos > 0, '找不到超限判断');

  // 在超限判断之前，不得出现 lastPlanContinueAt = now
  const before = body.slice(0, limitCheckPos);
  assert.ok(
    !/lastPlanContinueAt\s*=\s*now/.test(before),
    'lastPlanContinueAt 在超限判断之前被更新 —— 会导致窗口永不过期、永久停止催促'
  );

  // 超限判断之后必须更新
  const after = body.slice(limitCheckPos);
  assert.ok(
    /lastPlanContinueAt\s*=\s*now/.test(after),
    '超限判断之后必须更新 lastPlanContinueAt'
  );
});

test('计划续跑：达到上限时必须给出可解释日志（不是静默 return）', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  const start = src.indexOf('planContinueCount >= planContinueMax');
  const body = src.slice(start, start + 600);
  assert.ok(/console\.log/.test(body), '达到上限时应输出日志说明原因与恢复时机');
});

test('flushRemainingInitialChunks：chunks 非数组时也必须清挂起标志', () => {
  const src = fs.readFileSync(CHAT, 'utf-8');
  const start = src.indexOf('function flushRemainingInitialChunks');
  assert.ok(start > 0, '找不到 flushRemainingInitialChunks');
  const body = src.slice(start, start + 1500);

  const guardPos = body.indexOf('!Array.isArray(state.initialPromptChunks)');
  assert.ok(guardPos > 0, '找不到非数组守卫');

  // 守卫分支内必须清 awaitingNextInitialChunk
  const guardBlock = body.slice(guardPos, guardPos + 300);
  assert.ok(
    guardBlock.includes('awaitingNextInitialChunk = false'),
    'chunks 非数组时未清 awaitingNextInitialChunk —— 会永久屏蔽所有续跑路径'
  );
});

test('三条续跑路径都必须检查 awaitingNextInitialChunk', () => {
  const obs = fs.readFileSync(OBSERVER, 'utf-8');
  const sup = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'supervisor.js'), 'utf-8');
  assert.ok(obs.includes('if (state.awaitingNextInitialChunk) return false;'), 'intercept-observer 缺少分批挂起检查');
  assert.ok(sup.includes('if (state.awaitingNextInitialChunk) return;'), 'supervisor 缺少分批挂起检查');
});

test('配置默认值：planContinueMax 不应过于保守', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'security-store.js'), 'utf-8');
  const m = src.match(/planContinueMax:\s*(\d+)/);
  assert.ok(m, '找不到 planContinueMax 默认值');
  const v = Number(m[1]);
  assert.ok(v >= 5, 'planContinueMax 默认值 ' + v + ' 太小，容易让用户觉得"不催了"');
});
