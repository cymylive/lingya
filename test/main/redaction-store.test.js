'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const STORE_MODULE = require.resolve('../../src/main/redaction-store');
let origCwd = null;
let tmpDir = null;
let store = null;

function freshStore() {
  delete require.cache[STORE_MODULE];
  return require('../../src/main/redaction-store');
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ly-redaction-'));
  process.chdir(tmpDir);
  store = freshStore();
});

afterEach(() => {
  try { process.chdir(origCwd); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete require.cache[STORE_MODULE];
});

test('exportRules 返回 { version, rules } 且含全部字段', () => {
  const data = store.exportRules();
  assert.strictEqual(data.version, 2);
  assert.ok(Array.isArray(data.rules));
  assert.ok(data.rules.length > 0);
  const r = data.rules[0];
  for (const k of ['name', 'words', 'desc', 'enabled', 'source', 'scope']) {
    assert.ok(k in r, '规则应包含字段 ' + k);
  }
});

test('importRules 同名单词规则覆盖，新名追加', () => {
  store.addRule({ name: '甲', words: ['ALPHAWORD'], desc: '原描述', enabled: true });
  const before = store.listRules().length;
  const stat = store.importRules({
    version: 2,
    rules: [
      { name: '甲', words: ['BETTRAWORD'], desc: '新描述', enabled: false, source: 'manual', scope: 'global' },
      { name: '乙', words: ['GAMMAWORD'], desc: '新增', enabled: true, source: 'manual', scope: 'global' },
    ],
  });
  assert.strictEqual(stat.added, 1);
  assert.strictEqual(stat.updated, 1);
  assert.strictEqual(stat.total, before + 1);
  const rules = store.listRules();
  const jia = rules.find((r) => r.name === '甲');
  assert.deepStrictEqual(jia.words, ['BETTRAWORD']);
  assert.strictEqual(jia.desc, '新描述');
  assert.strictEqual(jia.enabled, false);
  assert.ok(rules.find((r) => r.name === '乙'));
});

test('importRules 不删除文件中未出现的现有规则', () => {
  store.addRule({ name: '保留', words: ['KEEPWORD'], desc: '', enabled: true });
  store.importRules([{ name: '新', words: ['NEWWORDX'], desc: '', enabled: true }]);
  const rules = store.listRules();
  assert.ok(rules.find((r) => r.name === '保留'), '未出现在导入文件里的规则应保留');
  assert.ok(rules.find((r) => r.name === '新'));
});

test('importRules 接受裸数组格式', () => {
  const stat = store.importRules([{ name: '裸', words: ['RAWWORDX'], desc: '', enabled: true }]);
  assert.strictEqual(stat.added, 1);
  assert.ok(store.listRules().find((r) => r.name === '裸'));
});

test('importRules 多词规则按既有约定拆分为 name_1/name_2', () => {
  store.importRules([{ name: '多', words: ['WORDONE', 'WORDTWO'], desc: '', enabled: true }]);
  const rules = store.listRules();
  assert.ok(rules.find((r) => r.name === '多_1'));
  assert.ok(rules.find((r) => r.name === '多_2'));
  assert.strictEqual(rules.find((r) => r.name === '多_1').words[0], 'WORDONE');
  assert.strictEqual(rules.find((r) => r.name === '多_2').words[0], 'WORDTWO');
});

test('importRules 缺 name 抛错', () => {
  assert.throws(() => store.importRules([{ words: ['XXXWORD'] }]), /缺少 name/);
});

test('importRules 真词为空抛错', () => {
  assert.throws(() => store.importRules([{ name: '空', words: [] }]), /真词列表为空/);
});

test('importRules 非法结构抛错', () => {
  assert.throws(() => store.importRules({ foo: 1 }), /格式错误/);
  assert.throws(() => store.importRules(null), /格式错误/);
});

test('导出→导入往返：规则完全一致', () => {
  store.addRule({ name: '往返', words: ['ROUNDTRIPWORD'], desc: '往返测试', enabled: true, source: 'manual', scope: 'global' });
  const dump = JSON.parse(JSON.stringify(store.exportRules()));
  for (const r of store.listRules()) store.deleteRule(r.name);
  assert.strictEqual(store.listRules().length, 0);
  store.importRules(dump);
  const rules = store.listRules();
  assert.strictEqual(rules.length, dump.rules.length);
  const rt = rules.find((r) => r.name === '往返');
  assert.deepStrictEqual(rt.words, ['ROUNDTRIPWORD']);
  assert.strictEqual(rt.desc, '往返测试');
});

// ===== 2026-11-05: 限制已取消，改为验证「放行」 =====
// 用户要求取消所有导入限制（不再拒绝代码通用词、JS 关键字、工具函数名、短词）。
// 原「拒绝」测试改为「能成功添加」测试。
test('addRule 允许代码通用词 js（限制已取消）', () => {
  const r = store.addRule({ name: '脚本X', words: ['js'], desc: '', enabled: true });
  assert.ok(r, '应允许添加 js');
  assert.ok((Array.isArray(r) ? r[0] : r).words.indexOf('js') >= 0, 'words 应含 js');
});

test('addRule 允许 JS 关键字 await（限制已取消）', () => {
  const r = store.addRule({ name: '等待X', words: ['await'], desc: '', enabled: true });
  assert.ok(r, '应允许添加 await');
});

test('addRule 允许工具函数名 read（限制已取消）', () => {
  const r = store.addRule({ name: '读X', words: ['read'], desc: '', enabled: true });
  assert.ok(r, '应允许添加 read');
});

test('addRule 允许过短词（<=2 字符，限制已取消）', () => {
  const r = store.addRule({ name: '短X', words: ['ab'], desc: '', enabled: true });
  assert.ok(r, '应允许添加 ab');
});

test('addRule 接受正常项目词', () => {
  const r = store.addRule({ name: '项目X', words: ['XylophoneProject'], desc: '', enabled: true });
  assert.ok(r && r.name === '项目X');
});

test('importRules 允许含危险词的导入文件（限制已取消）', () => {
  const r = store.importRules([{ name: '坏X', words: ['json'], desc: '', enabled: true }]);
  assert.ok(r, '应允许导入 json');
  assert.ok(r.added >= 1 || r.updated >= 1, '应有新增或更新');
});

// ===== 脱敏上下文保护 =====
test('redactText 在扩展名/属性访问位置也替换（2026-11-05 取消保护）', () => {
  store.addRule({ name: '项目P', words: ['XtremeProject'], desc: '', enabled: true });
  const out = store.redactText('XtremeProject 和 index.XtremeProject');
  assert.ok(out.includes('⟦项目P⟧'), '独立出现应脱敏');
  assert.ok(out.includes('index.⟦项目P⟧'), '点号后也应脱敏（取消属性保护）');
  assert.ok(!out.includes('index.XtremeProject'), '真词不应残留在属性位置');
  assert.strictEqual(store.unredactText(out), 'XtremeProject 和 index.XtremeProject', '双向闭环成立');
});

test('redactText 在路径上下文也替换（2026-11-05 取消保护）', () => {
  store.addRule({ name: '项目Q', words: ['YankeeProject'], desc: '', enabled: true });
  const out = store.redactText('YankeeProject/src 与 YankeeProject');
  assert.ok(out.includes('⟦项目Q⟧/src'), '路径分隔符上下文也应脱敏');
  assert.ok(!out.includes('YankeeProject'), '真词不应残留');
  assert.strictEqual(store.unredactText(out), 'YankeeProject/src 与 YankeeProject', '双向闭环成立');
});

test('redactText ASCII 词边界：不误伤更长标识符', () => {
  store.addRule({ name: '项目R', words: ['Zulu'], desc: '', enabled: true });
  const out = store.redactText('Zulu 和 Zulufoo 和 myZulu');
  assert.ok(out.startsWith('⟦项目R⟧'), '独立词应脱敏');
  assert.ok(out.includes('Zulufoo'), '后缀更长应跳过');
  assert.ok(out.includes('myZulu'), '前缀更长应跳过');
});

test('isProtectedMatch 只保留词边界（2026-11-05 取消路径/属性保护）', () => {
  const f = store.isProtectedMatch;
  assert.strictEqual(f('a.js', 2, 'js'), false, '点号前不再保护（已取消属性保护）');
  assert.strictEqual(f('src/js', 4, 'js'), false, '路径后不再保护（已取消路径保护）');
  assert.strictEqual(f('json', 0, 'js'), true, '长词内仍保护（词边界）');
  assert.strictEqual(f('js test', 0, 'js'), false, '独立词不保护');
});
