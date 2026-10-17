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
  assert.ok(sent.some(([ch]) => ch === 'project-dir-updated'), '应发送 project-dir-updated');
});

// ===== setSessionTitleById（会话列表手动重命名）=====

test('setSessionTitleById 改指定会话标题并保留 projectDir', () => {
  const store = makeStore();
  store.writeSessionStore({
    'sess-a': { projectDir: 'C:/proj', title: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  });
  const r = store.setSessionTitleById('sess-a', '  新标题  ');
  assert.deepStrictEqual(r, { success: true, sessionId: 'sess-a' });
  const e = store.readSessionStore()['sess-a'];
  assert.strictEqual(e.title, '新标题');
  assert.strictEqual(e.projectDir, 'C:/proj', 'projectDir 不应被破坏');
  assert.ok(e.updatedAt, 'updatedAt 应被刷新');
});

test('setSessionTitleById 空标题返回失败', () => {
  const store = makeStore();
  store.writeSessionStore({ 'sess-a': { projectDir: 'C:/p', title: 'old' } });
  const r = store.setSessionTitleById('sess-a', '   ');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, '标题为空');
  assert.strictEqual(store.readSessionStore()['sess-a'].title, 'old', '空标题不应改动存储');
});

test('setSessionTitleById 不传 sessionId 退回 setSessionTitle（无当前会话时暂存）', () => {
  const store = makeStore();
  const r = store.setSessionTitleById(null, '待定');
  assert.deepStrictEqual(r, { success: true, pending: true });
  assert.strictEqual(store.state.pendingTitle, '待定');
});

test('setSessionTitleById 广播 session-title-updated', () => {
  const sent = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, data) => sent.push([ch, data]) } };
  const store = createSessionStore('p1', tmpDir, { getMainWindow: () => fakeWin });
  store.writeSessionStore({ 'sess-b': { projectDir: 'C:/p', title: 'old' } });
  store.setSessionTitleById('sess-b', '新名');
  const hit = sent.find(([ch]) => ch === 'session-title-updated');
  assert.ok(hit, '应发送 session-title-updated');
  assert.deepStrictEqual(hit[1], { sessionId: 'sess-b', title: '新名' });
});
