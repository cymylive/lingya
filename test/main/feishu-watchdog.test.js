'use strict';
/**
 * 飞书看门狗状态机 + 阈值可配测试
 * 覆盖：
 *   1. touchActivity 的 active 语义、lastActivity 刷新、warned 重置
 *   2. getStallTimeoutMs 从配置读取，0 表示关闭
 * 看门狗据此判断"任务进行中但长期无进展" → 推送卡住告警。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { installElectronMock } = require('../helpers/mock-electron.js');

// 隔离配置目录（feishu.json），避免读真实用户配置
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-feishu-test-'));
process.env.LINGYA_HOME = TMP_HOME;

function writeFeishuConfig(extra) {
  fs.writeFileSync(
    path.join(TMP_HOME, 'feishu.json'),
    JSON.stringify(Object.assign({ enabled: true }, extra || {})),
    'utf-8'
  );
}

test('飞书看门狗：touchActivity 状态转移', (t) => {
  const restore = installElectronMock();
  t.after(() => restore());

  const { touchActivity, taskState } = require('../../src/main/feishu-ipc.js');
  assert.ok(typeof touchActivity === 'function', '应导出 touchActivity');

  const pid = 'test-profile';
  taskState.delete(pid);

  // 1) active=true：用户发话，任务进入进行中
  touchActivity(pid, true);
  let st = taskState.get(pid);
  assert.strictEqual(st.active, true, 'active 应为 true');
  assert.strictEqual(st.warned, false, 'warned 应为 false');
  assert.ok(st.lastActivity > 0, 'lastActivity 应被刷新');

  // 2) active=undefined：只刷新时间，保持 active（tool-end 场景）
  touchActivity(pid);
  st = taskState.get(pid);
  assert.strictEqual(st.active, true, 'active 应保持不变');

  // 3) active=false：任务收尾（ai-reply 且无后续工具）
  touchActivity(pid, false);
  st = taskState.get(pid);
  assert.strictEqual(st.active, false, 'active 应为 false');

  // 4) 新活动应清掉上次的 warned 标记（允许再次告警）
  st.warned = true;
  touchActivity(pid, true);
  st = taskState.get(pid);
  assert.strictEqual(st.warned, false, '新活动应重置 warned');

  taskState.delete(pid);
});

test('飞书看门狗：getStallTimeoutMs 从配置读取，0 表示关闭', (t) => {
  const restore = installElectronMock();
  t.after(() => restore());

  // 注意：config 模块有缓存，需清缓存让新配置生效
  const ipcPath = require.resolve('../../src/main/feishu-ipc.js');
  const cfgPath = require.resolve('../../src/feishu/config.js');
  delete require.cache[ipcPath];
  delete require.cache[cfgPath];

  // 默认（无 stallTimeoutSec）→ 150 秒
  writeFeishuConfig({});
  let mod = require('../../src/main/feishu-ipc.js');
  assert.strictEqual(mod.getStallTimeoutMs(), 150 * 1000, '缺省应为 150 秒');

  // 自定义 300 秒
  delete require.cache[ipcPath];
  delete require.cache[cfgPath];
  writeFeishuConfig({ stallTimeoutSec: 300 });
  mod = require('../../src/main/feishu-ipc.js');
  assert.strictEqual(mod.getStallTimeoutMs(), 300 * 1000, '应读取配置 300 秒');

  // 0 → 关闭（返回 0）
  delete require.cache[ipcPath];
  delete require.cache[cfgPath];
  writeFeishuConfig({ stallTimeoutSec: 0 });
  mod = require('../../src/main/feishu-ipc.js');
  assert.strictEqual(mod.getStallTimeoutMs(), 0, '0 应表示关闭看门狗');
});

test('飞书：pushTaskDone 完成标志开关（默认开）', (t) => {
  const restore = installElectronMock();
  t.after(() => restore());

  const cfgPath = require.resolve('../../src/feishu/config.js');
  const { defaultConfig, readConfig, writeConfig } = require('../../src/feishu/config.js');
  assert.strictEqual(defaultConfig().pushTaskDone, true, '默认应开启完成标志推送');

  // 关闭后能持久化
  writeConfig({ pushTaskDone: false });
  delete require.cache[cfgPath];
  const fresh = require('../../src/feishu/config.js');
  assert.strictEqual(fresh.readConfig().pushTaskDone, false, '应能关闭完成标志推送');
});

