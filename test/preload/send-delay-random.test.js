'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 快请求发送延迟随机化测试。
 *
 * 需求：把「快请求固定延迟」从单一值改为 [min, max] 闭区间随机。
 * 约束：
 *   - 只影响快请求分支，慢请求自适应与调用方 fixedDelay 不变
 *   - min === max 时退化为固定值（与旧行为一致）
 *   - min > max 时运行时自动交换（UI 已校验，此处兜底）
 *   - 旧 localStorage 键 lingya-global-send-delay 迁移为 min=max
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js'),
  'utf8'
);
const STATE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'state.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC_CODE = stripComments(SRC);

// 2026-10-24 DeepSeek 封号根因 ③-B3：默认从 3000/3000 改为 2500/9000。
// 原断言锁定的是「与旧行为一致」的兼容默认，但该默认本身就是缺陷：
// min === max 会让 pickGlobalDelay 短路成恒定节拍（每轮精确 3.000s），
// 那是最强的 bot 指纹。故按已批准的修复更新，并加下方反向锁死防退化。
test('state 必须有 globalSendDelayMin / globalSendDelayMax，默认 2500 / 9000', () => {
  assert.match(STATE, /globalSendDelayMin:\s*2500/, '必须定义 globalSendDelayMin 默认 2500');
  assert.match(STATE, /globalSendDelayMax:\s*9000/, '必须定义 globalSendDelayMax 默认 9000');
});

test('默认区间必须 min < max（禁止退化回恒定节拍）', () => {
  const mn = Number(/globalSendDelayMin:\s*(\d+)/.exec(STATE)[1]);
  const mx = Number(/globalSendDelayMax:\s*(\d+)/.exec(STATE)[1]);
  assert.ok(mn < mx, '默认必须是随机区间，当前 min=' + mn + ' max=' + mx);
});

test('chat-input.js 必须定义 pickGlobalDelay 函数', () => {
  assert.match(SRC_CODE, /function pickGlobalDelay\s*\(/, '必须有 pickGlobalDelay');
});

test('pickGlobalDelay 必须是闭区间均匀随机', () => {
  const i = SRC_CODE.indexOf('function pickGlobalDelay');
  assert.ok(i >= 0, '必须有 pickGlobalDelay');
  const body = SRC_CODE.slice(i, i + 800);
  assert.match(body, /Math\.random\(\)/, '必须用 Math.random()');
  assert.match(body, /\+\s*1/, '区间跨度必须 +1（闭区间，两端可取）');
});

test('pickGlobalDelay 必须在 min > max 时自动交换', () => {
  const i = SRC_CODE.indexOf('function pickGlobalDelay');
  const body = SRC_CODE.slice(i, i + 800);
  assert.match(body, /min\s*>\s*max/, '必须处理 min > max 的情况');
});

test('快请求分支必须调用 pickGlobalDelay', () => {
  const i = SRC_CODE.indexOf('快请求');
  assert.ok(i >= 0, '必须有快请求分支');
  const body = SRC_CODE.slice(Math.max(0, i - 800), i + 800);
  assert.match(body, /pickGlobalDelay\s*\(/, '快请求分支必须调用 pickGlobalDelay');
});

test('慢请求自适应分支不得调用 pickGlobalDelay', () => {
  // 精确截取：从慢请求分支起点到下一个 else 分支起点之间
  const start = SRC_CODE.indexOf('} else if (thinkMs > threshold) {');
  assert.ok(start >= 0, '必须有慢请求分支');
  const end = SRC_CODE.indexOf('} else {', start);
  assert.ok(end > start, '必须能定位到快请求分支起点');
  const body = SRC_CODE.slice(start, end);
  assert.ok(!body.includes('pickGlobalDelay'), '慢请求分支不得随机');
});

test('computeThinkAdaptiveDelay 函数体本身不得含 pickGlobalDelay', () => {
  const i = SRC_CODE.indexOf('function computeThinkAdaptiveDelay');
  assert.ok(i >= 0, '必须有 computeThinkAdaptiveDelay');
  const end = SRC_CODE.indexOf('\n}', i);
  const body = SRC_CODE.slice(i, end + 2);
  assert.ok(!body.includes('pickGlobalDelay'), '自适应函数体内不得随机');
});

test('必须支持新键 lingya-global-send-delay-min / -max', () => {
  assert.match(SRC, /lingya-global-send-delay-min/, '必须读取新键 min');
  assert.match(SRC, /lingya-global-send-delay-max/, '必须读取新键 max');
});

test('必须保留旧键迁移逻辑（lingya-global-send-delay）', () => {
  const i = SRC.indexOf('lingya-global-send-delay-min');
  assert.ok(i >= 0, '必须有新键读取');
  const body = SRC.slice(Math.max(0, i - 200), i + 1500);
  assert.match(body, /lingya-global-send-delay['"]/, '必须读取旧键用于迁移');
});


const SHELL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'shell-renderer.js'),
  'utf8'
);

test('设置面板必须有两个输入框：最小 / 最大', () => {
  assert.match(SHELL, /id="sh-set-dual-delay-min"/, '必须有最小值输入框');
  assert.match(SHELL, /id="sh-set-dual-delay-max"/, '必须有最大值输入框');
});

test('设置面板保存时必须校验 min <= max', () => {
  const i = SHELL.indexOf("ev('sh-set-think-save')");
  assert.ok(i >= 0, '必须有保存按钮绑定');
  const body = SHELL.slice(i, i + 3000);
  assert.match(body, /最小值不能大于最大值/, '必须校验 min <= max');
});

test('设置面板回填必须读新键', () => {
  assert.match(SHELL, /lingya-global-send-delay-min/, '必须回填 min');
  assert.match(SHELL, /lingya-global-send-delay-max/, '必须回填 max');
});

test('设置面板不得再写旧的单一延迟键', () => {
  assert.ok(
    !/localStorage\.setItem\('lingya-global-send-delay'\s*,/.test(SHELL),
    '不得再写旧键（否则新旧配置打架）'
  );
});

test('快请求分支不得再读 state.globalSendDelay', () => {
  const start = SRC_CODE.indexOf('快请求随机');
  assert.ok(start >= 0, '必须有快请求随机分支');
  const body = SRC_CODE.slice(start, start + 400);
  assert.ok(
    !/state\.globalSendDelay\b(?!Min|Max)/.test(body),
    '快请求分支不得再读 state.globalSendDelay'
  );
});
