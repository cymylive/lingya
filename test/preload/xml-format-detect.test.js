/**
 * XML/DSML 工具调用格式检测回归测试
 *
 * 背景（2026-10-24 用户截图实测）：
 * AI 输出 `< | DSML | | invoke>` 这种【半角单竖线 + 空格】的变体，
 * 而原正则 /｜｜\s*DSML\s*｜｜/ 要求两个【全角竖线紧邻】，全部漏判。
 * 结果：XML 文本被当成普通回复放过 → 不提示纠正 → 无计划时 Agent 静默停摆。
 *
 * 修复：竖线放宽到 [｜|] 且允许 1~2 个、中间可有空格；
 *       invoke/parameter 前允许任意非 > 字符。
 *
 * 本测试锁住各种变体，防止后续改动收窄正则。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OBSERVER = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'intercept-observer.js');

// 从源码里提取实际的检测逻辑，保证测的是真实实现而不是复制品
function loadDetector() {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  const start = src.indexOf('const hasDsmlMark');
  assert.ok(start > 0, '源码中找不到 hasDsmlMark 定义');
  const end = src.indexOf('if (hasDsmlMark', start);
  assert.ok(end > start, '找不到 if (hasDsmlMark 判定');
  const code = src.slice(start, end);
  // 用 Function 构造器执行真实的四行正则定义
  return new Function('raw', code + '\n return { hasDsmlMark, hasXmlInvoke, hasXmlClose, hasXmlParam };');
}

const detectParts = loadDetector();
function shouldHint(raw) {
  const p = detectParts(raw);
  return p.hasDsmlMark || (p.hasXmlInvoke && (p.hasXmlClose || p.hasXmlParam));
}

test('截图格式：半角单竖线 + 空格（原正则漏判的关键场景）', () => {
  const raw = '< | DSML | | invoke>\n< | DSML | | parameter name="newString" string="true">';
  assert.strictEqual(shouldHint(raw), true, '半角单竖线格式必须被识别');
});

test('全角双竖线（旧正则能认的老格式）仍要命中', () => {
  assert.strictEqual(shouldHint('<｜｜DSML｜｜invoke>'), true);
});

test('半角双竖线', () => {
  assert.strictEqual(shouldHint('<||DSML||invoke>'), true);
});

test('单竖线无空格', () => {
  assert.strictEqual(shouldHint('<|DSML||invoke>'), true);
});

test('完整 antml:invoke + parameter', () => {
  const raw = '<antml:invoke name="bash">\n<antml:parameter name="cmd">ls</antml:parameter>\n</antml:invoke>';
  assert.strictEqual(shouldHint(raw), true);
});

test('完整 invoke（无命名空间前缀）', () => {
  const raw = '<invoke name="bash">\n<parameter name="cmd">ls</parameter>\n</invoke>';
  assert.strictEqual(shouldHint(raw), true);
});

test('普通文本不误判', () => {
  assert.strictEqual(shouldHint('任务已完成，代码在 src/index.js 里。'), false);
});

test('普通 HTML 标签不误判', () => {
  assert.strictEqual(shouldHint('<div class="a"><span>x</span></div>'), false);
});

test('只有 invoke 没有 parameter/close 不判定（避免误伤）', () => {
  assert.strictEqual(shouldHint('<invoke name="bash">'), false);
});

test('检测位置必须在【主流程】的计划续跑之前（保证无计划时也能纠正）', () => {
  const src = fs.readFileSync(OBSERVER, 'utf-8');
  const xmlPos = src.indexOf('if (hasDsmlMark');
  assert.ok(xmlPos > 0, '找不到 XML 检测');
  // continueIfPlanUnfinished 有两处调用：中断分支（靠前）+ 主流程（靠后）。
  // 要比较的是【主流程】那次 —— 取最后一次出现。
  const planPos = src.lastIndexOf('if (await continueIfPlanUnfinished(raw)) return;');
  assert.ok(planPos > 0, '找不到主流程的计划续跑调用');
  assert.ok(xmlPos < planPos, 'XML 检测必须在主流程计划续跑之前，否则无计划会话不会被纠正');
});
