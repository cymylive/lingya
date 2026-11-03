'use strict';
/**
 * 插件播种升级逻辑测试
 *
 * 场景事故：老用户已安装旧版 core-rules 插件（1.x），升级到新版安装包后，
 * 播种逻辑因为「目标目录已存在」只补齐缺失文件，导致旧版插件代码永远不更新。
 *
 * 修复：比较 manifest.json 的 version，内置版本更高时强制覆盖整个目录。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pluginHost = require('../../src/main/plugin-host');

function writePlugin(dir, id, version, extraFiles) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version }, null, 2));
  const files = Object.assign({ 'index.js': '// v' + version }, extraFiles || {});
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function readPluginVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
}

let tmpRoot;
let srcDir;
let userPluginsDir;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-seed-test-'));
  srcDir = path.join(tmpRoot, 'src-plugins');
  userPluginsDir = path.join(tmpRoot, 'user-data', 'plugins');
  fs.mkdirSync(srcDir, { recursive: true });
  // 让 PLUGINS_DIR 指向临时目录，避免污染真实 userData
  pluginHost.init(path.join(tmpRoot, 'user-data'));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

test('compareVersion 语义化比较', () => {
  assert.strictEqual(pluginHost.compareVersion('1.0.0', '1.0.0'), 0);
  assert.strictEqual(pluginHost.compareVersion('2.0.0', '1.1.0'), 1);
  assert.strictEqual(pluginHost.compareVersion('1.1.0', '2.0.0'), -1);
  assert.strictEqual(pluginHost.compareVersion('1.10.0', '1.9.0'), 1);
  assert.strictEqual(pluginHost.compareVersion('1.0', '1.0.0'), 0);
  assert.strictEqual(pluginHost.compareVersion(null, null), 0);
});

test('目标不存在时全量复制', () => {
  writePlugin(path.join(srcDir, 'test-a'), 'test-a', '1.0.0');
  pluginHost.seedBundledPlugins(srcDir);
  const dst = path.join(userPluginsDir, 'test-a');
  assert.ok(fs.existsSync(path.join(dst, 'manifest.json')));
  assert.strictEqual(readPluginVersion(dst), '1.0.0');
});

test('内置版本更高时强制覆盖', () => {
  const dst = path.join(userPluginsDir, 'test-b');
  writePlugin(dst, 'test-b', '1.0.0', { 'index.js': '// OLD CODE', 'user-edit.js': '// 用户自己加的' });
  writePlugin(path.join(srcDir, 'test-b'), 'test-b', '2.0.0', { 'index.js': '// NEW CODE', 'panel.js': '// 新增文件' });

  pluginHost.seedBundledPlugins(srcDir);

  assert.strictEqual(readPluginVersion(dst), '2.0.0', '版本必须升级到 2.0.0');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'index.js'), 'utf8'), '// NEW CODE', '旧代码必须被覆盖');
  assert.ok(fs.existsSync(path.join(dst, 'panel.js')), '新文件必须存在');
});

test('版本相同只补齐缺失文件，不覆盖已有文件', () => {
  const dst = path.join(userPluginsDir, 'test-c');
  writePlugin(dst, 'test-c', '1.5.0', { 'index.js': '// USER MODIFIED' });
  writePlugin(path.join(srcDir, 'test-c'), 'test-c', '1.5.0', { 'index.js': '// BUNDLED', 'new-file.js': '// 新增' });

  pluginHost.seedBundledPlugins(srcDir);

  assert.strictEqual(fs.readFileSync(path.join(dst, 'index.js'), 'utf8'), '// USER MODIFIED', '用户改动必须保留');
  assert.ok(fs.existsSync(path.join(dst, 'new-file.js')), '缺失文件必须补齐');
});

test('用户目录版本更高时不降级', () => {
  const dst = path.join(userPluginsDir, 'test-d');
  writePlugin(dst, 'test-d', '3.0.0', { 'index.js': '// USER FUTURE VERSION' });
  writePlugin(path.join(srcDir, 'test-d'), 'test-d', '2.0.0');

  pluginHost.seedBundledPlugins(srcDir);

  assert.strictEqual(readPluginVersion(dst), '3.0.0', '用户版本更高时不应降级');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'index.js'), 'utf8'), '// USER FUTURE VERSION');
});
