/**
 * WaitForTool 回归测试
 *
 * 背景（2026-10-24 用户反馈）：
 * AI 等待外部状态变化（CI 构建完成）时惯用 ping -n 300 这种固定时长死等，
 * 导致 CI 1 分钟跑完还要白等 4 分钟，界面卡在「正在执行 JS 脚本… 4m44s」看起来像死机。
 *
 * 本工具把「轮询 + 超时」封装成原子操作。核心价值是【提前退出】：
 *   条件一满足立刻返回，不等满 timeout。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { WaitForTool } = require('../../tools/WaitForTool');

const NODE = process.execPath;

function makeTool() {
  return new WaitForTool();
}

test('工具名与接口定义正确', () => {
  const t = makeTool();
  assert.strictEqual(t.name, 'wait_for');
  assert.ok(t.jsApi.includes('waitFor'));
  assert.deepStrictEqual(t.parameters.required, ['command', 'expect']);
});

test('参数校验：command / expect 为空时返回错误', async () => {
  const t = makeTool();
  const r1 = await t.execute({ command: '', expect: 'x' });
  assert.strictEqual(r1.success, false);
  const r2 = await t.execute({ command: 'echo x', expect: '' });
  assert.strictEqual(r2.success, false);
});

test('危险命令被拦截', async () => {
  const t = makeTool();
  const r = await t.execute({ command: 'format c:', expect: 'x' });
  assert.strictEqual(r.success, false);
  assert.ok(String(r.error).includes('安全策略'));
});

test('【核心】条件立即满足时提前退出，不等满 timeout', async () => {
  const t = makeTool();
  const start = Date.now();
  // echo 立刻输出 hello，expect=hello 第一次就该命中
  const r = await t.execute({
    command: 'echo hello',
    expect: 'hello',
    timeout: 60000,       // 60 秒超时
    interval: 10000,      // 10 秒间隔
  });
  const elapsed = Date.now() - start;

  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.matched, true, '应判定为已达成条件');
  assert.strictEqual(r.data.attempts, 1, '第一次轮询就该命中');
  assert.ok(elapsed < 5000,
    '必须提前退出：实际耗时 ' + elapsed + 'ms，说明没有死等 60 秒');
});

test('条件永不满足时按 timeout 超时返回 matched=false', async () => {
  const t = makeTool();
  const start = Date.now();
  const r = await t.execute({
    command: 'echo nope',
    expect: 'this-string-will-never-appear',
    timeout: 3000,
    interval: 1000,
  });
  const elapsed = Date.now() - start;

  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.matched, false, '应判定为超时未达成');
  assert.ok(r.data.attempts >= 2, '至少轮询 2 次，实际 ' + r.data.attempts);
  assert.ok(elapsed >= 2500 && elapsed < 8000,
    '应接近 timeout=3000ms，实际 ' + elapsed + 'ms');
  assert.ok(String(r.data.note).includes('超时'));
});

test('expect=exit0 时按退出码判定', async () => {
  const t = makeTool();
  // 退出码 0 → 命中
  const r1 = await t.execute({ command: 'echo ok', expect: 'exit0', timeout: 3000, interval: 1000 });
  assert.strictEqual(r1.data.matched, true, '退出码 0 应命中');

  // 退出码 1 → 不命中，等超时
  const r2 = await t.execute({
    command: NODE + ' -e "process.exit(1)"',
    expect: 'exit0',
    timeout: 2000,
    interval: 1000,
  });
  assert.strictEqual(r2.data.matched, false, '退出码 1 不应命中');
});

test('expect 匹配不区分大小写', async () => {
  const t = makeTool();
  const r = await t.execute({
    command: 'echo COMPLETED',
    expect: 'completed',
    timeout: 3000,
    interval: 1000,
  });
  assert.strictEqual(r.data.matched, true);
});

test('interval 有下限（不会疯转）', async () => {
  const t = makeTool();
  const r = await t.execute({
    command: 'echo nope',
    expect: 'never',
    timeout: 2500,
    interval: 10,          // 传 10ms，应被抬到 1000ms
  });
  // 2.5 秒 / 1 秒间隔 ≈ 2-3 次，不可能是几百次
  assert.ok(r.data.attempts <= 5,
    '轮询次数应受 interval 下限约束，实际 ' + r.data.attempts + ' 次');
});

test('timeout 有上限（防误填天文数字）', async () => {
  const { MAX_TIMEOUT_MS } = require('../../tools/WaitForTool');
  assert.strictEqual(MAX_TIMEOUT_MS, 1800000, '上限应为 30 分钟');
});

test('提示词 section 必须包含「禁止固定时长死等」规则', () => {
  const t = makeTool();
  const sec = t.getPromptSection();
  assert.ok(sec, '必须有 prompt section');
  assert.ok(sec.text.includes('禁止用固定时长死等'), '必须明确禁止死等');
  assert.ok(sec.text.includes('ping -n'), '必须点名 ping -n 这种常见错误写法');
  assert.ok(sec.text.includes('waitFor'), '必须给出正确做法');
});

test('提示词 section 的 order 在 bash（105）之后', () => {
  const t = makeTool();
  const sec = t.getPromptSection();
  assert.ok(sec.order > 105, 'order 应排在 bash 之后，实际 ' + sec.order);
});
