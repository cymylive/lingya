'use strict';
/**
 * 插件打包器 external 回归测试
 *
 * 事故背景：graphify-proactive 插件在 index.js 里 require('electron')，
 * 但 dsh/loader.js 的 esbuild 配置没把 electron 设为 external，
 * 导致打包失败（Could not resolve "electron"）→ 插件加载不了 → gq_* 工具全不可用。
 *
 * electron 是运行时注入的，必须在打包时标记为 external。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bundlePlugin } = require('../../src/main/dsh/loader');

test('bundlePlugin 允许插件 require("electron")（应标记 external）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-bundle-test-'));
  const entry = path.join(tmpDir, 'index.js');
  fs.writeFileSync(entry, `
const { app } = require('electron');
export function apply(ctx) {
  ctx.log('electron app: ' + (app ? 'ok' : 'missing'));
}
`);
  try {
    const code = await bundlePlugin(entry);
    assert.ok(typeof code === 'string' && code.length > 0, '必须能打包出代码');
    assert.ok(code.includes('electron'), 'electron 的 require 应保留在产物里');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bundlePlugin 允许插件 require("child_process") 等 Node 内置模块', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-bundle-test-'));
  const entry = path.join(tmpDir, 'index.js');
  fs.writeFileSync(entry, `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
export function apply(ctx) { ctx.log('ok'); }
`);
  try {
    const code = await bundlePlugin(entry);
    assert.ok(typeof code === 'string' && code.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
