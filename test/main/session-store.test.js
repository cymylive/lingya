'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSessionStore } = require('../../src/main/session-store');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'session-store-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(profileId = 'p1') {
  const mockWindowState = {
    getMainWindow: () => null,
  };
  return createSessionStore(profileId, tmpDir, mockWindowState);
}

test('extractSessionIdFromUrl 标准 URL', () => {
  const store = makeStore();
  const url = 'https://chat.deepseek.com/a/chat/s/bd9953b8-ff70-4207-9a12-5967be02a066';
  assert.strictEqual(store.extractSessionIdFromUrl(url), 'bd9953b8-ff70-4207-9a12-5967be02a066');
});

test('extractSessionIdFromUrl /s/ 备选', () => {
  const store = makeStore();
  // 平台差异下沉到 provider.extractSessionId，需用已识别平台的 URL
  assert.strictEqual(store.extractSessionIdFromUrl('https://chat.deepseek.com/s/abc123'), 'abc123');
});

test('extractSessionIdFromUrl 未识别平台返回 null', () => {
  const store = makeStore();
  assert.strictEqual(store.extractSessionIdFromUrl('https://x.com/s/abc123'), null);
});

test('extractSessionIdFromUrl 无会话返回 null', () => {
  const store = makeStore();
  assert.strictEqual(store.extractSessionIdFromUrl('https://chat.deepseek.com/'), null);
  assert.strictEqual(store.extractSessionIdFromUrl(null), null);
  assert.strictEqual(store.extractSessionIdFromUrl(''), null);
});

test('readSessionStore 不存在返回空对象', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.readSessionStore(), {});
});

test('write/readSessionStore 往返', () => {
  const store = makeStore();
  store.writeSessionStore({ a: 'dir1' });
  assert.deepStrictEqual(store.readSessionStore(), { a: 'dir1' });
});

test('saveSessionDirMapping / getProjectDirBySessionId', () => {
  const store = makeStore();
  store.saveSessionDirMapping('id1', 'C:/proj');
  assert.strictEqual(store.getProjectDirBySessionId('id1'), 'C:/proj');
  assert.strictEqual(store.getProjectDirBySessionId('missing'), null);
  assert.strictEqual(store.getProjectDirBySessionId(null), null);
});

test('saveSessionDirMapping 空 sessionId 不保存', () => {
  const store = makeStore();
  store.saveSessionDirMapping('', 'C:/proj');
  assert.deepStrictEqual(store.readSessionStore(), {});
});

test('state 初始值', () => {
  const store = makeStore();
  assert.strictEqual(store.state.currentSessionId, null);
  assert.strictEqual(store.state.selectedProjectDir, null);
  assert.strictEqual(store.state.pendingProjectDir, null);
});

test('不同 profile 的存储文件互相隔离', () => {
  const s1 = makeStore('p1');
  const s2 = makeStore('p2');
  s1.saveSessionDirMapping('sess-1', 'C:/proj1');
  s2.saveSessionDirMapping('sess-1', 'C:/proj2');
  assert.strictEqual(s1.getProjectDirBySessionId('sess-1'), 'C:/proj1');
  assert.strictEqual(s2.getProjectDirBySessionId('sess-1'), 'C:/proj2');
});

test('handleUrlChange 非会话清空状态', () => {
  const sent = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, data) => sent.push([ch, data]) } };
  const store = createSessionStore('p1', tmpDir, { getMainWindow: () => fakeWin });
  store.state.currentSessionId = 'old';
  store.state.selectedProjectDir = 'C:/old';
  store.handleUrlChange('https://chat.deepseek.com/', fakeWin);
  assert.strictEqual(store.state.currentSessionId, null);
  assert.strictEqual(store.state.selectedProjectDir, null);
  assert.ok(sent.some(([ch]) => ch === 'project-dir-updated'));
});

test('handleUrlChange 恢复已保存目录', () => {
  const sent = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, data) => sent.push([ch, data]) } };
  const store = createSessionStore('p1', tmpDir, { getMainWindow: () => fakeWin });
  store.saveSessionDirMapping('abc123', 'C:/proj');
  store.handleUrlChange('https://chat.deepseek.com/a/chat/s/abc123', fakeWin);
  assert.strictEqual(store.state.currentSessionId, 'abc123');
  assert.strictEqual(store.state.selectedProjectDir, 'C:/proj');
  assert.ok(sent.some(([ch]) => ch === 'session-restored'));
  assert.ok(sent.some(([ch]) => ch === 'project-dir-updated'));
});
