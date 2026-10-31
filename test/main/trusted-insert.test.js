const { test } = require('node:test');
const assert = require('node:assert');

test('handleTrustedInsertText 对空文本返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const r = await ipc.__test.handleTrustedInsertText({ sender: { id: 1 } }, { text: '' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /empty/);
});

test('handleTrustedInsertText 对缺失 args 返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const r = await ipc.__test.handleTrustedInsertText({ sender: { id: 1 } }, null);
  assert.strictEqual(r.success, false);
});

test('handleTrustedInsertText 调 sendCommand 且用 Input.insertText', async () => {
  const ipc = require('../../src/main/ipc');
  const calls = [];
  const fakeDbg = {
    sendCommand: async (cmd, params) => { calls.push({ cmd, params }); return {}; },
  };
  const r = await ipc.__test.handleTrustedInsertText(
    { sender: { id: 1 } },
    { text: '你好' },
    { ensureAttached: () => fakeDbg }
  );
  assert.strictEqual(r.success, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'Input.insertText');
  assert.strictEqual(calls[0].params.text, '你好');
});

test('handleTrustedInsertText 在 sendCommand 失败时返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const fakeDbg = { sendCommand: async () => { throw new Error('debugger detached'); } };
  const r = await ipc.__test.handleTrustedInsertText(
    { sender: { id: 1 } },
    { text: 'x' },
    { ensureAttached: () => fakeDbg }
  );
  assert.strictEqual(r.success, false);
  assert.match(r.error, /debugger detached/);
});
