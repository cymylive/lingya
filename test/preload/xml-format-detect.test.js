/**
 * XML/DSML 工具调用格式检测回归测试
 *
 * 背景（2026-10-24 用户截图实测）：
 * AI 输出 `< | DSML | | invoke>` 这种【半角单竖线 + 空格】的变体，
 * 而原正则 /｜｜\s*DSML\s*｜｜/ 要求两个【全角竖线紧邻】，全部漏判。
 * 结果：XML 文本被当成普通回复放过 → 不提示纠正 → Agent 静默停摆。
 *
 * 【2026-10-25 重构】检测逻辑已抽成 src/preload/dom/xml-detect.js 纯函数。
 * 原测试靠「扫 intercept-observer.js 源码找字符串」验证，抽函数后会误报。
 * 现改为直接 require 真实函数 —— 既保持「测真实实现而非复制品」的意图，
 * 又不受文件结构调整影响。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { detectXmlFormat } = require('../../src/preload/dom/xml-detect');

const OBSERVER = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'intercept-observer.js');

test('截图格式：半角单竖线 + 空格（原正则漏判的关键场景）', () => {
  const raw = '< | DSML | | invoke>\n< | DSML | | parameter name="newString" string="true">';
  assert.strictEqual(detectXmlFormat(raw), true, '半角单竖线格式必须被识别');
});

test('全角双竖线（旧正则能认的老格式）仍要命中', () => {
  assert.strictEqual(detectXmlFormat('<｜｜DSML｜｜invoke>'), true);
});

test('半角双竖线', () => {
  assert.strictEqual(detectXmlFormat('<||DSML||invoke>'), true);
});

test('单竖线无空格', () => {
  assert.strictEqual(detectXmlFormat('<|DSML||invoke>'), true);
});

test('完整 antml:invoke + parameter', () => {
  const raw = '<antml:invoke name="bash">\n<antml:parameter name="cmd">ls</antml:parameter>\n</antml:invoke>';
  assert.strictEqual(detectXmlFormat(raw), true);
});

test('完整 invoke（无命名空间前缀）', () => {
  const raw = '<invoke name="bash">\n<parameter name="cmd">ls</parameter>\n</invoke>';
  assert.strictEqual(detectXmlFormat(raw), true);
});

test('普通文本不误判', () => {
  assert.strictEqual(detectXmlFormat('任务已完成，代码在 src/index.js 里。'), false);
});

test('普通 HTML 标签不误判', () => {
  assert.strictEqual(detectXmlFormat('<div class="a"><span>x</span></div>'), false);
});

test('只有 invoke 没有 parameter/close 不判定（避免误伤）', () => {
  assert.strictEqual(detectXmlFormat('<invoke name="bash">'), false);
});

test('空输入不误判', () => {
  assert.strictEqual(detectXmlFormat(''), false);
  assert.strictEqual(detectXmlFormat(null), false);
  assert.strictEqual(detectXmlFormat(undefined), false);
});

