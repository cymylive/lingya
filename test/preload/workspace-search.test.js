const { test } = require('node:test');
const assert = require('node:assert');
const { filterSessions } = require('../../src/preload/shell-renderer-helpers');

const sample = [
  { sessionId: 's1', projectDir: 'D:/projects/lingya', title: '修复登录' },
  { sessionId: 's2', projectDir: 'D:/projects/blog', title: '写文章' },
  { sessionId: 's3', projectDir: 'D:/projects/lingya', title: '优化性能' },
];

test('按项目路径过滤', () => {
  const r = filterSessions(sample, 'lingya');
  assert.strictEqual(r.length, 2);
});

test('按会话标题过滤', () => {
  const r = filterSessions(sample, '登录');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sessionId, 's1');
});

test('大小写不敏感', () => {
  assert.strictEqual(filterSessions(sample, 'LINGYA').length, 2);
});

test('空关键词返回全部', () => {
  assert.strictEqual(filterSessions(sample, '').length, 3);
});

test('正则特殊字符按字面匹配不抛异常', () => {
  assert.strictEqual(filterSessions(sample, '.*').length, 0);
  assert.strictEqual(filterSessions(sample, '[').length, 0);
  assert.strictEqual(filterSessions(sample, '\\').length, 0);
});

test('无匹配返回空数组', () => {
  assert.strictEqual(filterSessions(sample, 'zzzzz').length, 0);
});

test('非数组输入返回空数组', () => {
  assert.deepStrictEqual(filterSessions(null, 'x'), []);
});
