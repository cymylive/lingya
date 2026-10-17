'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ===== DOM stub =====
function makeEl(tag, opts) {
  opts = opts || {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], _listeners: {}, textContent: opts.text || '',
    dataset: {}, style: {}, id: opts.id || '', isContentEditable: false,
    _fontSize: opts.fontSize || 14, _top: opts.top || 0, _left: opts.left || 0, _class: opts.className || '',
    classList: { _s: new Set((opts.className || '').split(/\s+/).filter(Boolean)),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c);}, contains(c){return this._s.has(c);} },
    getAttribute(k) { return this.dataset[k] || null; },
    setAttribute(k, v) { this.dataset[k] = v; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    getBoundingClientRect() { return { top: this._top, left: this._left, width: 100, height: 20 }; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(this); return out;
    },
  };
  return el;
}
function matches(el, sel) {
  // 简化：支持 a[href*="..."] 与 * 与 div
  const hrefSel = sel.match(/^a\[href\*="([^"]+)"\]$/);
  if (hrefSel) return el.tagName === 'A' && String(el.href || '').indexOf(hrefSel[1]) >= 0;
  if (sel === '*') return true;
  if (sel === 'div') return el.tagName === 'DIV';
  if (sel === 'body') return el.tagName === 'BODY';
  return false;
}

function buildPage(cfg) {
  // cfg: { sessionId, sidebarText, pageTitleText, pageTop, pageLeft, pageFontSize }
  const body = makeEl('body');
  const container = makeEl('div');
  body.appendChild(container);

  const a = makeEl('a', { className: 'sidebar-link' });
  a.href = '/a/chat/s/' + cfg.sessionId;
  const sbDiv = makeEl('div', { text: cfg.sidebarText || '' });
  a.appendChild(sbDiv);
  container.appendChild(a);

  const pageTitle = makeEl('div', { text: cfg.pageTitleText || '', top: cfg.pageTop == null ? 13 : cfg.pageTop, left: cfg.pageLeft == null ? 268 : cfg.pageLeft, fontSize: cfg.pageFontSize || 14 });
  container.appendChild(pageTitle);

  return { body, container, a, sbDiv, pageTitle };
}

function installGlobals(page, url) {
  global.document = {
    body: page.body,
    querySelector: (sel) => page.container.querySelectorAll(sel)[0] || null,
    querySelectorAll: (sel) => page.container.querySelectorAll(sel),
    addEventListener: () => {},
  };
  global.location = { href: url || 'https://chat.deepseek.com/a/chat/s/abc12345-0000' };
  global.window = global;
  global.getComputedStyle = (el) => ({ fontSize: String(el._fontSize || 14) + 'px' });
  global.MutationObserver = class { observe(){} disconnect(){} };
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;
  global.localStorage = { getItem: () => JSON.stringify({ value: 'FAKE_TOKEN' }) };
  global.fetch = async () => ({ ok: true, json: async () => ({ code: 0 }) });
}

// ===== 加载模块 =====
const modPath = path.join(process.cwd(), 'src/preload/dom/page-title-sync.js');
delete require.cache[modPath];

test('sessionIdFromUrl 支持 /a/chat/s/ 格式', () => {
  const page = buildPage({ sessionId: 'abc12345-0000' });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  assert.strictEqual(m._internal.sessionIdFromUrl('https://chat.deepseek.com/a/chat/s/a7126f2e-b336-4863'), 'a7126f2e-b336-4863');
  assert.strictEqual(m._internal.sessionIdFromUrl('https://chat.deepseek.com/'), null);
});

test('findSidebarTitleEl 找到 a[href] 内的叶子 div', () => {
  const page = buildPage({ sessionId: 'abc12345-0000', sidebarText: '旧标题' });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  const el = m._internal.findSidebarTitleEl('abc12345-0000');
  assert.ok(el, '应找到侧栏标题元素');
  assert.strictEqual(el.textContent, '旧标题');
});

test('findSidebarTitleEl 找不到返回 null', () => {
  const page = buildPage({ sessionId: 'other-xxxx' });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  assert.strictEqual(m._internal.findSidebarTitleEl('no-such-id'), null);
});

test('findPageTitleEl 找到顶部标题（top=13 left=268）', () => {
  const page = buildPage({ sessionId: 'abc12345-0000', pageTitleText: '会话标题', pageTop: 13, pageLeft: 268 });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  const el = m._internal.findPageTitleEl();
  assert.ok(el, '应找到页面标题元素');
  assert.strictEqual(el.textContent, '会话标题');
});

test('findPageTitleEl 排除按钮文字（开启新对话）', () => {
  const page = buildPage({ sessionId: 'abc12345-0000', pageTitleText: '开启新对话', pageTop: 10 });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  assert.strictEqual(m._internal.findPageTitleEl(), null, '按钮文字不应被当成标题');
});

test('findPageTitleEl 排除侧边栏区域（left<150）', () => {
  const page = buildPage({ sessionId: 'abc12345-0000', pageTitleText: '侧栏文本', pageTop: 10, pageLeft: 50 });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  assert.strictEqual(m._internal.findPageTitleEl(), null);
});

test('findPageTitleEl 优先精确匹配旧标题', () => {
  const body = makeEl('body');
  const wrap = makeEl('div');
  body.appendChild(wrap);
  const elA = makeEl('div', { text: '别的文本', top: 5, left: 300, fontSize: 16 });
  const elB = makeEl('div', { text: '目标旧标题', top: 20, left: 250, fontSize: 14 });
  wrap.appendChild(elA); wrap.appendChild(elB);
  const page = { body, container: wrap };
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  const hit = m._internal.findPageTitleEl('目标旧标题');
  assert.strictEqual(hit, elB, '应优先返回与旧标题精确匹配的元素');
});

test('pickApi 识别 DeepSeek 平台', () => {
  const page = buildPage({ sessionId: 'abc12345-0000' });
  installGlobals(page, 'https://chat.deepseek.com/');
  delete require.cache[modPath];
  const m = require(modPath);
  const api = m._internal.pickApi();
  assert.ok(api, '应识别 DeepSeek 平台');
});

test('pickApi 未知平台返回 null', () => {
  const page = buildPage({ sessionId: 'abc12345-0000' });
  installGlobals(page, 'https://example.com/');
  delete require.cache[modPath];
  const m = require(modPath);
  assert.strictEqual(m._internal.pickApi(), null);
});

test('syncSessionTitle 空参数返回错误', async () => {
  const page = buildPage({ sessionId: 'abc12345-0000' });
  installGlobals(page);
  delete require.cache[modPath];
  const m = require(modPath);
  const r = await m.syncSessionTitle('', '标题');
  assert.strictEqual(r.api.ok, false);
});

test('syncSessionTitle 调 API 并双写 DOM（当前会话）', async () => {
  const page = buildPage({ sessionId: 'abc12345-0000', sidebarText: '旧标题', pageTitleText: '旧标题', pageTop: 13, pageLeft: 268 });
  installGlobals(page, 'https://chat.deepseek.com/a/chat/s/abc12345-0000');
  let fetchCalled = null;
  global.fetch = async (url, init) => { fetchCalled = { url, body: init && init.body }; return { ok: true, json: async () => ({ code: 0 }) }; };
  delete require.cache[modPath];
  const m = require(modPath);
  const r = await m.syncSessionTitle('abc12345-0000', '新标题');
  assert.strictEqual(r.api.ok, true, 'API 应成功');
  assert.strictEqual(r.current, true, '应为当前会话');
  assert.strictEqual(page.sbDiv.textContent, '新标题', '侧栏标题应更新');
  assert.strictEqual(page.pageTitle.textContent, '新标题', '页面标题应更新');
  assert.ok(fetchCalled, '应调用了 fetch');
  assert.ok(fetchCalled.url.indexOf('update_title') >= 0);
  assert.ok(fetchCalled.body.indexOf('abc12345-0000') >= 0);
});

test('syncSessionTitle 非当前会话只改侧边栏', async () => {
  const page = buildPage({ sessionId: 'other-session-id-xx', sidebarText: '别的旧标题' });
  installGlobals(page, 'https://chat.deepseek.com/a/chat/s/aa0000ab-1111-2222-3333-444455556666');
  global.fetch = async () => ({ ok: true, json: async () => ({ code: 0 }) });
  delete require.cache[modPath];
  const m = require(modPath);
  const r = await m.syncSessionTitle('other-session-id-xx', '新名');
  assert.strictEqual(r.current, false, '非当前会话');
  assert.strictEqual(page.sbDiv.textContent, '新名', '侧栏应更新');
});

test('syncSessionTitle API 失败时仍尝试 DOM', async () => {
  const page = buildPage({ sessionId: 'abc12345-0000', sidebarText: '旧标题', pageTitleText: '旧标题', pageTop: 13, pageLeft: 268 });
  installGlobals(page, 'https://chat.deepseek.com/a/chat/s/abc12345-0000');
  global.fetch = async () => ({ ok: false, json: async () => ({ code: 40000 }) });
  delete require.cache[modPath];
  const m = require(modPath);
  const r = await m.syncSessionTitle('abc12345-0000', '兜底标题');
  assert.strictEqual(r.api.ok, false);
  assert.strictEqual(page.sbDiv.textContent, '兜底标题', 'DOM 仍应生效');
  assert.strictEqual(page.pageTitle.textContent, '兜底标题');
});

test('未登录（无 userToken）API 返回错误', async () => {
  const page = buildPage({ sessionId: 'abc12345-0000' });
  installGlobals(page);
  global.localStorage = { getItem: () => null };
  delete require.cache[modPath];
  const m = require(modPath);
  const r = await m.syncSessionTitle('abc12345-0000', 'X');
  assert.strictEqual(r.api.ok, false);
  assert.ok(r.api.error.indexOf('未登录') >= 0);
});
