/**
 * 插件宿主生命周期测试
 *
 * 覆盖真实的加载/卸载/覆盖安装/配置持久化行为，防止核心逻辑退化。
 * 由于 plugin-host 依赖 Electron 的 electron-store 或 IPC（在纯 Node 环境不可用），
 * 此处使用模拟的全局环境进行模块加载测试。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 延迟加载 plugin-host，避免立刻触发依赖问题
let pluginHost;
const tmpBase = path.join(__dirname, '..', 'tmp', 'lifecycle-test');

test.before(() => {
  if (fs.existsSync(tmpBase)) fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.mkdirSync(tmpBase, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(tmpBase)) fs.rmSync(tmpBase, { recursive: true, force: true });
});

test('生命周期：加载、保存配置、重载、删除', async () => {
  // 动态 require，因为内部可能引用到了 electron 模块，需要提前做好兼容
  // 我们只测核心逻辑，不依赖 UI 层的 mock。
  // 如果直接 require 报错，需要检查环境的兼容性（目前 test/main 里的测试可以正常跑，说明兼容处理是好的）
  
  // 为了测试，我们手动创建一个插件目录
  const host = require('../../src/main/plugin-host');
  
  // 初始化宿主（指向临时目录）
  const pluginDir = path.join(tmpBase, 'plugins');
  host.init(tmpBase); // init 会创建 plugins 目录

  // 手动创建一个测试插件
  const testPluginDir = path.join(pluginDir, 'test-lifecycle');
  fs.mkdirSync(testPluginDir, { recursive: true });
  fs.writeFileSync(path.join(testPluginDir, 'manifest.json'), JSON.stringify({
    id: 'test-lifecycle',
    name: '生命周期测试插件',
    version: '1.0.0',
    entry: 'index.js'
  }));
  fs.writeFileSync(path.join(testPluginDir, 'index.js'), `
    export function apply(ctx) {
      ctx.registerIpc('getVal', () => ctx.config.val || 0);
      ctx.registerIpc('setVal', (args) => {
        ctx.config.val = args.val;
        ctx.settings.save();
      });
    }
  `);

  // 1. 扫描并加载
  const plugins = host.scanPlugins();
  const myPlugin = plugins.find(p => p.id === 'test-lifecycle');
  assert.ok(myPlugin, '插件应被扫描到');
  
  const loadRes = await host.loadPlugin(myPlugin);
  assert.strictEqual(loadRes.success, true, '插件应能成功加载');

  // 2. 调用 IPC 并保存配置
  const ipcRes = await host.invokePluginIpc('test-lifecycle', 'setVal', { val: 42 });
  assert.strictEqual(ipcRes.success, true, 'IPC 调用应成功');
  
  const getRes = await host.invokePluginIpc('test-lifecycle', 'getVal', {});
  assert.strictEqual(getRes.data, 42, '配置应被修改');

  // 3. 模拟重启（清空内存并重新 init）
  host.unloadPlugin('test-lifecycle');
  host.init(tmpBase); // 重新读取持久化存储
  
  const myPlugin2 = host.scanPlugins().find(p => p.id === 'test-lifecycle');
  await host.loadPlugin(myPlugin2);
  
  const getRes2 = await host.invokePluginIpc('test-lifecycle', 'getVal', {});
  assert.strictEqual(getRes2.data, 42, '重启后配置应保留');

  // 4. 模拟覆盖安装
  // 构造一个 zip buffer
  const { zipDir } = require('../../src/main/plugin-zip');
  const zipBuf = zipDir(testPluginDir, 'test-lifecycle');
  
  // 覆盖导入
  const importRes = await host.importPlugin(zipBuf);
  assert.strictEqual(importRes.success, true, '覆盖导入应成功');
  assert.strictEqual(importRes.overwritten, true, '应识别为覆盖');
  assert.strictEqual(importRes.loaded, true, '导入后应自动加载');

  // 5. 清理
  host.deletePlugin('test-lifecycle');
  assert.strictEqual(fs.existsSync(testPluginDir), false, '删除后目录应消失');
});
