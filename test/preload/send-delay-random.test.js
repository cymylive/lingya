'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 快请求发送延迟随机化测试。
 *
 * 【2026-11-01 对齐 Cuckoo】
 * 延迟策略从「双策略（快请求随机 / 慢请求按 thinkMs 自适应）」改为
 * **纯均匀随机**：所有自动发送的延迟都与历史响应时长无关。
 *
 * 原因：Cuckoo 用 pickDelay(4000, 10000) 均匀随机长期不封号；
 * LingYa 原「往返 × 0.2 自适应」有强统计相关，可被机器学习识别。
 *
 * 约束：
 *   - 默认区间 4000-10000ms（与 Cuckoo 一致）
 *   - min === max 时退化为固定值（兼容）
 *   - min > max 时运行时自动交换（兜底）
 *   - 不再存在「慢请求自适应分支」（已移除）
 *   - 旧 localStorage 键 lingya-global-send-delay 仍支持迁移
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

// 【2026-11-01 对齐 Cuckoo】默认区间 4000-10000（与 Cuckoo 的 pickDelay(4000,10000) 一致）
test('state 必须有 globalSendDelayMin / globalSendDelayMax，默认 4000 / 10000', () => {
  assert.match(STATE, /globalSendDelayMin:\s*4000/, '必须定义 globalSendDelayMin 默认 4000');
  assert.match(STATE, /globalSendDelayMax:\s*10000/, '必须定义 globalSendDelayMax 默认 10000');
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

test('自动发送分支必须调用 pickGlobalDelay（纯均匀随机）', () => {
  // 【2026-11-01】不再有「快请求」字样，改为「均匀随机」
  const i = SRC_CODE.indexOf('均匀随机');
  assert.ok(i >= 0, '必须有均匀随机分支');
  const body = SRC_CODE.slice(Math.max(0, i - 800), i + 800);
  assert.match(body, /pickGlobalDelay\s*\(/, '均匀随机分支必须调用 pickGlobalDelay');
});

test('不再存在慢请求自适应分支（thinkMs 相关代码应已删除）', () => {
  // 【2026-11-01】thinkMs > threshold 的 else-if 分支应已移除
  assert.ok(
    !SRC_CODE.includes('} else if (thinkMs > threshold)'),
    '慢请求自适应分支必须已移除（避免延迟与历史响应时长强相关）'
  );
});

test('不再调用 computeThinkAdaptiveDelay（自适应延迟已废弃）', () => {
  // 函数定义可能还在（向后兼容），但不应再被调用
  const defIndex = SRC_CODE.indexOf('function computeThinkAdaptiveDelay');
  // 计算函数定义的结束位置
  let endIndex = defIndex + 200;
  if (defIndex >= 0) {
    const searchFrom = defIndex + 'function computeThinkAdaptiveDelay'.length;
    const nextClosing = SRC_CODE.indexOf('\n}', searchFrom);
    if (nextClosing > 0) endIndex = nextClosing + 2;
  }
  // 剔除函数定义区，剩下的代码不得调用它
  const withoutDef = defIndex >= 0
    ? SRC_CODE.slice(0, defIndex) + SRC_CODE.slice(endIndex)
    : SRC_CODE;
  assert.ok(
    !/computeThinkAdaptiveDelay\s*\(/.test(withoutDef),
    '不得再调用 computeThinkAdaptiveDelay（已在 2026-11-01 移除自适应策略）'
  );
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

test('均匀随机分支不得再读 state.globalSendDelay', () => {
  const start = SRC_CODE.indexOf('均匀随机');
  assert.ok(start >= 0, '必须有均匀随机分支');
  const body = SRC_CODE.slice(start, start + 400);
  assert.ok(
    !/state\.globalSendDelay\b(?!Min|Max)/.test(body),
    '均匀随机分支不得再读 state.globalSendDelay'
  );
});
