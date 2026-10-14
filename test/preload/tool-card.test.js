/**
 * 工具卡片渲染测试（node --test）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { renderToolCard, escapeHtml, summarizeArgs, formatOutput, TOOL_CARD_CSS, injectToolCardCSS } =
  require('../../src/preload/overlay/tool-card.js');

test('escapeHtml 转义 HTML 特殊字符', () => {
  assert.strictEqual(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.strictEqual(escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
});

test('escapeHtml 处理 null/undefined', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('summarizeArgs 压缩长文本', () => {
  assert.strictEqual(summarizeArgs('echo   hi'), 'echo hi');
  const long = summarizeArgs({ command: 'x'.repeat(200) });
  assert.ok(long.length <= 80, '摘要应 <= 80 字符，实际 ' + long.length);
});

test('summarizeArgs 处理对象', () => {
  assert.strictEqual(summarizeArgs({ file_path: 'a.txt' }), '{"file_path":"a.txt"}');
});

test('formatOutput 字符串原样返回', () => {
  assert.strictEqual(formatOutput('hello'), 'hello');
});

test('formatOutput 对象转 JSON', () => {
  assert.strictEqual(formatOutput({ a: 1 }), '{\n  "a": 1\n}');
});

test('renderToolCard 基础结构', () => {
  const html = renderToolCard({ name: 'bash', args: { command: 'echo hi' }, status: 'success', output: 'hi' });
  assert.ok(html.includes('lingya-tool-card'), '含卡片类');
  assert.ok(html.includes('data-status="success"'), '含状态');
  assert.ok(html.includes('bash'), '含工具名');
  assert.ok(html.includes('echo hi'), '含参数');
  assert.ok(html.includes('成功'), '含状态标签');
});

test('renderToolCard 转义工具输出（防 XSS）', () => {
  const html = renderToolCard({ name: 'bash', args: '', status: 'success', output: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img src=x'), '不应含原始 img 标签');
  assert.ok(html.includes('&lt;img'), '应转义为 &lt;img');
});

test('renderToolCard 折叠状态', () => {
  const collapsed = renderToolCard({ name: 'read', args: 'x', status: 'success', collapsed: true });
  assert.ok(collapsed.includes('data-collapsed="true"'));
  const expanded = renderToolCard({ name: 'read', args: 'x', status: 'success' });
  assert.ok(expanded.includes('data-collapsed="false"'));
});

test('renderToolCard 未知状态降级为 pending', () => {
  const html = renderToolCard({ name: 'x', args: '', status: 'bogus' });
  assert.ok(html.includes('data-status="pending"'));
});

test('renderToolCard 无参数时不渲染参数区块', () => {
  const html = renderToolCard({ name: 'glob', args: '', status: 'success' });
  assert.ok(!html.includes('>参数<'), '无参数不应有参数区块');
});

test('TOOL_CARD_CSS 含关键类与变量', () => {
  assert.ok(TOOL_CARD_CSS.includes('.lingya-tool-card'));
  assert.ok(TOOL_CARD_CSS.includes('--lg-radius-md'));
  assert.ok(TOOL_CARD_CSS.includes('[data-status="error"]'));
});

test('injectToolCardCSS 幂等注入', () => {
  const styles = [];
  const fakeDoc = {
    _els: {},
    head: { appendChild(el) { styles.push(el); } },
    getElementById(id) { return this._els[id] || null; },
    createElement(tag) { return { tag, id: '', textContent: '' }; },
  };
  const s1 = injectToolCardCSS(fakeDoc);
  assert.ok(s1, '首次注入返回 style');
  assert.strictEqual(s1.id, 'lingya-tool-card-style');
  assert.strictEqual(styles.length, 1);
  fakeDoc._els['lingya-tool-card-style'] = s1;
  const s2 = injectToolCardCSS(fakeDoc);
  assert.strictEqual(s2, s1, '重复调用返回同一个 style');
  assert.strictEqual(styles.length, 1, '不应重复插入');
});

test('injectToolCardCSS 无 head 时返回 null', () => {
  assert.strictEqual(injectToolCardCSS(null), null);
  assert.strictEqual(injectToolCardCSS({}), null);
});
