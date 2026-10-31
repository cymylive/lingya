'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const DOM_DIR = path.resolve(__dirname, '../../src/preload/dom');
const OVERLAY_DIR = path.resolve(__dirname, '../../src/preload/overlay');
const AUTO_INJECT = path.join(DOM_DIR, 'auto-inject.js');

/** localStorage 简易实现 */
function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

/** 把指定绝对路径的模块替换成假导出（走 require.cache，不劫持 Module._load） */
function stub(absPath, exports) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exports;
  require.cache[absPath] = m;
}

/** 清掉 auto-inject 及其被 stub 的依赖缓存 */
function clearCache() {
  for (const p of [
    AUTO_INJECT,
    path.join(DOM_DIR, 'state.js'),
    path.join(DOM_DIR, 'chat-input.js'),
    path.join(DOM_DIR, 'deepseek-history-archiver.js'),
    path.join(OVERLAY_DIR, 'ui.js'),
  ]) {
    delete require.cache[p];
  }
}

function loadAutoInject(opts) {
  const o = opts || {};
  const calls = { ack: [], deleted: [], toasts: [], listeners: {} };

  global.window = {
    location: { href: 'https://chat.deepseek.com/' },
    electronAPI: {
      onReceivedMigration: (cb) => { calls.listeners.received = cb; },
      rotationAck: (payload) => { calls.ack.push(payload); return Promise.resolve({ success: true }); },
      clearAbort: () => {},
      initProject: () => Promise.resolve(),
    },
  };
  global.localStorage = makeStorage(o.storage);
  global.document = { querySelector: () => null };

  clearCache();  // 必须先清缓存，否则下面的 stub 会被随后的 clear 删掉
  stub(path.join(OVERLAY_DIR, 'ui.js'), { showToast: (msg) => calls.toasts.push(msg) });
  stub(path.join(DOM_DIR, 'state.js'), {
    stopped: false, stoppedAt: 0, initializationDone: false, pendingInitialPrompt: false,
    resetTaskFlags: () => {},
  });
  stub(path.join(DOM_DIR, 'chat-input.js'), { sendMessageToChat: () => {} });
  stub(path.join(DOM_DIR, 'deepseek-history-archiver.js'), {
    deleteSessionSilent: (sid) => { calls.deleted.push(sid); return Promise.resolve(true); },
  });

  let mod = null;
  let loadErr = null;
  try {
    mod = require(AUTO_INJECT);
  } catch (err) {
    loadErr = err;
  }
  return { mod, calls, loadErr };
}

beforeEach(() => { clearCache(); });

test('模块加载时注册迁移接收监听', () => {
  const { calls, loadErr } = loadAutoInject();
  assert.equal(loadErr, null, '模块加载不应抛错: ' + (loadErr && loadErr.message));
  assert.equal(typeof calls.listeners.received, 'function', '必须注册 onReceivedMigration');
});

test('收到迁移包写入 localStorage：oldSessionId 强制为 null', () => {
  const { calls } = loadAutoInject();
  calls.listeners.received({ requestId: 'r1', history: 'HIST', projectDir: 'D:/proj' });
  const raw = global.localStorage.getItem('lingya-pending-migration');
  assert.ok(raw, '必须写入 lingya-pending-migration');
  const data = JSON.parse(raw);
  assert.equal(data.oldSessionId, null, '目标窗口绝不能带着源会话 ID');
  assert.equal(data.rotationRequestId, 'r1');
  assert.equal(data.stage, 'init');
  assert.equal(data.history, 'HIST');
  assert.equal(data.projectDir, 'D:/proj');
});

test('stage=sent 且带 rotationRequestId 时回 ack 且不删旧会话', () => {
  const { mod, calls } = loadAutoInject({
    storage: {
      'lingya-pending-migration': JSON.stringify({
        stage: 'sent', rotationRequestId: 'r7', oldSessionId: 's9', history: 'H',
      }),
    },
  });
  mod.maybeInject();
  assert.equal(calls.ack.length, 1, '必须回一次 ack');
  assert.equal(calls.ack[0].requestId, 'r7');
  assert.equal(calls.ack[0].ok, true);
  assert.deepEqual(calls.deleted, [], '目标窗口绝不能删会话');
});

test('stage=sent 且无 rotationRequestId 时保持原有删除行为', () => {
  const { mod, calls } = loadAutoInject({
    storage: {
      'lingya-pending-migration': JSON.stringify({ stage: 'sent', oldSessionId: 's9', history: 'H' }),
    },
  });
  mod.maybeInject();
  assert.deepEqual(calls.ack, [], '非轮转路径不应调用 ack');
  assert.deepEqual(calls.deleted, ['s9'], '原地迁移仍要删旧会话');
});
