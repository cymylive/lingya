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

test('默认配置包含自动续写字段且默认关闭', () => {
  const cfg = store.getPublicConfig();
  assert.strictEqual(cfg.autoContinueEnabled, false);
  assert.ok(typeof cfg.autoContinueText === 'string' && cfg.autoContinueText.length > 0);
});

test('updateConfig 可开启自动续写并自定义文本', () => {
  const out = store.updateConfig({ autoContinueEnabled: true, autoContinueText: '继续吧' });
  assert.strictEqual(out.autoContinueEnabled, true);
  assert.strictEqual(out.autoContinueText, '继续吧');
});

test('updateConfig 自动续写开关仅接受严格 true', () => {
  store.updateConfig({ autoContinueEnabled: true });
  assert.strictEqual(store.getConfig().autoContinueEnabled, true);
  store.updateConfig({ autoContinueEnabled: false });
  assert.strictEqual(store.getConfig().autoContinueEnabled, false);
  // 非布尔真值视为关闭（与其它开关字段语义一致）
  store.updateConfig({ autoContinueEnabled: 1 });
  assert.strictEqual(store.getConfig().autoContinueEnabled, false);
});

test('autoContinueText 非字符串被转为字符串', () => {
  store.updateConfig({ autoContinueText: 123 });
  assert.strictEqual(store.getConfig().autoContinueText, '123');
});

test('配置持久化到磁盘并可重载', () => {
  store.updateConfig({ autoContinueEnabled: true, autoContinueText: '持久化测试' });
  // 重新 init 清缓存，强制从磁盘读取
  store.init(tmpDir);
  const cfg = store.getConfig();
  assert.strictEqual(cfg.autoContinueEnabled, true);
  assert.strictEqual(cfg.autoContinueText, '持久化测试');
});

test('resetConfig 恢复默认（自动续写关闭）', () => {
  store.updateConfig({ autoContinueEnabled: true });
  store.resetConfig();
  assert.strictEqual(store.getConfig().autoContinueEnabled, false);
});
