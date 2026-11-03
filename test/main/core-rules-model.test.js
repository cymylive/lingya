'use strict';
/**
 * core-rules 插件数据模型回归测试
 *
 * 覆盖 1.1.0 → 2.0.0 改造的核心语义：
 * 1. 旧配置（reportText）自动迁移成单条规则，不丢用户已写的文案
 * 2. 注入文本只包含启用的、非空的规则，且按 order 排序
 * 3. 上移/下移的边界行为（首条上移、末条下移应无变化）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  normalizeRules,
  buildInjectionText,
  moveRule,
  DEFAULT_RULE_NAME,
} = require('../../plugins/core-rules/rules-model.js');

// ---------- normalizeRules ----------

test('normalizeRules: 旧配置 reportText 迁移成单条规则', () => {
  const rules = normalizeRules({
    enabled: true,
    reportText: '## 铁律：需求先汇报\n\n内容...',
  });
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].name, DEFAULT_RULE_NAME);
  assert.strictEqual(rules[0].enabled, true);
  assert.ok(rules[0].id, '必须生成 id');
  assert.match(rules[0].content, /需求先汇报/);
});

test('normalizeRules: 旧配置 enabled=false 时迁移出的规则也是禁用', () => {
  const rules = normalizeRules({ enabled: false, reportText: '规则内容' });
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].enabled, false);
});

test('normalizeRules: 空配置返回空数组', () => {
  assert.deepStrictEqual(normalizeRules({}), []);
  assert.deepStrictEqual(normalizeRules(null), []);
  assert.deepStrictEqual(normalizeRules({ reportText: '   ' }), []);
});

test('normalizeRules: 补全缺失字段并重排 order 为 0..N-1', () => {
  const rules = normalizeRules({
    rules: [
      { id: 'a', name: 'A', content: 'aaa', enabled: true, order: 5 },
      { id: 'b', name: 'B', content: 'bbb', enabled: false, order: 2 },
    ],
  });
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].id, 'b', 'order 小的排前面');
  assert.strictEqual(rules[1].id, 'a');
  assert.strictEqual(rules[0].order, 0);
  assert.strictEqual(rules[1].order, 1);
});

test('normalizeRules: 缺 name 时给默认名，缺 id 时生成', () => {
  const rules = normalizeRules({ rules: [{ content: 'x' }] });
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].name, '未命名规则');
  assert.ok(rules[0].id.startsWith('r_'));
});

// ---------- buildInjectionText ----------

test('buildInjectionText: 过滤 disabled 和空内容', () => {
  const txt = buildInjectionText([
    { content: 'AAA', enabled: true, order: 0 },
    { content: 'BBB', enabled: false, order: 1 },
    { content: '   ', enabled: true, order: 2 },
    { content: 'CCC', enabled: true, order: 3 },
  ]);
  assert.ok(txt.includes('AAA'));
  assert.ok(!txt.includes('BBB'), '禁用规则不得注入');
  assert.ok(txt.includes('CCC'));
});

test('buildInjectionText: 按 order 升序拼接，用空行分隔', () => {
  const txt = buildInjectionText([
    { content: 'SECOND', enabled: true, order: 1 },
    { content: 'FIRST', enabled: true, order: 0 },
  ]);
  assert.strictEqual(txt, 'FIRST\n\nSECOND');
});

test('buildInjectionText: 空数组 / 非数组返回空串', () => {
  assert.strictEqual(buildInjectionText([]), '');
  assert.strictEqual(buildInjectionText(null), '');
  assert.strictEqual(buildInjectionText(undefined), '');
});

test('buildInjectionText: 全部禁用返回空串（不注入空 section）', () => {
  assert.strictEqual(buildInjectionText([
    { content: 'AAA', enabled: false, order: 0 },
  ]), '');
});

// ---------- moveRule ----------

test('moveRule: 上移交换 order', () => {
  const rules = [
    { id: 'a', order: 0 },
    { id: 'b', order: 1 },
  ];
  const out = moveRule(rules, 'b', 'up');
  assert.strictEqual(out[0].id, 'b');
  assert.strictEqual(out[1].id, 'a');
  assert.strictEqual(out[0].order, 0);
  assert.strictEqual(out[1].order, 1);
});

test('moveRule: 下移交换 order', () => {
  const rules = [
    { id: 'a', order: 0 },
    { id: 'b', order: 1 },
  ];
  const out = moveRule(rules, 'a', 'down');
  assert.strictEqual(out[0].id, 'b');
  assert.strictEqual(out[1].id, 'a');
});

test('moveRule: 首条上移不变', () => {
  const rules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }];
  const out = moveRule(rules, 'a', 'up');
  assert.strictEqual(out, rules, '边界情况应原样返回');
});

test('moveRule: 末条下移不变', () => {
  const rules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }];
  const out = moveRule(rules, 'b', 'down');
  assert.strictEqual(out, rules);
});

test('moveRule: 不修改入参数组', () => {
  const rules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }];
  const snapshot = JSON.stringify(rules);
  moveRule(rules, 'b', 'up');
  assert.strictEqual(JSON.stringify(rules), snapshot, 'moveRule 必须无副作用');
});

test('moveRule: 不存在的 id / 非法 direction 原样返回', () => {
  const rules = [{ id: 'a', order: 0 }];
  assert.strictEqual(moveRule(rules, 'zzz', 'up'), rules);
  assert.strictEqual(moveRule(rules, 'a', 'left'), rules);
});

// ---------- 端到端语义 ----------

test('端到端：旧配置迁移后立即能正确注入', () => {
  const rules = normalizeRules({ reportText: '旧规则内容' });
  const txt = buildInjectionText(rules);
  assert.strictEqual(txt, '旧规则内容');
});

test('端到端：多规则增删排序后注入结果符合预期', () => {
  let rules = normalizeRules({
    rules: [
      { id: 'a', name: '规则A', content: 'A内容', enabled: true, order: 0 },
      { id: 'b', name: '规则B', content: 'B内容', enabled: true, order: 1 },
      { id: 'c', name: '规则C', content: 'C内容', enabled: false, order: 2 },
    ],
  });
  rules = moveRule(rules, 'b', 'up'); // B 提到最前
  const txt = buildInjectionText(rules);
  assert.strictEqual(txt, 'B内容\n\nA内容');
  assert.ok(!txt.includes('C内容'), '禁用的 C 不应出现');
});


// ---------- mergeRules（导入合并）----------

const { mergeRules } = require('../../plugins/core-rules/rules-model.js');

test('mergeRules: 同 id 覆盖 name/content/enabled，不新增条目', () => {
  const base = [
    { id: 'a', name: 'A', content: 'old-a', enabled: true, order: 0 },
    { id: 'b', name: 'B', content: 'old-b', enabled: true, order: 1 },
  ];
  const incoming = [{ id: 'a', name: 'A2', content: 'new-a', enabled: false }];
  const out = mergeRules(base, incoming);
  assert.strictEqual(out.length, 2, '同 id 不得新增条目');
  const a = out.find((r) => r.id === 'a');
  assert.strictEqual(a.name, 'A2');
  assert.strictEqual(a.content, 'new-a');
  assert.strictEqual(a.enabled, false);
});

test('mergeRules: 新 id 追加到末尾并重排 order', () => {
  const base = [{ id: 'a', name: 'A', content: 'a', enabled: true, order: 0 }];
  const incoming = [{ id: 'c', name: 'C', content: 'c', enabled: true }];
  const out = mergeRules(base, incoming);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'a', 'base 原序在前');
  assert.strictEqual(out[1].id, 'c', '新条目在末尾');
  assert.strictEqual(out[0].order, 0);
  assert.strictEqual(out[1].order, 1);
});

test('mergeRules: 混合场景（覆盖 + 追加）顺序为 base 原序 + 新条目', () => {
  const base = [
    { id: 'a', name: 'A', content: 'a', enabled: true, order: 0 },
    { id: 'b', name: 'B', content: 'b', enabled: true, order: 1 },
  ];
  const incoming = [
    { id: 'c', name: 'C', content: 'c', enabled: true },
    { id: 'a', name: 'A2', content: 'a2', enabled: true },
    { id: 'd', name: 'D', content: 'd', enabled: true },
  ];
  const out = mergeRules(base, incoming);
  assert.deepStrictEqual(out.map((r) => r.id), ['a', 'b', 'c', 'd']);
  assert.strictEqual(out[0].name, 'A2');
  assert.deepStrictEqual(out.map((r) => r.order), [0, 1, 2, 3]);
});

test('mergeRules: 不修改入参数组', () => {
  const base = [{ id: 'a', name: 'A', content: 'a', enabled: true, order: 0 }];
  const incoming = [{ id: 'a', name: 'A2', content: 'a2', enabled: false }];
  const snapBase = JSON.stringify(base);
  const snapIn = JSON.stringify(incoming);
  mergeRules(base, incoming);
  assert.strictEqual(JSON.stringify(base), snapBase, 'base 不得被修改');
  assert.strictEqual(JSON.stringify(incoming), snapIn, 'incoming 不得被修改');
});

test('mergeRules: 空 base / 空 incoming / 非数组入参', () => {
  assert.strictEqual(mergeRules([], []).length, 0);
  assert.strictEqual(mergeRules([], null).length, 0);
  assert.strictEqual(mergeRules(null, []).length, 0);
  const base = [{ id: 'a', name: 'A', content: 'a', enabled: true, order: 0 }];
  assert.strictEqual(mergeRules(base, null).length, 1, 'incoming 非数组时返回 base 的拷贝');
});
