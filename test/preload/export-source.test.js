const { test } = require('node:test');
const assert = require('node:assert');
const { resolveExportEntries } = require('../../src/preload/dom/export-source');

test('存档优先于 IndexedDB', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [{ role: 'user', text: '存档', ts: 1 }] }),
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'archive');
  assert.strictEqual(r.entries[0].text, '存档');
});

test('存档为空时回退到 IndexedDB', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [] }),
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'indexeddb');
  assert.strictEqual(r.entries[0].text, 'IDB');
});

test('两者都空时返回 empty 且带提示文案', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [] }),
    readIndexedDB: async () => [],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'empty');
  assert.strictEqual(r.entries.length, 0);
  assert.strictEqual(r.message, '该会话暂无对话内容');
});

test('存档读取抛错时回退到 IndexedDB 而不是整体失败', async () => {
  const deps = {
    readArchive: async () => { throw new Error('disk error'); },
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'indexeddb');
});

test('IndexedDB 读取抛错时返回 empty 而不是崩溃', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [] }),
    readIndexedDB: async () => { throw new Error('idb error'); },
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'empty');
});

test('缺 sessionId 时返回 empty', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [{ role: 'user', text: 'x', ts: 1 }] }),
    readIndexedDB: async () => [],
  };
  const r = await resolveExportEntries('', deps);
  assert.strictEqual(r.source, 'empty');
});
