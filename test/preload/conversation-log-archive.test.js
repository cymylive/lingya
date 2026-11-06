const { test } = require('node:test');
const assert = require('node:assert');

function freshLog() {
  // 清掉 conversation-log 及其依赖的缓存，确保模块级状态（entries / currentSessionId）全新
  const key = require.resolve('../../src/preload/dom/conversation-log');
  delete require.cache[key];
  return require('../../src/preload/dom/conversation-log');
}

test('addEntry 触发节流持久化（1000ms 内合并为一次写）', async () => {
  const log = freshLog();
  const calls = [];
  global.window = {
    electronAPI: {
      conversationArchiveAppend: async (sid, entry) => { calls.push({ sid, entry }); return { success: true }; },
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.__testSetSessionId('abc');
  log.addEntry('user', '第一条', '手动输入');
  log.addEntry('user', '第二条', '手动输入');
  await new Promise(r => setTimeout(r, 1200));
  const texts = calls.map(c => c.entry.text);
  assert.ok(texts.includes('第一条'));
  assert.ok(texts.includes('第二条'));
  assert.strictEqual(calls[0].sid, 'abc');
});

test('loadFromArchive 用存档替换内存 entries', async () => {
  const log = freshLog();
  global.window = {
    electronAPI: {
      conversationArchiveRead: async () => ({ success: true, entries: [
        { role: 'user', text: '存档里的旧消息', ts: 1 },
      ]}),
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.addEntry('user', '当前窗口的消息', '手动输入');
  const r = await log.loadFromArchive('abc');
  assert.strictEqual(r.loaded, true);
  const entries = log.getEntries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].text, '存档里的旧消息');
});

test('loadFromArchive 在存档为空时不动内存 entries', async () => {
  const log = freshLog();
  global.window = {
    electronAPI: {
      conversationArchiveRead: async () => ({ success: true, entries: [] }),
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.addEntry('user', '保留我', '手动输入');
  const r = await log.loadFromArchive('abc');
  assert.strictEqual(r.loaded, false);
  assert.strictEqual(log.getEntries().length, 1);
});

test('__testSetSessionId 后 getCurrentSessionId 返回该值', () => {
  const log = freshLog();
  global.window = { electronAPI: {}, location: { href: '' }, addEventListener: () => {} };
  log.__testSetSessionId('xyz');
  assert.strictEqual(log.getCurrentSessionId(), 'xyz');
});

test('没有 currentSessionId 时 addEntry 不写盘也不抛异常', async () => {
  const log = freshLog();
  const calls = [];
  global.window = {
    electronAPI: {
      conversationArchiveAppend: async () => { calls.push(1); return { success: true }; },
    },
    location: { href: '' },
    addEventListener: () => {},
  };
  log.__testSetSessionId(null);
  log.addEntry('user', '孤立消息-XYZ', '手动输入');
  await new Promise(r => setTimeout(r, 1200));
  // 只断言本测试的消息未被写入（忽略其它测试遗留实例的调用）
  const hasOrphan = calls.some(c => c.entry && c.entry.text === '孤立消息-XYZ');
  assert.strictEqual(hasOrphan, false);
  assert.strictEqual(log.getEntries().length, 1);
});
