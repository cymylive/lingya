/**
 * 分片大小可配置化测试
 *
 * 需求：用户要能在设置面板调整「初始提示分片大小」，
 * 而不是每次改都要动源码重新打包。
 *
 * 链路：设置面板输入 → security-store.updateConfig → project-context.initProject 读取 → 分片
 * 本测试覆盖中间两环的关键约束。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECURITY_STORE = path.join(__dirname, '..', '..', 'src', 'main', 'security-store.js');
const PROJECT_CONTEXT = path.join(__dirname, '..', '..', 'src', 'main', 'project-context.js');

function freshStore() {
  // 每个用例用独立临时目录，避免互相污染
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-chunkcfg-'));
  delete require.cache[require.resolve(SECURITY_STORE)];
  const store = require(SECURITY_STORE);
  store.init(dir);
  return store;
}

test('默认分片大小为 15000', () => {
  const store = freshStore();
  assert.strictEqual(store.DEFAULT_CONFIG.promptChunkSize, 15000);
  assert.strictEqual(store.getConfig().promptChunkSize, 15000);
});

test('可设置为 8000 并读回', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 8000 });
  assert.strictEqual(store.getConfig().promptChunkSize, 8000);
});

test('可设置为 30000（超过 normalizePositiveInt 的 10000 上限也不被截断）', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 30000 });
  // 关键：不能用 normalizePositiveInt（上限 10000），否则这里会变成 10000
  assert.strictEqual(store.getConfig().promptChunkSize, 30000);
});

test('低于 2000 被抬到 2000（太小会切出上百段）', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 500 });
  assert.strictEqual(store.getConfig().promptChunkSize, 2000);
});

test('高于 100000 被压到 100000（再大平台必拒收）', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 999999 });
  assert.strictEqual(store.getConfig().promptChunkSize, 100000);
});

test('空字符串回退到默认值', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 8000 });
  store.updateConfig({ promptChunkSize: '' });
  assert.strictEqual(store.getConfig().promptChunkSize, 15000);
});

test('非法值（NaN / 非数字）回退到默认值', () => {
  const store = freshStore();
  store.updateConfig({ promptChunkSize: 'abc' });
  assert.strictEqual(store.getConfig().promptChunkSize, 15000);
});

test('project-context 必须从配置读 chunkSize 而非只用硬编码常量', () => {
  const src = fs.readFileSync(PROJECT_CONTEXT, 'utf-8');
  assert.ok(/cfg\.promptChunkSize/.test(src), '未从配置读取 promptChunkSize');
  assert.ok(/splitPromptIntoChunks\(combined, chunkSize/.test(src), '未把配置值传给分片函数');
});

test('配置值真的影响分片结果（端到端）', () => {
  const { splitPromptIntoChunks } = require(PROJECT_CONTEXT);
  const text = ('# 段\n' + 'x'.repeat(2000) + '\n\n').repeat(20);  // 约 4 万字符
  const small = splitPromptIntoChunks(text, 5000, 40);
  const large = splitPromptIntoChunks(text, 20000, 40);
  assert.ok(small.length > large.length,
    'chunkSize 调小后段数应增多：small=' + small.length + ', large=' + large.length);
  // 两种设置下每段都必须不超各自的上限
  for (const c of small) assert.ok(c.length <= 5000);
  for (const c of large) assert.ok(c.length <= 20000);
});
