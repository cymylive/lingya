'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('randomDelay 返回 2000-3999ms', () => {
  const { randomDelay } = require('../../src/preload/dom/chat-input');
  for (let i = 0; i < 10; i++) {
    const d = randomDelay();
    assert.ok(d >= 2000 && d <= 3999);
  }
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
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const mkEl = () => {
    let text = '';
    return {
      set textContent(v) { text = String(v); },
      get textContent() { return text; },
      get innerHTML() { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
      set innerHTML(v) {},
      style: {},
    };
  };
  global.document = { getElementById: () => el, createElement: () => mkEl() };
  global.window = { electronAPI: { listSessions: async () => ({ success: true, sessions: ['abc'] }) } };
  const { renderSessions } = require('../../src/preload/dom/session-list');
  await renderSessions();
  assert.match(el.innerHTML, /abc/);
});

test('FileReadTool line_numbers 与 escaped format', async () => {
  const fs = require('fs');
  const path = require('path');
  const { FileReadTool } = require('../../tools/FileReadTool');
  const tmp = path.join(process.cwd(), 'test', 'tmp', 'fileread-extra');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2');
  const tool = new FileReadTool();
  const r1 = await tool.execute({ file_path: 'a.txt', projectDir: tmp, line_numbers: true });
  assert.match(r1.data, /1: line1/);
  assert.match(r1.data, /2: line2/);
  const r2 = await tool.execute({ file_path: 'a.txt', projectDir: tmp, format: 'escaped' });
  assert.strictEqual(typeof r2.data, 'string');
  assert.ok(r2.data.startsWith('"'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
