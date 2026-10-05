'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 最小 DOM 桩：支持 getElementById + createElement（escapeHtml 需要）
function installDom() {
  const nodes = {};
  global.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({
      _text: '',
      set textContent(v) { this._text = v; },
      get textContent() { return this._text; },
      get innerHTML() {
        return String(this._text)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      },
    }),
  };
  nodes['lingya-plan-list'] = { innerHTML: '' };
  nodes['lingya-plan-count'] = { textContent: '' };
  nodes['lingya-plan-tab-count'] = { textContent: '' };
  nodes['lingya-plan-float'] = { classList: { _s: new Set(['lingya-hidden']), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} } };
  nodes['lingya-plan-float-list'] = { innerHTML: '' };
  nodes['lingya-plan-float-count'] = { textContent: '' };
  return nodes;
}

test('renderTodos 输出序号/图标/进度并转义内容', () => {
  const nodes = installDom();
  const { renderTodos } = require('../../src/preload/overlay/plan-panel');
  renderTodos([
    { content: '备份原文件', status: 'pending' },
    { content: '搭建 <slo>', status: 'in_progress' },
    { content: 'Phase3', status: 'completed' },
  ]);
  assert.strictEqual(nodes['lingya-plan-count'].textContent, '1/3');
  assert.strictEqual(nodes['lingya-plan-tab-count'].textContent, ' 1/3');
  assert.strictEqual(nodes['lingya-plan-float-count'].textContent, '1/3');
  assert.ok(nodes['lingya-plan-float-list'].innerHTML.includes('in_progress'));
  assert.ok(!nodes['lingya-plan-float'].classList.contains('lingya-hidden'), '有计划时应显示悬浮卡');
  const html = nodes['lingya-plan-list'].innerHTML;
  assert.ok(html.includes('1.'));
  assert.ok(html.includes('in_progress'));
  assert.ok(html.includes('completed'));
  assert.ok(html.includes('&lt;slo&gt;'), '应转义尖括号');
});

test('renderTodos 空列表显示占位', () => {
  const nodes = installDom();
  const { renderTodos } = require('../../src/preload/overlay/plan-panel');
  renderTodos([]);
  assert.strictEqual(nodes['lingya-plan-count'].textContent, '0/0');
  assert.ok(nodes['lingya-plan-list'].innerHTML.includes('暂无计划'));
});
