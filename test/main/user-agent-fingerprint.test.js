'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ua = require('../../src/main/user-agent');

const C = String.fromCharCode(67, 104, 114, 111, 109, 101);
const W = String.fromCharCode(87, 105, 110, 100, 111, 119, 115);
const NC = String.fromCharCode(91, 110, 97, 116, 105, 118, 101, 32, 99, 111, 100, 101, 93); // [native code]

test('buildChromeUserAgent 不含 Electron 标识', () => {
  const u = ua.buildChromeUserAgent();
  assert.ok(!/Electron/i.test(u), 'UA 不得含 Electron');
  assert.ok(u.indexOf('Mozilla/5.0') === 0);
  assert.ok(u.indexOf(C + '/') > 0);
});

test('UA 的 OS 段与 process.platform 一致', () => {
  const u = ua.buildChromeUserAgent();
  const os = ua.detectOS();
  assert.ok(u.indexOf(os.uaSegment) > 0);
  if (process.platform === 'win32') assert.ok(u.indexOf(W + ' NT') > 0);
  if (process.platform === 'darwin') assert.ok(u.indexOf('Macintosh') > 0);
  if (process.platform === 'linux') assert.ok(u.indexOf('X11') > 0);
});

test('detectOS 返回完整字段且平台与 process.platform 对应', () => {
  const os = ua.detectOS();
  assert.equal(typeof os.uaSegment, 'string');
  assert.equal(typeof os.platform, 'string');
  assert.equal(typeof os.arch, 'string');
  assert.equal(typeof os.bitness, 'string');
  assert.equal(os.mobile, false);
  const expect = { win32: W, darwin: 'macOS', linux: 'Linux' }[process.platform];
  if (expect) assert.equal(os.platform, expect);
});

test('Client Hints 的 platform 与 detectOS 一致', () => {
  const h = ua.buildClientHintsHeaders();
  const os = ua.detectOS();
  assert.equal(h['sec-ch-ua-platform'], '"' + os.platform + '"');
  assert.ok(h['sec-ch-ua'].indexOf('Google ' + C) >= 0);
  assert.ok(h['sec-ch-ua-mobile'] === '?0' || h['sec-ch-ua-mobile'] === '?1');
});

test('buildNativeMask 输出包含遮罩机制关键结构', () => {
  const src = ua.buildNativeMask();
  assert.ok(src.indexOf('WeakMap') >= 0, '必须用 WeakMap 记录被 patch 的函数');
  assert.ok(src.indexOf('Symbol.for') >= 0, '必须用 Symbol 暴露 mark');
  assert.ok(src.indexOf('Function.prototype') >= 0, '必须改写 Function.prototype.toString');
  assert.ok(src.indexOf('origToString') >= 0, '必须保留原始 toString');
  assert.ok(src.indexOf('lyNativeMask') >= 0, '必须暴露 lyNativeMask 句柄');
});

test('buildUserAgentDataFix 用命名 getter 并调用 native mask', () => {
  const src = ua.buildUserAgentDataFix();
  assert.ok(src.indexOf('uadGetter') >= 0);
  assert.ok(src.indexOf('wdGetter') >= 0);
  assert.ok(src.indexOf('lyNativeMask') >= 0);
  assert.ok(src.indexOf(NC) >= 0, 'mark 的 label 必须含 native code 标记');
});

test('buildChromeObjectFix 保留 chrome.loadTimes（真 Chrome 仍有）', () => {
  const src = ua.buildChromeObjectFix();
  assert.ok(src.indexOf('loadTimes') >= 0);
  assert.ok(src.indexOf('csi') >= 0);
  assert.ok(src.indexOf('runtime') >= 0);
});

test('detectOS 与 buildNativeMask 已导出', () => {
  assert.equal(typeof ua.detectOS, 'function');
  assert.equal(typeof ua.buildNativeMask, 'function');
});
