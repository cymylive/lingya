/**
 * 任务计划面板格式化回归测试
 *
 * 背景：QQ 通道原先进展推送是「🧠 AI 正在生成…」「🔧 正在调用工具」这类碎片，
 * 用户看不出整体进度。改为每次 todo 变化推一条完整面板：
 *   计划清单（含状态符号）+ 正在处理第几步 + 剩余步数 + 当前时间 + 当前活动。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { formatTodoPanel } = require('../../src/main/qq-ipc');

/** 造一个 todo 列表 */
function mk(statuses) {
  return statuses.map(function (s, i) { return { content: '步骤' + (i + 1), status: s }; });
}

test('空列表返回空串（不推空消息）', () => {
  assert.strictEqual(formatTodoPanel([], 'x'), '');
  assert.strictEqual(formatTodoPanel(null, 'x'), '');
  assert.strictEqual(formatTodoPanel(undefined, 'x'), '');
});

test('状态符号正确：completed=☑ in_progress=🔨 pending=⬜', () => {
  const out = formatTodoPanel(mk(['completed', 'in_progress', 'pending']), '🧠 AI 正在生成…');
  assert.ok(out.indexOf('1. ☑ 步骤1') !== -1, '第1步应为 ☑');
  assert.ok(out.indexOf('2. 🔨 步骤2') !== -1, '第2步应为 🔨');
  assert.ok(out.indexOf('3. ⬜ 步骤3') !== -1, '第3步应为 ⬜');
});

test('标题带总步数', () => {
  const out = formatTodoPanel(mk(['pending', 'pending', 'pending']), '');
  assert.ok(out.indexOf('📋 任务计划（3步）') !== -1);
});

test('定位 in_progress 步，剩余步数 = 总数 - 当前索引 - 1', () => {
  // 6 步，第 2 步（索引1）在跑 → 剩余 4 步
  const out = formatTodoPanel(
    mk(['completed', 'in_progress', 'pending', 'pending', 'pending', 'pending']),
    '🔧 AI 正在调用工具…'
  );
  assert.ok(out.indexOf('正在处理第2步：步骤2（剩余4步）') !== -1, '实际输出:\n' + out);
});

test('最后一步在跑时剩余 0 步', () => {
  const out = formatTodoPanel(mk(['completed', 'in_progress']), '');
  assert.ok(out.indexOf('正在处理第2步：步骤2（剩余0步）') !== -1, '实际输出:\n' + out);
});

test('无 in_progress 且全部完成 → 显示全部完成', () => {
  const out = formatTodoPanel(mk(['completed', 'completed']), '');
  assert.ok(out.indexOf('🏁 全部完成（2步）') !== -1, '实际输出:\n' + out);
});

test('无 in_progress 且有未完成 → 显示等待开始', () => {
  const out = formatTodoPanel(mk(['pending', 'pending']), '');
  assert.ok(out.indexOf('等待开始…') !== -1, '实际输出:\n' + out);
});

test('当前时间格式：YYYY年M月D日 HH:MM:SS 星期X', () => {
  const out = formatTodoPanel(mk(['in_progress']), '');
  const m = out.match(/当前时间：(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2}):(\d{2}) 星期[日一二三四五六]/);
  assert.ok(m, '时间格式不符，实际输出:\n' + out);
});

test('activity 为空时不输出「当前状态」行', () => {
  const out = formatTodoPanel(mk(['in_progress']), '');
  assert.ok(out.indexOf('当前状态：') === -1);
});

test('activity 非空时输出「当前状态」行', () => {
  const out = formatTodoPanel(mk(['in_progress']), '🔧 AI 正在调用工具：bash');
  assert.ok(out.indexOf('当前状态：🔧 AI 正在调用工具：bash') !== -1);
});

test('超长步骤内容被截断（列表 60 字 / 当前步 40 字）', () => {
  const long = 'A'.repeat(100);
  const out = formatTodoPanel([{ content: long, status: 'in_progress' }], '');
  const lines = out.split('\n');
  const listLine = lines.find(function (l) { return l.indexOf('1. 🔨') === 0; });
  const curLine = lines.find(function (l) { return l.indexOf('正在处理第1步') === 0; });
  assert.ok(listLine.length < 100, '列表行应被截断');
  assert.ok(curLine.length < 80, '当前步行应被截断');
});

test('含分隔线 ━━━━━━━━━━', () => {
  const out = formatTodoPanel(mk(['in_progress']), '');
  assert.ok(out.indexOf('━━━━━━━━━━') !== -1);
});

// ===== 无计划面板（2026-10-30 新增）=====
const { formatEmptyPanel, formatNow } = require('../../src/main/qq-ipc');

test('formatEmptyPanel：计划显示「无」，带「正在处理无计划」与时间', () => {
  const out = formatEmptyPanel('✅ 已回复');
  assert.ok(out.indexOf('📋 任务计划') === 0, '首行应为任务计划标题');
  assert.ok(out.indexOf('\n无\n') !== -1, '计划区应显示「无」');
  assert.ok(out.indexOf('━━━━━━━━━━') !== -1, '应有分隔线');
  assert.ok(out.indexOf('正在处理无计划') !== -1, '应有「正在处理无计划」行');
  assert.ok(out.indexOf('当前时间：') !== -1, '应有当前时间');
  assert.ok(out.indexOf('当前状态：✅ 已回复') !== -1, '应带活动文案');
});

test('formatEmptyPanel：不传 activity 时默认「✅ 已回复」', () => {
  const out = formatEmptyPanel();
  assert.ok(out.indexOf('当前状态：✅ 已回复') !== -1);
});

test('formatEmptyPanel 与 formatTodoPanel 骨架一致（标题/分隔线/时间/状态四要素都在）', () => {
  const empty = formatEmptyPanel('🔧 AI 正在调用工具');
  const todo = formatTodoPanel([{ content: '步骤1', status: 'in_progress' }], '🔧 AI 正在调用工具');
  const keys = ['📋 任务计划', '━━━━━━━━━━', '当前时间：', '当前状态：'];
  for (const k of keys) {
    assert.ok(empty.indexOf(k) !== -1, '无计划面板缺少：' + k);
    assert.ok(todo.indexOf(k) !== -1, '计划面板缺少：' + k);
  }
});

test('formatNow：格式为 YYYY年M月D日 HH:MM:SS 星期X', () => {
  const s = formatNow();
  const m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2}):(\d{2}) 星期[日一二三四五六]$/);
  assert.ok(m, '实际输出：' + s);
});

test('formatNow：时/分/秒恒为两位补零', () => {
  const s = formatNow();
  const m = s.match(/ (\d{2}):(\d{2}):(\d{2}) /);
  assert.ok(m, '时分秒应为两位：' + s);
});


// ===== isFinal 模式（2026-10-30 新增）=====
test('isFinal=true 时显示「任务结束（完成 X/Y 步）」而非「正在处理第X步」', () => {
  const out = formatTodoPanel(
    [
      { content: '步骤1', status: 'completed' },
      { content: '步骤2', status: 'completed' },
      { content: '步骤3', status: 'pending' },
      { content: '步骤4', status: 'pending' },
    ],
    '✅ 已回复',
    { isFinal: true }
  );
  assert.ok(out.indexOf('🏁 任务结束（完成 2/4 步）') !== -1, '实际输出：\n' + out);
  assert.ok(out.indexOf('正在处理第') === -1, '终结态不应显示「正在处理」');
});

test('isFinal 未传时行为不变（向后兼容）', () => {
  const out = formatTodoPanel([{ content: '步骤1', status: 'in_progress' }], '🔧 调用工具');
  assert.ok(out.indexOf('正在处理第1步') !== -1);
});


