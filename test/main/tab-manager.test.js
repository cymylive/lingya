'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ---- mock electron WebContentsView ----
const created = [];
class FakeWC {
  constructor() { this._destroyed = false; this._listeners = {}; this._url = ''; this._title = ''; }
  isDestroyed() { return this._destroyed; }
  close() { this._destroyed = true; }
  setUserAgent() {}
  loadURL(u) { this._url = u; return Promise.resolve(); }
  loadFile(f) { this._url = 'file://' + f; return Promise.resolve(); }
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  emit(ev, ...a) { (this._listeners[ev] || []).forEach(fn => fn({}, ...a)); }
  setWindowOpenHandler(fn) { this._windowOpenHandler = fn; }
  canGoBack() { return true; }
  canGoForward() { return true; }
  goBack() {}
  goForward() {}
  reload() {}
}
class FakeView {
  constructor(opts) { this.webContents = new FakeWC(); this._visible = true; this._bounds = null; created.push(this); }
  setVisible(v) { this._visible = v; }
  setBounds(b) { this._bounds = b; }
}

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { WebContentsView: FakeView };
  return origLoad.apply(this, arguments);
};

const MOD = path.join(process.cwd(), 'src/main/tab-manager.js');
delete require.cache[MOD];
const tm = require(MOD);

function makeCtx() {
  const tabs = new Map();
  const rawWin = {
    isDestroyed: () => false,
    contentView: {
      addChildView: () => {},
      removeChildView: () => {},
    },
  };
  return { rawWin, tabs, activeTabId: null, relayout: () => {}, onTabUpdated: () => {} };
}

test('createTab 创建并激活', () => {
  const ctx = makeCtx();
  const tab = tm.createTab(ctx, { url: 'https://a.com', activate: true });
  assert.ok(tab.id.startsWith('tab-'));
  assert.strictEqual(ctx.tabs.size, 1);
  assert.strictEqual(ctx.activeTabId, tab.id);
  assert.strictEqual(ctx.view, tab.view, 'ctx.view 应指向 active tab');
  assert.strictEqual(tab.view._visible, true);
});

test('createTab activate=false 不激活', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com', activate: true });
  const t2 = tm.createTab(ctx, { url: 'https://b.com', activate: false });
  assert.strictEqual(ctx.activeTabId, t1.id, '仍是第一个 active');
  assert.strictEqual(t2.view._visible, false);
});

test('switchTab 只显示目标', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const t2 = tm.createTab(ctx, { url: 'https://b.com' });
  tm.switchTab(ctx, t1.id);
  assert.strictEqual(t1.view._visible, true);
  assert.strictEqual(t2.view._visible, false);
  assert.strictEqual(ctx.view, t1.view);
});

test('closeTab 关闭非活动标签', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const t2 = tm.createTab(ctx, { url: 'https://b.com' });
  const r = tm.closeTab(ctx, t2.id);
  assert.strictEqual(r.success, true);
  assert.strictEqual(ctx.tabs.size, 1);
  assert.strictEqual(ctx.activeTabId, t1.id, '活动标签不变');
});

test('closeTab 关闭活动标签 → 切到剩余', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const t2 = tm.createTab(ctx, { url: 'https://b.com' });
  assert.strictEqual(ctx.activeTabId, t2.id);
  tm.closeTab(ctx, t2.id);
  assert.strictEqual(ctx.activeTabId, t1.id);
  assert.strictEqual(ctx.view, t1.view);
});

test('closeTab 拒绝关闭主标签', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  t1.isMain = true;
  tm.createTab(ctx, { url: 'https://b.com' });
  const r = tm.closeTab(ctx, t1.id);
  assert.strictEqual(r.success, false);
  assert.ok(r.error.indexOf('主标签') >= 0);
});

test('closeTab 拒绝关闭最后一个', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const r = tm.closeTab(ctx, t1.id);
  assert.strictEqual(r.success, false);
  assert.ok(r.error.indexOf('至少保留') >= 0);
});

test('listTabs 返回正确结构', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const t2 = tm.createTab(ctx, { url: 'https://b.com' });
  t1.title = 'A';
  t2.title = 'B';
  const list = tm.listTabs(ctx);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].title, 'A');
  assert.strictEqual(list[0].active, false);
  assert.strictEqual(list[1].active, true);
});

test('navigate 加载 URL', () => {
  const ctx = makeCtx();
  const t = tm.createTab(ctx, { url: 'https://a.com' });
  const r = tm.navigate(ctx, 'https://new.com', t.id);
  assert.strictEqual(r.success, true);
  assert.strictEqual(t.view.webContents._url, 'https://new.com');
});

test('page-title-updated 更新普通标签 tab.title', () => {
  const ctx = makeCtx();
  const t = tm.createTab(ctx, { url: 'https://a.com' });
  t.view.webContents.emit('page-title-updated', '新标题');
  assert.strictEqual(t.title, '新标题');
});

test('主标签不跟随 page-title-updated', () => {
  const ctx = makeCtx();
  const t = tm.createTab(ctx, { url: 'https://a.com' });
  t.isMain = true;
  t.title = 'LingYa · DeepSeek';
  t.view.webContents.emit('page-title-updated', '网站标题');
  assert.strictEqual(t.title, 'LingYa · DeepSeek', '主标签标题不应被网页标题覆盖');
});

test('setMainTabTitle 更新主标签标题', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  t1.isMain = true;
  tm.createTab(ctx, { url: 'https://b.com' });
  tm.setMainTabTitle(ctx, '我的对话名');
  assert.strictEqual(t1.title, '我的对话名');
});

test('setMainTabTitle 无主标签时不报错', () => {
  const ctx = makeCtx();
  tm.createTab(ctx, { url: 'https://a.com' });
  assert.doesNotThrow(() => tm.setMainTabTitle(ctx, 'x'));
});

test('did-navigate 更新 tab.url', () => {
  const ctx = makeCtx();
  const t = tm.createTab(ctx, { url: 'https://a.com' });
  t.view.webContents.emit('did-navigate', 'https://b.com/x');
  assert.strictEqual(t.url, 'https://b.com/x');
});

// ===== 拦截 window.open / target=_blank =====

test('createTab 注册 setWindowOpenHandler', () => {
  const ctx = makeCtx();
  const tab = tm.createTab(ctx, { url: 'https://a.com' });
  assert.ok(typeof tab.view.webContents._windowOpenHandler === 'function', 'setWindowOpenHandler 应被调用');
});

test('setWindowOpenHandler 对普通 URL 返回 deny 并开新标签', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const before = ctx.tabs.size;
  const handler = t1.view.webContents._windowOpenHandler;
  assert.ok(handler, 'handler 已注册');
  const r = handler({ url: 'https://b.com/page' });
  assert.strictEqual(r.action, 'deny', '应拒绝 Electron 弹独立窗口');
  assert.strictEqual(ctx.tabs.size, before + 1, '应在当前窗口新开一个标签');
  const urls = Array.from(ctx.tabs.values()).map((x) => x.url);
  assert.ok(urls.indexOf('https://b.com/page') >= 0, '新标签 URL 正确');
});

test('setWindowOpenHandler 对 about:blank 只 deny 不开标签', () => {
  const ctx = makeCtx();
  const t1 = tm.createTab(ctx, { url: 'https://a.com' });
  const before = ctx.tabs.size;
  const r = t1.view.webContents._windowOpenHandler({ url: 'about:blank' });
  assert.strictEqual(r.action, 'deny');
  assert.strictEqual(ctx.tabs.size, before, 'about:blank 不应开新标签');
});

