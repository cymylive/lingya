const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createArchiveIpc } = require('../../src/main/conversation-archive-ipc');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-arch-ipc-')); }

test('IPC 注册：append / read / has 三个通道都存在', () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  assert.strictEqual(typeof handlers['conversation-archive-append'], 'function');
  assert.strictEqual(typeof handlers['conversation-archive-read'], 'function');
  assert.strictEqual(typeof handlers['conversation-archive-has'], 'function');
});

test('append 后 read 能拿到数据', async () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  const ev = { sender: {} };
  const a = await handlers['conversation-archive-append'](ev, { sessionId: 's1', entry: { role: 'user', text: 'hi', ts: 1 } });
  assert.strictEqual(a.success, true);
  const r = await handlers['conversation-archive-read'](ev, { sessionId: 's1' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].text, 'hi');
});

test('has 正确反映存档是否存在', async () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  const ev = { sender: {} };
  const before = await handlers['conversation-archive-has'](ev, { sessionId: 's1' });
  assert.strictEqual(before.exists, false);
  await handlers['conversation-archive-append'](ev, { sessionId: 's1', entry: { role: 'user', text: 'x', ts: 1 } });
  const after = await handlers['conversation-archive-has'](ev, { sessionId: 's1' });
  assert.strictEqual(after.exists, true);
});

test('没有窗口上下文时返回失败而不是崩溃', async () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => null };
  createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  const r = await handlers['conversation-archive-read']({ sender: {} }, { sessionId: 's1' });
  assert.strictEqual(r.success, false);
});

test('缺 sessionId 时返回失败', async () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  const ev = { sender: {} };
  const a = await handlers['conversation-archive-append'](ev, {});
  assert.strictEqual(a.success, false);
  const r = await handlers['conversation-archive-read'](ev, {});
  assert.strictEqual(r.success, false);
  const h = await handlers['conversation-archive-has'](ev, {});
  assert.strictEqual(h.exists, false);
});

test('flushAll 刷新所有已创建实例', () => {
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  const ipc = createArchiveIpc(fakeIpc, fakeWindowState, tmpDir());
  assert.strictEqual(typeof ipc.flushAll, 'function');
  assert.strictEqual(ipc.flushAll(), true);
});
