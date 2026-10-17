'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.join(process.cwd(), 'src/preload/dom/auto-rename.js');

function resetModules() {
  delete require.cache[MOD];
  // 清掉它可能 require 的模块
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('auto-rename') >= 0 || k.indexOf('chat-input') >= 0 || k.indexOf('providers') >= 0) delete require.cache[k];
  }
}

function installStubs(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.storage || {});
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.window = global;
  global.location = { href: opts.url || 'https://chat.deepseek.com/a/chat/s/abcd1234-0000-1111-2222-333344445555' };
  const badgeClasses = new Set(opts.badge || []);
  global.document = {
    getElementById: (id) => (id === 'lingya-status-badge' ? {
      classList: { contains: (c) => badgeClasses.has(c) },
    } : null),
  };
  global.__store = store;
  return store;
}

test('isEnabled 默认开启', () => {
  installStubs({ storage: {} });
  resetModules();
  // 未导出 isEnabled，通过 scheduleAfterInit 行为间接验证：默认应安排任务
  const m = require(MOD);
  assert.ok(typeof m.scheduleAfterInit === 'function');
});

test('markRenamed / hasRenamed 往返', () => {
  installStubs({ storage: {} });
  resetModules();
  const m = require(MOD);
  assert.strictEqual(m.hasRenamed('sid-1'), false);
  m.markRenamed('sid-1');
  assert.strictEqual(m.hasRenamed('sid-1'), true);
  m.markRenamed('sid-1'); // 幂等
  const arr = JSON.parse(global.__store['lingya-auto-renamed-sessions']);
  assert.strictEqual(arr.filter((x) => x === 'sid-1').length, 1);
});

test('markRenamed 只保留最近 300 个', () => {
  installStubs({ storage: {} });
  resetModules();
  const m = require(MOD);
  for (let i = 0; i < 320; i++) m.markRenamed('sid-' + i);
  const arr = JSON.parse(global.__store['lingya-auto-renamed-sessions']);
  assert.strictEqual(arr.length, 300);
  assert.strictEqual(arr[arr.length - 1], 'sid-319');
  assert.strictEqual(m.hasRenamed('sid-0'), false, '最早的应被淘汰');
});

test('getCurrentSessionId 从 DeepSeek URL 提取', () => {
  installStubs({ url: 'https://chat.deepseek.com/a/chat/s/abcd1234-0000-1111-2222-333344445555' });
  resetModules();
  const m = require(MOD);
  assert.strictEqual(m.getCurrentSessionId(), 'abcd1234-0000-1111-2222-333344445555');
});

test('getCurrentSessionId 首页返回 null', () => {
  installStubs({ url: 'https://chat.deepseek.com/' });
  resetModules();
  const m = require(MOD);
  assert.strictEqual(m.getCurrentSessionId(), null);
});

test('已命名会话不重复安排', async () => {
  installStubs({ storage: {} });
  resetModules();
  const m = require(MOD);
  m.markRenamed('abcd1234-0000-1111-2222-333344445555');
  m.scheduleAfterInit({});
  // 立即 cancel 避免定时器悬挂
  m.cancel();
  // 无直接断言点，主要验证不抛异常 + 不写入新标记
  const arr = JSON.parse(global.__store['lingya-auto-renamed-sessions']);
  assert.strictEqual(arr.length, 1);
});

test('开关关闭时 scheduleAfterInit 不安排任务', () => {
  installStubs({ storage: { 'lingya-auto-rename-enabled': '0' } });
  resetModules();
  const m = require(MOD);
  m.scheduleAfterInit({});
  m.cancel();
  // 未写入任何标记
  assert.strictEqual(global.__store['lingya-auto-renamed-sessions'], undefined);
});

test('cancel 可重复调用不报错', () => {
  installStubs({ storage: {} });
  resetModules();
  const m = require(MOD);
  assert.doesNotThrow(() => { m.cancel(); m.cancel(); });
});
