'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const STORE_MODULE = require.resolve('../../src/main/redaction-store');
let origCwd = null;
let tmpDir = null;
let store = null;
let origRandom = null;

function freshStore() {
  delete require.cache[STORE_MODULE];
  return require('../../src/main/redaction-store');
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ly-redquick-'));
  process.chdir(tmpDir);
  store = freshStore();
  origRandom = Math.random;
});

afterEach(() => {
  Math.random = origRandom;
  try { process.chdir(origCwd); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete require.cache[STORE_MODULE];
});

test('getQuickGenConfig 返回默认值（长度 6，过滤易混字符开启）', () => {
  const cfg = store.getQuickGenConfig();
  assert.strictEqual(cfg.length, 6);
  assert.strictEqual(cfg.filterConfusable, true);
  assert.ok(cfg.charset.length > 0);
  assert.match(cfg.charset, /^[A-Z0-9]+$/, '字符表只含大写字母和数字');
});

test('addQuickRule 生成密文，长度与配置一致', () => {
  store.updateQuickGenConfig({ length: 8 });
  const rule = store.addQuickRule('C:\\secret\\a.txt');
  assert.strictEqual(rule.name.length, 8);
  assert.deepStrictEqual(rule.words, ['C:\\secret\\a.txt']);
  assert.strictEqual(rule.source, 'manual');
  assert.strictEqual(rule.scope, 'global');
});

test('字符表顺序有意义：改顺序后生成结果不同（固定随机数）', () => {
  store.updateQuickGenConfig({ charset: 'ABCDEF', length: 4, filterConfusable: false });
  Math.random = () => 0; // 每次都取 charset[0]
  const r1 = store.addQuickRule('WORD_ONE');
  assert.strictEqual(r1.name, 'AAAA');

  store.updateQuickGenConfig({ charset: 'FEDCBA', length: 4, filterConfusable: false });
  const r2 = store.addQuickRule('WORD_TWO');
  assert.strictEqual(r2.name, 'FFFF');
});

test('过滤易混字符：字符表含 0O1IL 时生成结果不出现它们', () => {
  store.updateQuickGenConfig({ charset: '0O1ILABC', length: 12, filterConfusable: true });
  // 用真实随机，多生成几次确保稳定
  for (let i = 0; i < 5; i++) {
    const r = store.addQuickRule('WORD_' + i);
    assert.doesNotMatch(r.name, /[0O1IL]/, '密文不应含易混字符: ' + r.name);
  }
});

test('关闭过滤后，字符表里的易混字符可被使用', () => {
  store.updateQuickGenConfig({ charset: '0000', length: 4, filterConfusable: false });
  const r = store.addQuickRule('WORD_ZERO');
  assert.strictEqual(r.name, '0000');
});

test('字符表非法字符被自动过滤（小写与符号）', () => {
  const res = store.updateQuickGenConfig({ charset: 'abC12-!@D' });
  assert.strictEqual(res.config.charset, 'C12D');
});

test('长度越界被拒绝', () => {
  assert.throws(() => store.updateQuickGenConfig({ length: 2 }), /3~16/);
  assert.throws(() => store.updateQuickGenConfig({ length: 17 }), /3~16/);
});

test('字符表过滤后为空则报错', () => {
  assert.throws(() => store.updateQuickGenConfig({ charset: '---!!!' }), /为空/);
});

test('空真词被拒绝', () => {
  assert.throws(() => store.addQuickRule(''), /真词不能为空/);
  assert.throws(() => store.addQuickRule('   '), /真词不能为空/);
  assert.throws(() => store.addQuickRule(null), /真词不能为空/);
});

test('同一真词重复调用返回已有规则（幂等）', () => {
  const r1 = store.addQuickRule('DUPLICATE_WORD');
  const r2 = store.addQuickRule('DUPLICATE_WORD');
  assert.strictEqual(r1.name, r2.name);
  assert.strictEqual(r2.reused, true);
});

test('密文碰撞时自动重试，不与已有规则重名', () => {
  // charset 2 个字符 × 长度 4 = 16 种可能，生成 8 条必然多次碰撞
  store.updateQuickGenConfig({ charset: 'AB', length: 4, filterConfusable: false });
  const names = new Set();
  for (let i = 0; i < 8; i++) {
    const r = store.addQuickRule('WORD_' + i);
    names.add(r.name);
  }
  assert.strictEqual(names.size, 8, '8 条规则应有 8 个不同密文（碰撞后重试成功）');
  for (const n of names) {
    assert.strictEqual(n.length, 4);
    assert.match(n, /^[AB]{4}$/);
  }
});

test('密文空间耗尽时明确报错（2^3=8 种却要 9 条）', () => {
  store.updateQuickGenConfig({ charset: 'AB', length: 3, filterConfusable: false });
  let err = null;
  try {
    for (let i = 0; i < 9; i++) store.addQuickRule('OVERFLOW_' + i);
  } catch (e) { err = e; }
  assert.ok(err, '应该抛错');
  assert.match(err.message, /空间不足/);
});

test('快速规则可被 redactText / unredactText 双向闭环', () => {
  store.updateQuickGenConfig({ charset: 'ABCDEF', length: 4, filterConfusable: false });
  const rule = store.addQuickRule('MySecretProject');
  const red = store.redactText('项目路径 MySecretProject/src');
  assert.ok(red.indexOf('⟦' + rule.name + '⟧') >= 0, '应出现占位符: ' + red);
  assert.ok(red.indexOf('MySecretProject') === -1, '真词应被替换');
  const back = store.unredactText(red);
  assert.strictEqual(back, '项目路径 MySecretProject/src');
});

test('配置持久化：重新加载 store 后配置保留', () => {
  store.updateQuickGenConfig({ charset: 'XYZ', length: 5, filterConfusable: false });
  const reloaded = freshStore();
  const cfg = reloaded.getQuickGenConfig();
  assert.strictEqual(cfg.charset, 'XYZ');
  assert.strictEqual(cfg.length, 5);
  assert.strictEqual(cfg.filterConfusable, false);
});
