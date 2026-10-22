'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('initialDelay 返回首条消息兜底延迟', () => {
  const { initialDelay } = require('../../src/preload/dom/chat-input');
  const d = initialDelay();
  assert.ok(typeof d === 'number' && d >= 0);
});

test('updateProjectDirDisplay 更新显示', () => {
  const span = { textContent: '' };
  const section = { style: {} };
  global.document = {
    getElementById: (id) => id === 'lingya-project-dir-display' ? { querySelector: () => span } : null,
    querySelector: (sel) => sel === '.lingya-project-dir-section' ? section : null,
  };
  const { updateProjectDirDisplay } = require('../../src/preload/overlay/project-dir');
  updateProjectDirDisplay('C:\\proj');
  assert.strictEqual(span.textContent, 'C:\\proj');
  assert.strictEqual(section.style.display, '');
  updateProjectDirDisplay(null);
  assert.strictEqual(span.textContent, '未选择');
  assert.strictEqual(section.style.display, 'none');
});

test('renderSessions API 不可用显示提示', async () => {
  const el = { innerHTML: '' };
  global.document = { getElementById: () => el };
  global.window = {};
  const { renderSessions } = require('../../src/preload/dom/session-list');
  await renderSessions();
  assert.match(el.innerHTML, /API 不可用/);
});

test('renderSessions 无会话显示暂无', async () => {
  const el = { innerHTML: '', querySelectorAll: () => [] };
  global.document = { getElementById: () => el };
  global.window = { electronAPI: { listSessions: async () => ({ success: true, sessions: [] }) } };
  const { renderSessions } = require('../../src/preload/dom/session-list');
  await renderSessions();
  assert.match(el.innerHTML, /暂无会话/);
});

test('renderSessions 有会话渲染并绑定', async () => {
  // 完整清理 preload 模块树，避免前面测试的缓存污染
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('src/preload') >= 0) delete require.cache[k];
  }

  const el = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  // 注意：escapeHtml 内部用 createElement + innerHTML 做转义，
  // 所以 mock 的 innerHTML 必须可读可写，且要模拟浏览器把 < > & 转成实体
  const mkEl = () => {
    let text = '';
    let html = '';
    return {
      set textContent(v) { text = String(v); html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
      get textContent() { return text; },
      set innerHTML(v) { html = String(v); text = String(v); },
      get innerHTML() { return html; },
      style: {},
    };
  };
  global.document = {
    getElementById: () => el,
    createElement: () => mkEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: () => {}, children: [] },
    head: { appendChild: () => {} },
    addEventListener: () => {},
    readyState: 'complete',
  };
  global.localStorage = {
    _s: {},
    getItem(k) { return this._s[k] || null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  };
  global.window = { electronAPI: { listSessions: async () => ({ success: true, sessions: ['abc'] }) } };
  global.location = { href: 'https://chat.deepseek.com/' };
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;

  // 捕获 renderSessions 内部的 console.error，把真实异常暴露出来
  const origErr = console.error;
  let captured = null;
  console.error = (...a) => { captured = a.map(String).join(' '); };
  try {
    const { renderSessions } = require('../../src/preload/dom/session-list');
    await renderSessions();
  } finally {
    console.error = origErr;
  }
  if (captured) origErr('[captured]', captured);
  assert.match(el._html, /abc/);
});
