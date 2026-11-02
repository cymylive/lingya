'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * QQ/微信 bridge 启用状态获取链路测试。
 *
 * 回归背景（2026-11-01）：
 *   qq-bridge 原来用 getQqConfig() 拿 enabled，走的是 'qq-get-config' 通道。
 *   该通道在 ipc-guard.js 的 SENSITIVE_CHANNELS 白名单里，只允许 file:// 来源。
 *   AI 页面（https://chat.deepseek.com/）调用被拒 → enabled 恒为 false
 *   → onInterceptedResponse 第一行 if (!enabled) return → AI 回复不上报 → 不回传 QQ。
 *
 * 修复要求：
 *   1. preload 必须暴露一个轻量的 getQqEnabled（走非敏感通道 qq-is-enabled）
 *   2. qq-bridge 必须用 getQqEnabled，不得再用 getQqConfig
 *   3. weixin-bridge 用 getWeixinEnabled（已有，作为对称参照）
 */

const ROOT = path.join(__dirname, '..', '..');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const API = stripComments(fs.readFileSync(path.join(ROOT, 'src/preload/api.js'), 'utf8'));
const QQ_BRIDGE = stripComments(fs.readFileSync(path.join(ROOT, 'src/preload/dom/qq-bridge.js'), 'utf8'));
const WX_BRIDGE = stripComments(fs.readFileSync(path.join(ROOT, 'src/preload/dom/weixin-bridge.js'), 'utf8'));

test('api.js 必须暴露 getQqEnabled，走 qq-is-enabled 通道', () => {
  assert.match(API, /getQqEnabled:/, 'api.js 必须有 getQqEnabled 方法');
  assert.match(API, /qq-is-enabled/, 'getQqEnabled 必须调用 qq-is-enabled 通道');
});

test('qq-bridge 不得再用 getQqConfig 拿启用状态', () => {
  assert.ok(
    !/getQqConfig/.test(QQ_BRIDGE),
    'qq-bridge 必须改用 getQqEnabled；getQqConfig 走敏感通道会被 IPC-Guard 拒绝'
  );
});

test('qq-bridge 必须调用 getQqEnabled', () => {
  assert.match(QQ_BRIDGE, /getQqEnabled/, 'qq-bridge 必须调用 getQqEnabled');
});

test('微信 bridge 必须用 getWeixinEnabled（对称参照）', () => {
  assert.match(WX_BRIDGE, /getWeixinEnabled/, 'weixin-bridge 必须用 getWeixinEnabled');
});

test('qq-is-enabled 不得出现在 ipc-guard 敏感白名单里', () => {
  const GUARD = fs.readFileSync(path.join(ROOT, 'src/main/ipc-guard.js'), 'utf8');
  assert.ok(
    !/'qq-is-enabled'/.test(GUARD),
    'qq-is-enabled 只返回布尔值，不该被列为敏感通道'
  );
});
