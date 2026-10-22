'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { init, add, list, SYSTEM_PREFIXES } = require('../../tools/UserTodoStore');

/**
 * 系统消息不得写入待办（v0.6.98 实测发现【监督续跑】被写进了待办列表）。
 * 存储层加黑名单是最可靠的防线。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-utodo-sys-'));
init(tmp);

test('必须导出 SYSTEM_PREFIXES 黑名单', () => {
  assert.ok(Array.isArray(SYSTEM_PREFIXES), 'SYSTEM_PREFIXES 必须是数组');
  assert.ok(SYSTEM_PREFIXES.length >= 5, '黑名单至少 5 项');
});

test('拒绝【监督续跑】开头的文本', () => {
  assert.throws(
    () => add('s1', 'p1', '【监督续跑】检测到你已经 90 秒没有动作...'),
    /system message/,
    '系统催促消息不得写入待办'
  );
});

test('拒绝【自动续跑】开头的文本', () => {
  assert.throws(
    () => add('s1', 'p1', '【自动续跑】任务计划尚未完成'),
    /system message/
  );
});

test('拒绝【系统提示】开头的文本', () => {
  assert.throws(
    () => add('s1', 'p1', '【系统提示】上一步执行出错'),
    /system message/
  );
});

test('拒绝【工具执行结果】开头的文本', () => {
  assert.throws(
    () => add('s1', 'p1', '【工具执行结果】write 执行成功'),
    /system message/
  );
});

test('正常待办不受影响', () => {
  assert.doesNotThrow(() => add('s2', 'p1', '买牛奶'));
  assert.doesNotThrow(() => add('s2', 'p1', '修复登录 bug'));
  assert.doesNotThrow(() => add('s2', 'p1', '【重要】记得备份'));  // 非黑名单前缀
  assert.deepStrictEqual(list('s2', 'p1').map(t => t.text), ['买牛奶', '修复登录 bug', '【重要】记得备份']);
});

test('黑名单内的前缀出现在中间（非开头）不拦截', () => {
  assert.doesNotThrow(() => add('s3', 'p1', '看看【监督续跑】是怎么实现的'));
});
