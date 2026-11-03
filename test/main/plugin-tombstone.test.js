'use strict';
/**
 * 内置插件墓碑机制测试（Red 阶段）
 *
 * 覆盖：
 * 1. plugin-store 墓碑 API：markDeleted / isDeleted / clearDeleted / listDeleted
 * 2. 墓碑不破坏同一记录里的 enabled / pinned / config
 * 3. seedBundledPlugins 跳过带墓碑的插件（重启不复活）
 * 4. deletePlugin：内置插件写墓碑并保留 config；非内置插件走 removeRecord
 * 5. restoreBundledPlugins：源目录缺失时失败且不清墓碑；正常时重建目录并清墓碑
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pluginHost = require('../../src/main/plugin-host');
const pluginStore = require('../../src/main/plugin-store');

let tmpRoot;
let srcDir;
let userDataDir;
let pluginsDir;

function writePlugin(dir, id, version, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: version || '1.0.0', entry: 'index.js' }, null, 2)
  );
  const all = Object.assign({ 'index.js': '// ' + id + ' v' + (version || '1.0.0') }, files || {});
  for (const [name, content] of Object.entries(all)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** 每个用例前重建干净环境 */
function resetEnv() {
  try { pluginHost.stopWatching(); } catch (_) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(userDataDir, { recursive: true });
  pluginStore.init(userDataDir);
  pluginHost.init(userDataDir);
  // init 内部会按默认源目录播种；这里显式用临时源目录重置一次
  pluginHost.seedBundledPlugins(srcDir);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-tombstone-test-'));
  srcDir = path.join(tmpRoot, 'src-plugins');
  userDataDir = path.join(tmpRoot, 'user-data');
  pluginsDir = path.join(userDataDir, 'plugins');
  fs.mkdirSync(srcDir, { recursive: true });
});

after(() => {
  try { pluginHost.stopWatching(); } catch (_) {}
  try { pluginHost.resetBundledSourceOverride(); } catch (_) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

// ---------- plugin-store 墓碑 API ----------

test('markDeleted：写墓碑且保留 enabled / pinned / config', () => {
  resetEnv();
  pluginStore.setEnabled('demo', true);
  pluginStore.setPinned('demo', true);
  pluginStore.savePluginConfig('demo', { keep: 'me' });

  const r = pluginStore.markDeleted('demo');
  assert.strictEqual(r, true);
  assert.strictEqual(pluginStore.isDeleted('demo'), true, '应标记为已删除');
  assert.strictEqual(pluginStore.isEnabled('demo', true), true, 'enabled 不得被清除');
  assert.strictEqual(pluginStore.isPinned('demo'), true, 'pinned 不得被清除');
  assert.deepStrictEqual(pluginStore.getPluginConfig('demo'), { keep: 'me' }, 'config 不得被清除');
});

test('markDeleted：不存在的记录也能写入墓碑', () => {
  resetEnv();
  assert.strictEqual(pluginStore.isDeleted('ghost'), false);
  pluginStore.markDeleted('ghost');
  assert.strictEqual(pluginStore.isDeleted('ghost'), true);
});

test('listDeleted：返回全部墓碑 id', () => {
  resetEnv();
  pluginStore.markDeleted('a');
  pluginStore.markDeleted('b');
  const ids = pluginStore.listDeleted().slice().sort();
  assert.deepStrictEqual(ids, ['a', 'b']);
});

test('clearDeleted：清空墓碑但保留 config / enabled', () => {
  resetEnv();
  pluginStore.markDeleted('a');
  pluginStore.savePluginConfig('a', { x: 1 });
  pluginStore.markDeleted('b');

  pluginStore.clearDeleted();

  assert.deepStrictEqual(pluginStore.listDeleted(), [], '所有墓碑应被清除');
  assert.deepStrictEqual(pluginStore.getPluginConfig('a'), { x: 1 }, 'config 应保留');
});

// ---------- 播种跳过墓碑 ----------

test('seedBundledPlugins：跳过带墓碑的内置插件', () => {
  resetEnv();
  writePlugin(path.join(srcDir, 'plug-a'), 'plug-a', '1.0.0');
  writePlugin(path.join(srcDir, 'plug-b'), 'plug-b', '1.0.0');

  // 首次播种：两个都到位
  pluginHost.seedBundledPlugins(srcDir);
  assert.ok(fs.existsSync(path.join(pluginsDir, 'plug-a')));
  assert.ok(fs.existsSync(path.join(pluginsDir, 'plug-b')));

  // 模拟用户删除 plug-a：删目录 + 打墓碑
  pluginStore.markDeleted('plug-a');
  fs.rmSync(path.join(pluginsDir, 'plug-a'), { recursive: true, force: true });

  // 再次播种（等价重启）
  pluginHost.seedBundledPlugins(srcDir);

  assert.ok(!fs.existsSync(path.join(pluginsDir, 'plug-a')), '带墓碑的插件不得被重新播种');
  assert.ok(fs.existsSync(path.join(pluginsDir, 'plug-b')), '无墓碑的插件照常播种');
});

// ---------- deletePlugin 分支 ----------

test('deletePlugin：内置插件写墓碑、删目录、保留 config', () => {
  resetEnv();
  writePlugin(path.join(srcDir, 'builtin-x'), 'builtin-x', '1.0.0');
  pluginHost.seedBundledPlugins(srcDir);
  const dir = path.join(pluginsDir, 'builtin-x');
  assert.ok(fs.existsSync(dir));

  pluginStore.savePluginConfig('builtin-x', { rules: [{ id: 'r1', content: 'keep' }] });

  const res = pluginHost.deletePlugin('builtin-x');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.bundled, true, '应识别为内置插件');
  assert.ok(!fs.existsSync(dir), '目录应被移除');
  assert.strictEqual(pluginStore.isDeleted('builtin-x'), true, '应写入墓碑');
  assert.deepStrictEqual(
    pluginStore.getPluginConfig('builtin-x'),
    { rules: [{ id: 'r1', content: 'keep' }] },
    '内置插件删除后 config 必须保留'
  );
});

test('deletePlugin：非内置插件走 removeRecord，不留墓碑', () => {
  resetEnv();
  // 只放在 user plugins 目录，不在源目录
  writePlugin(path.join(pluginsDir, 'user-only'), 'user-only', '1.0.0');
  pluginStore.savePluginConfig('user-only', { any: 1 });

  const res = pluginHost.deletePlugin('user-only');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.bundled, false, '不在源目录 → 非内置');
  assert.ok(!fs.existsSync(path.join(pluginsDir, 'user-only')));
  assert.strictEqual(pluginStore.isDeleted('user-only'), false, '非内置插件不得留墓碑');
  assert.deepStrictEqual(pluginStore.getPluginConfig('user-only'), {}, '非内置插件配置应被清除');
});

// ---------- 恢复 ----------

test('restoreBundledPlugins：源目录缺失时失败且墓碑保留', async () => {
  resetEnv();
  writePlugin(path.join(srcDir, 'gone'), 'gone', '1.0.0');
  pluginHost.seedBundledPlugins(srcDir);
  pluginStore.markDeleted('gone');
  fs.rmSync(path.join(pluginsDir, 'gone'), { recursive: true, force: true });

  const missingSrc = path.join(tmpRoot, 'no-such-dir');
  pluginHost.seedBundledPlugins(missingSrc);
  assert.ok(!fs.existsSync(missingSrc));

  const res = await pluginHost.restoreBundledPlugins();
  assert.strictEqual(res.success, false, '源目录缺失必须失败');
  assert.strictEqual(pluginStore.isDeleted('gone'), true, '失败时不得清除墓碑');
});

test('restoreBundledPlugins：正常时重建目录并清墓碑', async () => {
  resetEnv();
  writePlugin(path.join(srcDir, 'restore-a'), 'restore-a', '1.0.0');
  writePlugin(path.join(srcDir, 'restore-b'), 'restore-b', '1.0.0');
  pluginHost.seedBundledPlugins(srcDir);

  pluginStore.markDeleted('restore-a');
  pluginStore.markDeleted('restore-b');
  fs.rmSync(path.join(pluginsDir, 'restore-a'), { recursive: true, force: true });
  fs.rmSync(path.join(pluginsDir, 'restore-b'), { recursive: true, force: true });

  const res = await pluginHost.restoreBundledPlugins();
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual((res.restored || []).slice().sort(), ['restore-a', 'restore-b']);
  assert.ok(fs.existsSync(path.join(pluginsDir, 'restore-a')), '目录应被重建');
  assert.ok(fs.existsSync(path.join(pluginsDir, 'restore-b')));
  assert.deepStrictEqual(pluginStore.listDeleted(), [], '墓碑应被清除');
});

// ---------- scanPlugins 的 bundled 字段 ----------

test('scanPlugins：内置插件 bundled=true，用户插件 bundled=false', () => {
  resetEnv();
  writePlugin(path.join(srcDir, 'scan-builtin'), 'scan-builtin', '1.0.0');
  pluginHost.seedBundledPlugins(srcDir);
  writePlugin(path.join(pluginsDir, 'scan-user'), 'scan-user', '1.0.0');

  const list = pluginHost.scanPlugins();
  const builtin = list.find((p) => p.id === 'scan-builtin');
  const user = list.find((p) => p.id === 'scan-user');
  assert.ok(builtin && user);
  assert.strictEqual(builtin.bundled, true, '源目录存在的插件应标记为内置');
  assert.strictEqual(user.bundled, false, '只在用户目录的插件不得标记为内置');
});
