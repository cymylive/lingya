'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/** 用一个假的 electron 模块加载 api.js，取出 electronAPI 对象 */
function loadApi() {
  const handlers = new Map();
  const listeners = new Map();
  const fakeIpcRenderer = {
    invoke: async (channel, payload) => ({ __channel: channel, __payload: payload }),
    on: (channel, h) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(h);
    },
    removeListener: (channel, h) => {
      const arr = listeners.get(channel) || [];
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    },
    send: () => {},
  };
  // api.js 末尾会写 window.electronAPI，Node 环境需要补 window
  if (!global.window) global.window = {};
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcRenderer: fakeIpcRenderer,
        contextBridge: { exposeInMainWorld: () => {} },
        webFrame: { executeJavaScript: () => {} },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  // 清掉缓存，保证每个用例拿到新实例
  delete require.cache[require.resolve('../../src/preload/api.js')];
  require('../../src/preload/api.js');
  Module._load = origLoad;
  // api.js 不 module.exports，靠 window.electronAPI 导出
  return { api: global.window.electronAPI, fakeIpcRenderer, listeners };
}

test('preload 暴露 6 个轮转方法', () => {
  const { api } = loadApi();
  for (const name of ['rotationGetConfig', 'rotationSetConfig', 'rotationListCandidates', 'rotationSubmit', 'rotationAck', 'rotationReset']) {
    assert.equal(typeof api[name], 'function', name + ' 必须是函数');
  }
});

test('rotationGetConfig 调用 rotation-get-config', async () => {
  const { api } = loadApi();
  const r = await api.rotationGetConfig();
  assert.equal(r.__channel, 'rotation-get-config');
});

test('rotationSetConfig 透传 patch', async () => {
  const { api } = loadApi();
  const r = await api.rotationSetConfig({ enabled: true });
  assert.equal(r.__channel, 'rotation-set-config');
  assert.deepEqual(r.__payload, { patch: { enabled: true } });
});

test('rotationSubmit 透传 data', async () => {
  const { api } = loadApi();
  const r = await api.rotationSubmit({ history: 'h' });
  assert.equal(r.__channel, 'rotation-submit');
  assert.deepEqual(r.__payload, { data: { history: 'h' } });
});

test('rotationAck 透传 requestId/ok/error', async () => {
  const { api } = loadApi();
  const r = await api.rotationAck({ requestId: 'r1', ok: true });
  assert.equal(r.__channel, 'rotation-ack');
  assert.deepEqual(r.__payload, { requestId: 'r1', ok: true, error: undefined });
});

test('rotationReset / rotationListCandidates 通道正确', async () => {
  const { api } = loadApi();
  assert.equal((await api.rotationReset()).__channel, 'rotation-reset');
  assert.equal((await api.rotationListCandidates()).__channel, 'rotation-list-candidates');
});

test('onRotationResult 返回取消订阅函数，且能收到 payload', () => {
  const { api, listeners } = loadApi();
  let got = null;
  const off = api.onRotationResult((p) => { got = p; });
  assert.equal(typeof off, 'function');
  const hs = listeners.get('lingya-rotation-result') || [];
  assert.equal(hs.length, 1);
  hs[0]({}, { ok: true, targetProfileId: 'p2' });
  assert.equal(got.ok, true);
  off();
  assert.equal((listeners.get('lingya-rotation-result') || []).length, 0);
});

test('onReceivedMigration 返回取消订阅函数，且能收到 payload', () => {
  const { api, listeners } = loadApi();
  let got = null;
  const off = api.onReceivedMigration((p) => { got = p; });
  assert.equal(typeof off, 'function');
  const hs = listeners.get('lingya-received-migration') || [];
  assert.equal(hs.length, 1);
  hs[0]({}, { requestId: 'r9', history: 'x' });
  assert.equal(got.requestId, 'r9');
  off();
  assert.equal((listeners.get('lingya-received-migration') || []).length, 0);
});
