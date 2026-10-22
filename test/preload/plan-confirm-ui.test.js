'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TPL = fs.readFileSync(path.join(ROOT, 'src/preload/overlay/template.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, 'src/preload/overlay/plan-panel.js'), 'utf8');

function strip(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const T = strip(TPL), P = strip(PANEL);

test('模板必须有「确认执行」按钮', () => {
  assert.ok(T.includes('lingya-plan-confirm-btn'), '缺少 lingya-plan-confirm-btn');
});

test('确认按钮必须默认隐藏（无计划时不显示）', () => {
  const idx = T.indexOf('lingya-plan-confirm-btn');
  const seg = T.slice(Math.max(0, idx - 200), idx + 300);
  assert.match(seg, /lingya-hidden/, '按钮初始应带 lingya-hidden');
});

test('必须有确认按钮的 CSS', () => {
  assert.match(T, /\.lingya-plan-confirm-btn\s*\{/, '缺少确认按钮 CSS');
});

test('plan-panel 必须查询 planConfirmStatus', () => {
  assert.match(P, /planConfirmStatus/, '必须调用 electronAPI.planConfirmStatus');
});

test('plan-panel 必须实现按钮显隐逻辑', () => {
  assert.match(P, /lingya-plan-confirm-btn/, 'plan-panel 必须操作确认按钮');
});

test('点击确认必须调用 planConfirm', () => {
  // 实现传了 { silent } 参数（区分"点按钮"与"回复关键词"，避免重复发消息）
  assert.match(P, /planConfirm\(\s*\{?/, '点击后必须调用 electronAPI.planConfirm()');
});

test('必须处理 onPlanConfirmedContinue（确认后让 AI 继续）', () => {
  assert.match(P, /onPlanConfirmedContinue/, '必须监听确认后继续事件');
});

test('用户消息必须能识别确认词', () => {
  assert.match(P, /确认执行|CONFIRM_KEYWORDS/, '必须有确认词识别');
});
