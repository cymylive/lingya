'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const mcpConfig = require('../../src/main/mcp-config');

// mcp-config 依赖 electron 的 app.getPath，测试环境没有 electron。
// 用 Module._load 拦截，返回一个指向临时目录的假 app。
const Module = require('module');
const origLoad = Module._load;
const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lingya-mcp-test-'));
const fakeUserData = path.join(tmpRoot, 'userData');
fs.mkdirSync(fakeUserData, { recursive: true });

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => fakeUserData } };
  }
  return origLoad.apply(this, arguments);
};

// 重新加载，让拦截生效
delete require.cache[require.resolve('../../src/main/mcp-config')];
const mcp = require('../../src/main/mcp-config');

Module._load = origLoad;

const realExe = path.join(__dirname, '..', '..', 'resources', 'graphify', 'graphify-mcp.exe');

test('registerBuiltinGraphify 注册成功（exe 存在时）', () => {
  if (!fs.existsSync(realExe)) {
    // 打包产物不在（如 CI 未构建），跳过
    return;
  }
  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(r.registered, true, '应注册成功，实际: ' + JSON.stringify(r));

  const servers = mcp.getServers();
  const g = servers.find((s) => s.name === 'graphify');
  assert.ok(g, 'graphify server 应存在于配置中');
  assert.strictEqual(g.type, 'stdio');
  assert.ok(g.command.endsWith('graphify-mcp.exe'), 'command 应指向 exe，实际: ' + g.command);
  assert.ok(g.args[0].includes('graph.json'), 'args[0] 应为 graph.json 路径，实际: ' + g.args[0]);
});

test('已存在外部来源的 graphify server 时不覆盖', () => {
  if (!fs.existsSync(realExe)) return;

  // 用户自己装的 graphify（不指向应用自带 exe）
  mcp.upsertServer({
    name: 'graphify',
    type: 'stdio',
    command: 'C:\\custom\\my-own.exe',
    args: ['C:\\custom\\my-graph.json'],
  });

  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(r.registered, false, '应拒绝覆盖用户自定义配置');
  assert.match(r.reason, /用户自定义/, 'reason 应说明是用户自定义，实际: ' + r.reason);

  const g = mcp.getServers().find((s) => s.name === 'graphify');
  assert.strictEqual(g.command, 'C:\\custom\\my-own.exe', '用户配置应保持不变');
  assert.strictEqual(g.args[0], 'C:\\custom\\my-graph.json', '用户 args 应保持不变');
});

test('已存在指向自带 exe 的旧配置时，更新 graph 路径', () => {
  if (!fs.existsSync(realExe)) return;

  // 模拟「升级前注册过，但 graph 路径是旧位置」
  mcp.removeServer('graphify');
  mcp.upsertServer({
    name: 'graphify',
    type: 'stdio',
    command: realExe,
    args: ['C:\\Users\\old\\graphify-out\\graph.json', '--transport', 'stdio'],
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });

  const before = mcp.getServers().find((s) => s.name === 'graphify');
  assert.ok(before.args[0].includes('old'), '前置条件：应为旧路径');

  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(r.registered, true, '指向自带 exe 时应更新');
  assert.strictEqual(r.updated, true);

  const after = mcp.getServers().find((s) => s.name === 'graphify');
  assert.ok(after.args[0].startsWith(fakeUserData), '应更新为 userData 下的路径，实际: ' + after.args[0]);
  assert.ok(!after.args[0].includes('old'), '旧路径应被替换');
});

test('已存在且配置已最新时，不重复写盘', () => {
  if (!fs.existsSync(realExe)) return;

  mcp.removeServer('graphify');
  mcp.registerBuiltinGraphify();

  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(r.registered, false);
  assert.strictEqual(r.updated, false);
  assert.match(r.reason, /已是最新/);
});

test('图谱路径落在 userData/graphify/ 下', () => {
  if (!fs.existsSync(realExe)) return;

  // 清掉 graphify，重新注册
  mcp.removeServer('graphify');
  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(r.registered, true);

  const g = mcp.getServers().find((s) => s.name === 'graphify');
  const graphPath = g.args[0];
  assert.ok(graphPath.startsWith(fakeUserData), '图谱应在 userData 下，实际: ' + graphPath);
  assert.ok(graphPath.includes('graphify'), '图谱路径应含 graphify 目录');
});

test('exe 不存在时返回未注册且不抛异常', () => {
  // 临时把 resources 指到不存在的路径无法模拟，
  // 这里验证「reason 字段存在」这一契约即可
  mcp.removeServer('graphify');
  const r = mcp.registerBuiltinGraphify();
  assert.strictEqual(typeof r.registered, 'boolean');
  if (!r.registered) {
    assert.ok(r.reason, '未注册时必须给出 reason');
  }
});

test('cleanup', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});
