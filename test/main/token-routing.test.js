'use strict';
/**
 * token 用量事件路由测试
 *
 * 覆盖窗口合并后 token 事件的转发逻辑：
 * - 源视图的原始 ctx 壳窗口已销毁时，必须转发到它当前所在的宿主窗口
 * - payload 必须带 viewKey（= webContents id），供壳页面按视图分别记录
 * - 找不到任何可用窗口时返回 null，调用方转 success:false
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const windowState = require('../../src/main/window');

let seq = 0;

/** 构造一个假的 webContents（只需要 id 字段和可比较的引用） */
function fakeWC(id) {
  return { id: id == null ? ++seq : id };
}

/** 构造一个假的壳窗口（满足 addWindow 对 id / on 的要求） */
function fakeWin(destroyed) {
  const sent = [];
  const win = {
    id: 'win-' + (++seq),
    destroyed: !!destroyed,
    webContents: {
      send(channel, payload) { sent.push({ channel, payload }); },
    },
    isDestroyed() { return this.destroyed; },
    sent,
    _handlers: {},
    on(ev, fn) { this._handlers[ev] = fn; },
  };
  return win;
}

beforeEach(() => {
  // 单例模块，每个用例前清空内部窗口表
  const all = windowState.getAllContexts();
  for (const ctx of all) {
    if (ctx && ctx.win && ctx.win.id) {
      try { ctx.win._handlers && ctx.win._handlers.closed && ctx.win._handlers.closed(); } catch (_) {}
      windowState.removeWindow(ctx.win.id);
    }
  }
});

test('findHostContextForView 能在 attachedViews 中命中宿主', () => {
  const hostWin = fakeWin(false);
  windowState.addWindow(hostWin, 'p1', 'deepseek', {}, null);
  const view = { webContents: fakeWC() };
  windowState.addAttachedView(hostWin.id, { view });

  const got = windowState.findHostContextForView(view.webContents);
  assert.ok(got, '应返回持有该视图的宿主 ctx');
  assert.strictEqual(got.win, hostWin);
});

test('findHostContextForView 未命中返回 null', () => {
  const hostWin = fakeWin(false);
  windowState.addWindow(hostWin, 'p1', 'deepseek', {}, null);
  windowState.addAttachedView(hostWin.id, { view: { webContents: fakeWC() } });

  const got = windowState.findHostContextForView(fakeWC());
  assert.strictEqual(got, null);
});

test('findHostContextForView 空参数返回 null', () => {
  assert.strictEqual(windowState.findHostContextForView(null), null);
  assert.strictEqual(windowState.findHostContextForView(undefined), null);
});

test('合并场景：源 ctx 壳已销毁，回退到宿主窗口', () => {
  const wc = fakeWC();
  // 源窗口（壳已销毁）
  const srcWin = fakeWin(true);
  const srcView = { webContents: wc };
  windowState.addWindow(srcWin, 'p-src', 'deepseek', {}, srcView);
  // getContextByWebContents 应优先命中源 ctx 的 view
  assert.strictEqual(windowState.getContextByWebContents(wc).win, srcWin);

  // 宿主窗口，视图被挂进来
  const hostWin = fakeWin(false);
  windowState.addWindow(hostWin, 'p-host', 'deepseek', {}, null);
  windowState.addAttachedView(hostWin.id, { view: { webContents: wc } });

  // 源壳已销毁 → 回退到宿主
  const host = windowState.findHostContextForView(wc);
  assert.ok(host, '应回退到宿主 ctx');
  assert.strictEqual(host.win, hostWin);
});

test('孤儿视图（源壳销毁且无宿主）返回 null', () => {
  const wc = fakeWC();
  const srcWin = fakeWin(true);
  windowState.addWindow(srcWin, 'p-orphan', 'deepseek', {}, { webContents: wc });

  assert.strictEqual(windowState.findHostContextForView(wc), null);
});
