'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// ===================== 修复 B：stopped 恢复机制 =====================
// 测试 state 契约：必须有 stoppedAt 字段（intercept-observer 依赖它判断自动恢复）
const stateSrc = fs.readFileSync(path.join(ROOT, 'src/preload/dom/state.js'), 'utf8');
const eventsSrc = fs.readFileSync(path.join(ROOT, 'src/preload/overlay/events.js'), 'utf8');
const observerSrc = fs.readFileSync(path.join(ROOT, 'src/preload/dom/intercept-observer.js'), 'utf8');

test('state 暴露 stoppedAt 字段（停止时刻）', () => {
  assert.match(stateSrc, /stoppedAt\s*:\s*0/, 'state.js 必须声明 stoppedAt: 0');
});

test('stopTask 记录 stoppedAt', () => {
  assert.match(
    eventsSrc,
    /state\.stoppedAt\s*=\s*Date\.now\(\)/,
    'stopTask 置 stopped=true 时必须同时记录 stoppedAt'
  );
});

test('clearStopped 复位 stoppedAt', () => {
  // clearStopped 函数体内应清掉 stoppedAt
  const i = eventsSrc.indexOf('async function clearStopped');
  assert.ok(i >= 0, 'events.js 必须有 clearStopped');
  const body = eventsSrc.slice(i, i + 400);
  assert.match(body, /state\.stoppedAt\s*=\s*0/, 'clearStopped 必须把 stoppedAt 归零');
});

test('processInterceptedResponse 有 stopped 兜底恢复路径', () => {
  // 断言存在「距停止超过阈值 + 收到非空回复 → 自动恢复」的逻辑
  assert.match(
    observerSrc,
    /sinceStop\s*>\s*30000/,
    '必须有 based-on-stoppedAt 的时间阈值兜底（防止 hook 失效时 stopped 永久卡死）'
  );
  assert.match(
    observerSrc,
    /state\.stoppedAt\s*=\s*0/,
    '恢复后必须复位 stoppedAt，避免下次误判'
  );
});

test('lingya-ai-start 恢复路径也复位 stoppedAt', () => {
  // 两处恢复（事件驱动 + 兜底）都要清 stoppedAt
  const occurrences = (observerSrc.match(/state\.stoppedAt\s*=\s*0/g) || []).length;
  assert.ok(occurrences >= 2, 'stoppedAt 复位应至少出现在 2 处恢复路径，实际 ' + occurrences);
});

// ===================== 修复 C：isCompletion 放宽 =====================
const providerSrc = fs.readFileSync(path.join(ROOT, 'src/providers/deepseek.js'), 'utf8');

test('isCompletion 不再使用严格等值匹配', () => {
  assert.ok(
    !/return\s+u\.pathname\s*===\s*COMPLETION_PATH\s*;/.test(providerSrc),
    'isCompletion 不应再依赖严格等值 —— DeepSeek 端点微调会导致事件永不派发（静默失效）'
  );
});

test('isCompletion 使用放宽的路径正则', () => {
  assert.match(
    providerSrc,
    /\/\^\\\/api\\\/v/,
    'isCompletion 应含放宽的 /api/v{N}/chat/ 正则'
  );
  assert.match(providerSrc, /completion\/i\.test\(pathname\)/, '应含 completion 大小写不敏感匹配');
});

test('isCompletion 仍要求 POST（不过度放宽）', () => {
  const i = providerSrc.indexOf('function isCompletion');
  assert.ok(i >= 0, '必须有 isCompletion');
  const body = providerSrc.slice(i, i + 900);
  assert.match(body, /toUpperCase\(\)\s*!==\s*'POST'/, '必须仍限定 POST');
});

test('hook 注入后派发自检事件', () => {
  assert.match(providerSrc, /lingya-hook-ready/, 'deepseek hook 应派发 lingya-hook-ready 自检事件');
});

test('preload 监听 hook 自检并给出超时警告', () => {
  assert.match(observerSrc, /lingya-hook-ready/, 'intercept-observer 应监听 hook 自检事件');
  assert.match(observerSrc, /__lingyaHookReadySeen__/, '应用标记记录自检是否到达');
  assert.match(
    observerSrc,
    /5 秒内未收到 hook 自检事件|未收到 hook 自检/,
    '自检未到达时必须打印明确警告（静默失败不可接受）'
  );
});
