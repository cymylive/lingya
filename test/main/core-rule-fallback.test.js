'use strict';
/**
 * 核心规则占位符兜底回归测试
 *
 * 背景事故：用户自定义提示词模板（lingya-prompt-templates.json 的 overrides）
 * 漏写了 {{CORE_RULE_REPORT}} 占位符。project-context 里 CORE_RULE_REPORT 属于
 * RESERVED_SECTION_KEYS，被排除在 {{PLUGIN_CUSTOM_SECTION}} 通用通道之外，
 * 于是 core-rules 插件注册的规则内容无处落地，被静默丢弃 —— 表现为
 * 「插件装好了、enabled=true、重新初始化项目也不生效」。
 *
 * 修复：当模板缺少对应保留占位符时，把这些内容并入 {{PLUGIN_CUSTOM_SECTION}}。
 * 本测试锁定该兜底行为。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { applyCoreRuleFallback } = require('../../src/main/core-rule-fallback');

const REPORT = '## 铁律：需求先汇报，等确认再动手\n\n【理解】……';

test('模板含 {{CORE_RULE_REPORT}} 时不改动 pluginCustomSection', () => {
  const tpl = '# 身份\n{{CORE_RULE_REPORT}}\n{{PLUGIN_CUSTOM_SECTION}}';
  const out = applyCoreRuleFallback(tpl, 'EXISTING', { CORE_RULE_REPORT: REPORT });
  assert.strictEqual(out, 'EXISTING');
});

test('模板缺 {{CORE_RULE_REPORT}} 时并入 {{PLUGIN_CUSTOM_SECTION}}', () => {
  const tpl = '# 身份\n{{PLUGIN_CUSTOM_SECTION}}\n后文';
  const out = applyCoreRuleFallback(tpl, '', { CORE_RULE_REPORT: REPORT });
  assert.ok(out.includes('铁律：需求先汇报'), '规则内容应被并入，实际: ' + out);
});

test('已有自定义 section 时保持顺序：自定义在前，兜底规则在后', () => {
  const tpl = '{{PLUGIN_CUSTOM_SECTION}}';
  const out = applyCoreRuleFallback(tpl, 'CUSTOM_PART', { CORE_RULE_REPORT: REPORT });
  const iCustom = out.indexOf('CUSTOM_PART');
  const iRule = out.indexOf('铁律：需求先汇报');
  assert.ok(iCustom >= 0 && iRule >= 0, '两段都应存在');
  assert.ok(iCustom < iRule, '自定义 section 应排在兜底规则之前');
});

test('模板连 {{PLUGIN_CUSTOM_SECTION}} 都没有时不改动（无从落地，交给日志告警）', () => {
  const tpl = '# 身份\n没有占位符';
  const out = applyCoreRuleFallback(tpl, 'EXISTING', { CORE_RULE_REPORT: REPORT });
  assert.strictEqual(out, 'EXISTING');
});

test('空内容 / 纯空白内容不触发兜底', () => {
  const tpl = '{{PLUGIN_CUSTOM_SECTION}}';
  assert.strictEqual(applyCoreRuleFallback(tpl, '', { CORE_RULE_REPORT: '' }), '');
  assert.strictEqual(applyCoreRuleFallback(tpl, '', { CORE_RULE_REPORT: '   \n ' }), '');
});

test('多个缺失的保留 key 都会被并入', () => {
  const tpl = '{{PLUGIN_CUSTOM_SECTION}}';
  const out = applyCoreRuleFallback(tpl, '', {
    CORE_RULE_REPORT: 'AAA_RULE',
    CORE_RULE_IRREVERSIBLE: 'BBB_RULE',
  });
  assert.ok(out.includes('AAA_RULE'));
  assert.ok(out.includes('BBB_RULE'));
});

test('模板含其中一个占位符、缺另一个时，只并入缺失的那个', () => {
  const tpl = '{{CORE_RULE_REPORT}}\n{{PLUGIN_CUSTOM_SECTION}}';
  const out = applyCoreRuleFallback(tpl, '', {
    CORE_RULE_REPORT: 'AAA_RULE',
    CORE_RULE_IRREVERSIBLE: 'BBB_RULE',
  });
  assert.ok(!out.includes('AAA_RULE'), '已有序号的占位符不应重复并入');
  assert.ok(out.includes('BBB_RULE'), '缺失的应被并入');
});
