'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rot = require('../../src/main/token-rotation');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'token-rotation-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  rot.init(tmpDir);
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('默认配置：关闭、阈值 10 万、上限 2MB', () => {
  const c = rot.getConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.thresholdWan, 10);
  assert.equal(c.historyMaxBytes, 2097152);
  assert.equal(c.maxRotations, 5);
  assert.equal(c.maxSessionHours, 4);
  assert.equal(c.preferDifferentAccount, true);
  assert.equal(c.targetBusyWaitMs, 60000);
  assert.deepEqual(c.pool, []);
  assert.equal(c.cursor, 0);
});

test('updateConfig 局部合并并落盘', () => {
  rot.updateConfig({ enabled: true, thresholdWan: 15 });
  const c = rot.getConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.thresholdWan, 15);
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'token-rotation.json'), 'utf-8'));
  assert.equal(raw.thresholdWan, 15);
});

test('updateConfig 归一化非法值', () => {
  rot.updateConfig({ thresholdWan: -3, maxRotations: 'abc', historyMaxBytes: 0 });
  const c = rot.getConfig();
  assert.equal(c.thresholdWan, 10, '负数回落默认');
  assert.equal(c.maxRotations, 5, '非数字回落默认');
  assert.equal(c.historyMaxBytes, 2097152, '0 回落默认');
});

test('resetState 把 cursor 归零并清计数器', () => {
  rot.updateConfig({ cursor: 2 });
  rot.resetState();
  assert.equal(rot.getConfig().cursor, 0);
});

test('配置损坏时回落默认值不抛错', () => {
  fs.writeFileSync(path.join(tmpDir, 'token-rotation.json'), '{broken', 'utf-8');
  rot.init(tmpDir);
  assert.equal(rot.getConfig().thresholdWan, 10);
});
