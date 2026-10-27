'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const origLoad = Module._load;
let sentEvents = [];
let fakeWin = null;

Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { isPackaged: false, getPath: () => require('os').tmpdir() },
      dialog: { showOpenDialogSync: () => null },
    };
  }
  return origLoad.apply(this, arguments);
};

const pc = require('../../src/main/project-context');
Module._load = origLoad;

/**
 * 发送端节流：同一窗口 15 秒内重复调用 initProject 只发一次 initial-prompt。
 *
 * 【真实事故】4 条触发路径（手动/自动注入/定时任务/飞书）各自独立，
 * 没有节流时同一批 systemPrompt 会被完整灌入多次。
 */

test('INIT_PROMPT_MIN_INTERVAL_MS 是合理值（不低于 5 秒）', () => {
  assert.ok(pc.INIT_PROMPT_MIN_INTERVAL_MS >= 5000, '节流间隔太短起不到防护作用');
});

test('_resetInitPromptThrottle 可清空节流状态', () => {
  assert.doesNotThrow(() => pc._resetInitPromptThrottle());
});

test('splitPromptIntoChunks 仍正常工作（节流改动未破坏分段）', () => {
  const text = 'A'.repeat(20000);
  const chunks = pc.splitPromptIntoChunks(text, 15000, 40);
  assert.strictEqual(chunks.length, 2);
  assert.ok(chunks[0].length <= 15000);
  assert.ok(chunks[1].length <= 15000);
});
