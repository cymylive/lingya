'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const skillStore = require('../../src/main/skill-store');

// 用临时 userData 目录，绝不污染真实技能库
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-skill-test-'));
const storeDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(storeDir, { recursive: true });

// 造一个假的 assets 目录：两个内置技能 + 一个无 SKILL.md 的目录
const assetsDir = path.join(tmpRoot, 'assets');
function makeSkill(dirName, name, desc) {
  const d = path.join(assetsDir, dirName);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), [
    '---',
    'name: ' + name,
    'description: ' + desc,
    '---',
    '',
    '# ' + name,
    '',
    '正文内容。',
  ].join('\n'), 'utf-8');
}
makeSkill('builtin-a', 'builtin-a', '第一个内置技能');
makeSkill('builtin-b', 'builtin-b', '第二个内置技能');
fs.mkdirSync(path.join(assetsDir, 'no-skill-md'), { recursive: true });

skillStore.init(storeDir);

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

test('registerBuiltinSkills 扫描并注册所有含 SKILL.md 的目录', () => {
  const r = skillStore.registerBuiltinSkills(assetsDir);
  assert.deepStrictEqual(r.registered.sort(), ['builtin-a', 'builtin-b']);
  assert.deepStrictEqual(r.warnings, []);

  const names = skillStore.getAllSkills().map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['builtin-a', 'builtin-b']);
});

test('注册的技能 source=local 且 localPath 指向 SKILL.md', () => {
  const s = skillStore.getSkillByName('builtin-a');
  assert.strictEqual(s.source, 'local');
  assert.ok(s.localPath.endsWith('SKILL.md'), 'localPath 应指向 SKILL.md，实际: ' + s.localPath);
  assert.strictEqual(s.description, '第一个内置技能');
});

test('重复注册是幂等的，不会产生重复条目', () => {
  skillStore.registerBuiltinSkills(assetsDir);
  skillStore.registerBuiltinSkills(assetsDir);
  const names = skillStore.getAllSkills().map((s) => s.name);
  assert.strictEqual(names.length, 2, '重复同步不应产生重复条目，实际: ' + names.join(','));
});

test('重复注册保留用户的 enabled 选择', () => {
  skillStore.setSkillEnabled('builtin-b', false);
  skillStore.registerBuiltinSkills(assetsDir);
  const s = skillStore.getSkillByName('builtin-b');
  assert.strictEqual(s.enabled, false, '用户禁用的技能不应被启动同步重新启用');
  skillStore.setSkillEnabled('builtin-b', true);
});

test('重复注册保留使用统计', () => {
  skillStore.touchSkill(['builtin-a']);
  skillStore.touchSkill(['builtin-a']);
  const before = skillStore.getSkillByName('builtin-a').useCount;
  assert.ok(before >= 2, 'useCount 应累计，实际: ' + before);

  skillStore.registerBuiltinSkills(assetsDir);
  const after = skillStore.getSkillByName('builtin-a').useCount;
  assert.strictEqual(after, before, '启动同步不应重置 useCount');
});

test('SKILL.md 正文会更新（应用升级后技能跟着更新）', () => {
  const f = path.join(assetsDir, 'builtin-a', 'SKILL.md');
  const raw = fs.readFileSync(f, 'utf-8');
  fs.writeFileSync(f, raw.replace('正文内容。', '更新后的正文。'), 'utf-8');

  skillStore.registerBuiltinSkills(assetsDir);
  const s = skillStore.getSkillByName('builtin-a');
  assert.match(s.instructions, /更新后的正文/, 'instructions 应随 SKILL.md 更新');
});

test('目录不存在时返回空结果而不抛异常', () => {
  const r = skillStore.registerBuiltinSkills(path.join(tmpRoot, 'does-not-exist'));
  assert.deepStrictEqual(r.registered, []);
  assert.deepStrictEqual(r.warnings, []);
});

test('assets 根目录下的 .md 文件本身不被当成技能（只认子目录里的 SKILL.md）', () => {
  fs.writeFileSync(path.join(assetsDir, 'README.md'), '# 不是技能', 'utf-8');
  const r = skillStore.registerBuiltinSkills(assetsDir);
  assert.ok(!r.registered.includes('README'), 'assets 根目录的 .md 不应被注册为技能');
});

test('真实内置资源目录能被扫描到（防打包遗漏）', () => {
  const realAssets = path.join(__dirname, '..', '..', 'src', 'assets');
  if (!fs.existsSync(realAssets)) return; // 打包环境可能没有，跳过

  const real = fs.readdirSync(realAssets, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(realAssets, e.name, 'SKILL.md')))
    .map((e) => e.name);
  assert.ok(real.length > 0, 'src/assets 下应至少有一个内置技能目录');

  const r = skillStore.registerBuiltinSkills(realAssets);
  assert.ok(r.registered.length > 0, '内置技能应能被注册，实际: ' + JSON.stringify(r));
  assert.deepStrictEqual(r.warnings, [], '内置技能同步不应有警告');
});
