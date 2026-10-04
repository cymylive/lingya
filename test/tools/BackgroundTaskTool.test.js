'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { BashBackgroundTool, BashOutputTool, BashKillTool } = require('../../tools/BackgroundTaskTool');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('后台任务：启动 → 输出 → 完成', async () => {
  const bg = new BashBackgroundTool();
  const out = new BashOutputTool();
  const r1 = await bg.execute({ command: 'node -e "console.log(1+1)"' });
  assert.strictEqual(r1.success, true);
  const id = (r1.data.match(/任务 ID: (\S+)/) || [])[1];
  assert.ok(id, '应返回任务 ID');

  const r2 = await out.execute({ task_id: id, wait: 5000 });
  assert.strictEqual(r2.success, true);
  assert.match(r2.data, /已完成/);
  assert.match(r2.data, /2/);
});

test('后台任务：终止运行中的任务', async () => {
  const bg = new BashBackgroundTool();
  const kill = new BashKillTool();
  const out = new BashOutputTool();
  const r1 = await bg.execute({ command: 'node -e "setInterval(()=>{},1000)"' });
  const id = (r1.data.match(/任务 ID: (\S+)/) || [])[1];
  const r2 = await kill.execute({ task_id: id });
  assert.strictEqual(r2.success, true);
  await sleep(500);
  const r3 = await out.execute({ task_id: id });
  assert.match(r3.data, /已完成/);
});

test('后台任务：不存在的任务 ID 报错', async () => {
  const out = new BashOutputTool();
  const kill = new BashKillTool();
  assert.strictEqual((await out.execute({ task_id: 'nope' })).success, false);
  assert.strictEqual((await kill.execute({ task_id: 'nope' })).success, false);
});

test('后台任务：空命令报错', async () => {
  const bg = new BashBackgroundTool();
  assert.strictEqual((await bg.execute({ command: '' })).success, false);
});
