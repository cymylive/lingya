'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const memoryStore = require('../../src/main/memory-store');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-idx-'));
  memoryStore.init(dir);
  return dir;
}

test('空记忆 → 返回占位', () => {
  freshStore();
  assert.match(memoryStore.buildMemorySection({}), /暂无长期记忆/);
});

test('记忆不超预算 → 无索引段，但仍有判断标准', () => {
  freshStore();
  memoryStore.saveMemory({ type: 'user', name: '偏好', content: '喜欢简洁' });
  const block = memoryStore.buildMemorySection({});
  assert.match(block, /偏好/);
  assert.ok(!block.includes('全部记忆索引'));
  assert.match(block, /先调用 memoryList/);
});

test('记忆超预算 → 附全部记忆索引（含未选中条目名）', () => {
  freshStore();
  memoryStore.saveMemory({ type: 'reference', name: 'GitHub Token', content: 'ghp_x', pinned: true });
  for (let i = 1; i <= 40; i++) {
    memoryStore.saveMemory({ type: 'reference', name: '记忆' + i, content: 'x'.repeat(200), tags: ['t' + i] });
  }
  const block = memoryStore.buildMemorySection({});
  assert.match(block, /全部记忆索引/);
  assert.match(block, /GitHub Token/);
  assert.match(block, /先调用 memoryList/);
});

test('已选中的记忆不在索引段重复出现', () => {
  freshStore();
  memoryStore.saveMemory({ type: 'user', name: '唯一条目XYZ', content: 'c', pinned: true });
  const block = memoryStore.buildMemorySection({});
  const idxPos = block.indexOf('全部记忆索引');
  if (idxPos >= 0) {
    assert.ok(!block.slice(idxPos).includes('唯一条目XYZ'));
  }
});
