const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConversationArchive } = require('../../src/main/conversation-archive');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-archive-')); }

test('appendEntry 后可 readEntries 读回', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  a.appendEntry('s1', { role: 'user', text: '你好', ts: 1 });
  a.appendEntry('s1', { role: 'assistant', text: '你也好', ts: 2 });
  a.flush();
  const r = a.readEntries('s1');
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].text, '你好');
  assert.strictEqual(r.entries[1].role, 'assistant');
});

test('readEntries 对不存在的会话返回空数组', () => {
  const a = createConversationArchive('p1', tmpDir());
  const r = a.readEntries('nope');
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.entries, []);
});

test('hasArchive 判断存档是否存在', () => {
  const a = createConversationArchive('p1', tmpDir());
  assert.strictEqual(a.hasArchive('s1'), false);
  a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  a.flush();
  assert.strictEqual(a.hasArchive('s1'), true);
});

test('不同 profile 的存档互相隔离', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  const b = createConversationArchive('p2', dir);
  a.appendEntry('s1', { role: 'user', text: 'p1 的消息', ts: 1 });
  a.flush();
  assert.strictEqual(b.hasArchive('s1'), false);
});

test('deleteArchive 删除存档文件', () => {
  const a = createConversationArchive('p1', tmpDir());
  a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  a.flush();
  const r = a.deleteArchive('s1');
  assert.strictEqual(r.success, true);
  assert.strictEqual(a.hasArchive('s1'), false);
});

test('损坏的 jsonl 行被跳过，其余行仍可读', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  a.appendEntry('s1', { role: 'user', text: 'ok1', ts: 1 });
  a.flush();
  const f = path.join(dir, 'conversations', 'p1', 's1.jsonl');
  fs.appendFileSync(f, 'NOT_JSON\n', 'utf-8');
  const r = a.readEntries('s1');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].text, 'ok1');
});

test('目录不可写时 appendEntry 返回失败而不抛异常', () => {
  const a = createConversationArchive('p1', 'Z:/definitely/not/exist/xyz');
  const r = a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});
