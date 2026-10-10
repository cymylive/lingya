'use strict';
/**
 * 定时任务：cron 解析 + 存储 + 调度器 tick
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-schedule-test-'));
process.env.LINGYA_HOME = TMP_HOME;

const cron = require('../../src/main/cron.js');
const store = require('../../src/main/schedule-store.js');
const scheduler = require('../../src/main/scheduler.js');

test('cron: isValidCron 校验', () => {
  assert.ok(cron.isValidCron('0 3 * * *'), '每天3点应有效');
  assert.ok(cron.isValidCron('*/5 * * * *'), '每5分钟应有效');
  assert.ok(cron.isValidCron('0 9 * * 1-5'), '工作日应有效');
  assert.ok(!cron.isValidCron('0 3 * *'), '字段不足应无效');
  assert.ok(!cron.isValidCron('bad'), '非法应无效');
  assert.ok(!cron.isValidCron('99 3 * * *'), '越界分钟应无效');
});

test('cron: matches 命中判断', () => {
  // 每天 03:00
  const at3 = new Date(2026, 0, 15, 3, 0, 0);
  assert.ok(cron.matches('0 3 * * *', at3), '03:00 应命中');
  const at4 = new Date(2026, 0, 15, 4, 0, 0);
  assert.ok(!cron.matches('0 3 * * *', at4), '04:00 不应命中');
  // 每周一 09:30（2026-01-15 是周四，2026-01-19 是周一）
  const monday = new Date(2026, 0, 19, 9, 30, 0);
  assert.strictEqual(monday.getDay(), 1, '前置：应为周一');
  assert.ok(cron.matches('30 9 * * 1', monday), '周一09:30 应命中');
});

test('cron: buildCron 简单模式', () => {
  assert.strictEqual(cron.buildCron('daily', 3, 0), '0 3 * * *');
  assert.strictEqual(cron.buildCron('weekly', 9, 30, 1), '30 9 * * 1');
});

test('schedule-store: CRUD', () => {
  store.init(TMP_HOME);
  const t = store.addTask({ name: '测试', cron: '0 3 * * *', prompt: '清理C盘' });
  assert.ok(t.id, '应生成 id');
  assert.strictEqual(store.listTasks().length, 1);

  store.updateTask(t.id, { name: '改名', enabled: false });
  const t2 = store.getTask(t.id);
  assert.strictEqual(t2.name, '改名');
  assert.strictEqual(t2.enabled, false);

  store.markRun(t.id, { success: true });
  assert.ok(store.getTask(t.id).lastRunAt, '应记录运行时间');

  assert.ok(store.deleteTask(t.id));
  assert.strictEqual(store.listTasks().length, 0);
});

test('scheduler: tick 命中并只触发一次', async () => {
  store.init(TMP_HOME);
  // 清空
  for (const t of store.listTasks()) store.deleteTask(t.id);
  const task = store.addTask({ name: '命中测试', cron: '0 3 * * *', prompt: 'x', enabled: true });

  let fired = 0;
  scheduler.setRunner(async () => { fired++; });
  const at = new Date(2026, 0, 15, 3, 0, 0);
  await scheduler.tick(at);
  await scheduler.tick(at); // 同一分钟第二次不应再触发
  assert.strictEqual(fired, 1, '同一分钟应只触发一次');

  // 未命中时间不触发
  await scheduler.tick(new Date(2026, 0, 15, 5, 0, 0));
  assert.strictEqual(fired, 1);

  store.deleteTask(task.id);
});
