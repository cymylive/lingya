'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../../src/main/security-store');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'security-store-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  store.init(tmpDir);
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('disableGpu: 默认值为 false（开启硬件加速）', () => {
  const cfg = store.getConfig();
  assert.strictEqual(cfg.disableGpu, false);
});

test('disableGpu: 传 true 保存为 true', () => {
  store.updateConfig({ disableGpu: true });
  assert.strictEqual(store.getConfig().disableGpu, true);
});

test('disableGpu: 传 false 保存为 false', () => {
  store.updateConfig({ disableGpu: true });
  store.updateConfig({ disableGpu: false });
  assert.strictEqual(store.getConfig().disableGpu, false);
});

test('disableGpu: 传非 boolean 一律归一化为 false', () => {
  store.updateConfig({ disableGpu: true });
  store.updateConfig({ disableGpu: 'yes' });
  assert.strictEqual(store.getConfig().disableGpu, false);
  store.updateConfig({ disableGpu: 1 });
  assert.strictEqual(store.getConfig().disableGpu, false);
  store.updateConfig({ disableGpu: null });
  assert.strictEqual(store.getConfig().disableGpu, false);
});

test('disableGpu: 持久化后重新读取仍保持', () => {
  store.updateConfig({ disableGpu: true });
  const raw = JSON.parse(fs.readFileSync(store.getStoreFile(), 'utf-8'));
  assert.strictEqual(raw.disableGpu, true);
});

test('disableGpu: 不影响其他字段', () => {
  store.updateConfig({ promptChunkSize: 20000 });
  store.updateConfig({ disableGpu: true });
  const cfg = store.getConfig();
  assert.strictEqual(cfg.disableGpu, true);
  assert.strictEqual(cfg.promptChunkSize, 20000);
});




