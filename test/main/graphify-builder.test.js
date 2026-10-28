'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// graphify-builder 依赖 electron 的 app.getPath，用拦截替换成临时目录
const Module = require('module');
const origLoad = Module._load;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-gfxbuild-'));
const fakeUserData = path.join(tmpRoot, 'userData');
fs.mkdirSync(fakeUserData, { recursive: true });

Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => fakeUserData } };
  }
  return origLoad.apply(this, arguments);
};

delete require.cache[require.resolve('../../src/main/graphify-builder')];
const builder = require('../../src/main/graphify-builder');

Module._load = origLoad;

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

test('locateCli 能定位到 resources/graphify/graphify.exe', () => {
  const p = builder.locateCli();
  if (!p) return; // 未构建时跳过
  assert.ok(p.endsWith('graphify.exe'), '应指向 graphify.exe，实际: ' + p);
  assert.ok(fs.existsSync(p));
});

test('getGraphDir 落在 userData/graphify 下', () => {
  const d = builder.getGraphDir();
  assert.strictEqual(d, path.join(fakeUserData, 'graphify'));
});

test('getGraphJsonPath 指向 graph.json', () => {
  assert.ok(builder.getGraphJsonPath().endsWith('graph.json'));
});

test('hasGraph 在图谱不存在时返回 false', () => {
  assert.strictEqual(builder.hasGraph(), false);
});

test('项目目录不存在时返回失败而不抛异常', async () => {
  const r = await builder.buildGraph(path.join(tmpRoot, 'no-such-dir'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /项目目录不存在/);
});

test('空目录建图返回失败（无节点），且不抛异常', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const emptyProj = path.join(tmpRoot, 'empty-proj');
  fs.mkdirSync(emptyProj, { recursive: true });
  const r = await builder.buildGraph(emptyProj, { force: true });
  assert.strictEqual(r.ok, false, '空目录不应建图成功');
});

test('含 JS 文件的项目能成功建图并落到固定路径', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const proj = path.join(tmpRoot, 'real-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.js'), 'function foo(){return 1;}\nfoo();\n', 'utf-8');

  const r = await builder.buildGraph(proj, { force: true });
  assert.strictEqual(r.ok, true, '应建图成功，实际: ' + JSON.stringify(r));
  assert.ok(r.nodes > 0, '节点数应大于 0，实际: ' + r.nodes);
  assert.strictEqual(builder.hasGraph(), true, 'graph.json 应存在');
  assert.ok(builder.getGraphJsonPath().startsWith(fakeUserData), '图应落在 userData 下');
});

test('切换项目后再切回，TTL 不能返回别的项目的图', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const projA = path.join(tmpRoot, 'switch-a');
  const projB = path.join(tmpRoot, 'switch-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(projA, 'a.js'), 'function onlyInA(){return 1;}\nonlyInA();\n', 'utf-8');
  fs.writeFileSync(path.join(projB, 'b.js'), 'function onlyInB(){return 2;}\nonlyInB();\n', 'utf-8');

  await builder.buildGraph(projA, { force: true });
  assert.strictEqual(builder.getBuiltFrom(), projA, '建完 A 后来源应为 A');

  await builder.buildGraph(projB, { force: true });
  assert.strictEqual(builder.getBuiltFrom(), projB, '建完 B 后来源应为 B');

  // 关键断言：切回 A 时不能因为 TTL 直接返回 cached 而沿用 B 的图
  const back = await builder.buildGraph(projA);
  assert.notStrictEqual(back.cached, true, '当前图来自 B，切回 A 必须重建而不是命中 TTL');

  const g = JSON.parse(fs.readFileSync(builder.getGraphJsonPath(), 'utf-8'));
  // graphify 会把节点 id 小写化（onlyInA → onlyina），比较时忽略大小写
  const labels = (g.nodes || []).map((n) => String(n.id || n.label || '')).join(' ').toLowerCase();
  assert.ok(labels.includes('onlyina'), '重建后图应属于 A，实际内容: ' + labels.slice(0, 200));
  assert.ok(!labels.includes('onlyinb'), '重建后图不应含 B 的内容，实际内容: ' + labels.slice(0, 200));
});

test('建图失败不写入 TTL（下次会重试）', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const emptyProj = path.join(tmpRoot, 'fail-proj');
  fs.mkdirSync(emptyProj, { recursive: true });

  const first = await builder.buildGraph(emptyProj, { force: true });
  assert.strictEqual(first.ok, false);

  // 失败后立刻再调，不应该被 TTL 挡成 cached
  const second = await builder.buildGraph(emptyProj);
  assert.notStrictEqual(second.cached, true, '失败不应计入 TTL，应重新尝试');
});

test('建图产物通过原子替换落到正式路径，且不留 tmp 目录', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const proj = path.join(tmpRoot, 'atomic-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'c.js'), 'const z=1;\nmodule.exports=z;\n', 'utf-8');

  const r = await builder.buildGraph(proj, { force: true });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(builder.getGraphJsonPath()), 'graph.json 应存在');

  const leftovers = fs.readdirSync(builder.getGraphDir()).filter((f) => f.startsWith('.tmp-build-'));
  assert.deepStrictEqual(leftovers, [], '不应残留临时构建目录，实际: ' + leftovers.join(','));
});

test('cancel() 可安全重复调用', () => {
  builder.cancel();
  builder.cancel();
  assert.ok(true);
});

test('TTL 内重复调用返回 cached，不重复建图', async () => {
  const cli = builder.locateCli();
  if (!cli) return;

  const proj = path.join(tmpRoot, 'ttl-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'b.js'), 'const x=1;\nmodule.exports=x;\n', 'utf-8');

  const first = await builder.buildGraph(proj, { force: true });
  assert.strictEqual(first.ok, true);

  const second = await builder.buildGraph(proj);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.cached, true, 'TTL 内应返回 cached');
});
