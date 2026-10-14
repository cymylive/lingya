'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanStaleInstances } = require('../../src/main/data-dir.js');

test('cleanStaleInstances 删除超期的 auto-* 目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-inst-'));
  const inst = path.join(base, 'instances');
  fs.mkdirSync(inst, { recursive: true });
  // 旧目录（8 天前）
  const oldDir = path.join(inst, 'auto-11111');
  fs.mkdirSync(oldDir);
  const past = Date.now() - 8*24*60*60*1000;
  fs.utimesSync(oldDir, past/1000, past/1000);
  // 新目录
  fs.mkdirSync(path.join(inst, 'auto-22222'));
  // 具名实例（不应删）
  fs.mkdirSync(path.join(inst, 'work'));
  const removed = cleanStaleInstances(base, 7*24*60*60*1000, fs);
  assert.strictEqual(removed, 1, '应删除 1 个旧 auto 目录');
  assert.ok(!fs.existsSync(oldDir), '旧 auto 目录已删');
  assert.ok(fs.existsSync(path.join(inst, 'auto-22222')), '新 auto 目录保留');
  assert.ok(fs.existsSync(path.join(inst, 'work')), '具名实例保留');
  fs.rmSync(base, { recursive: true, force: true });
});

test('cleanStaleInstances 目录不存在返回 0', () => {
  assert.strictEqual(cleanStaleInstances('C:/no/such/dir/xyz123', 1000, fs), 0);
});
