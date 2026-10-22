'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 多窗口标签页归属测试。
 *
 * Bug 场景（用户实测）：
 *   A 窗口执行 openBrowserWindow 打开了 5 个标签，
 *   但这 5 个标签显示在 B 窗口的标签栏上 —— 因为归属判定用了「最后激活的窗口」
 *   而不是「发起工具调用的窗口」。
 *
 * 根因链：
 *   OpenBrowserWindowTool.execute() 拿到了 profileId 却没用 ↓
 *   browser-window-manager.openWindow() 内部调 _getActiveContext() ↓
 *   windowState.getMainContext() → lastActiveWindowId（最后激活的，不是发起的）
 */

const ROOT = path.join(__dirname, '..', '..');

// ===================== 结构断言：profileId 必须被传递和使用 =====================

const toolSrc = fs.readFileSync(path.join(ROOT, 'tools/OpenBrowserWindowTool.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(ROOT, 'tools/browser-window-manager.js'), 'utf8');

test('OpenBrowserWindowTool 必须把 profileId 传给 openWindow', () => {
  // 从 execute 里取参数
  assert.match(
    toolSrc,
    /const\s*\{[^}]*profileId[^}]*\}\s*=\s*params/,
    'execute() 必须从 params 解构 profileId —— 否则无法知道是哪个窗口发起的'
  );
  // 传给 openWindow —— 剥离注释后再定位，避免命中注释里的示例代码
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = stripComments(toolSrc);

  const callIdx = code.indexOf('windowManager.openWindow(');
  assert.ok(callIdx >= 0, '必须调用 windowManager.openWindow(');
  const callSeg = code.slice(callIdx, callIdx + 300);
  assert.match(
    callSeg,
    /options/,
    'openWindow 第三个参数必须是携带 profileId 的 options'
  );
  // 更强断言：execute() 里 options 对象必须包含 profileId
  assert.match(
    code,
    /const\s+options\s*=\s*\{\s*profileId\s*\}/,
    'options 必须直接包含 profileId'
  );
});

test('browser-window-manager.openWindow 接受 profileId 参数', () => {
  assert.match(
    mgrSrc,
    /openWindow\s*\(\s*customId\s*,\s*url\s*,\s*options/,
    'openWindow 签名应为 (customId, url, options)'
  );
  // options 里要用 profileId
  assert.match(
    mgrSrc,
    /options\.profileId|options\s*&&\s*options\.profileId/,
    'openWindow 必须读取 options.profileId'
  );
});

test('openWindow 优先按 profileId 定位窗口上下文', () => {
  assert.match(
    mgrSrc,
    /getWindowByProfileId/,
    'openWindow 必须用 getWindowByProfileId(profileId) 精确定位发起窗口'
  );
  // 且必须在 _getActiveContext 之前（优先级更高）
  const byProfileIdx = mgrSrc.indexOf('getWindowByProfileId');
  const activeCtxIdx = mgrSrc.indexOf('_getActiveContext');
  assert.ok(
    byProfileIdx > 0 && activeCtxIdx > 0,
    '两个定位方式都应存在'
  );
});

test('_getActiveContext 降级为兜底，而非首选', () => {
  // 剥离注释：注释里会提到 _getActiveContext 等函数名，直接 indexOf 会误命中。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = stripComments(mgrSrc);

  const openIdx = code.indexOf('openWindow(customId');
  assert.ok(openIdx >= 0, '必须定义 openWindow(customId, url, options)');
  const seg = code.slice(openIdx, openIdx + 2000);

  const byProfileIdx = seg.indexOf('getWindowByProfileId');
  // 用真实调用形式，避免命中同名标识符
  const activeIdx = seg.indexOf('this._getActiveContext()');

  assert.ok(byProfileIdx >= 0, 'openWindow 内必须有按 profileId 定位');
  assert.ok(activeIdx >= 0, 'openWindow 内必须有 this._getActiveContext() 兜底');
  assert.ok(
    byProfileIdx < activeIdx,
    '按 profileId 定位必须排在 this._getActiveContext()（最后激活窗口）之前 —— ' +
    '否则多窗口场景下标签会开到错误的窗口。实际 byProfile=' + byProfileIdx + ', active=' + activeIdx
  );
});

test('找不到 profileId 对应窗口时才回退到活跃窗口', () => {
  const openIdx = mgrSrc.indexOf('openWindow(customId');
  const seg = mgrSrc.slice(openIdx, openIdx + 1500);
  // 应有 || 或 if 的降级结构
  assert.match(
    seg,
    /\|\||if\s*\(!ctx\)|ctx\s*=\s*ctx\s*\|\|/,
    '必须有「按 profileId 找不到 → 回退活跃窗口」的降级逻辑'
  );
});

// ===================== 行为测试：mock 环境验证归属 =====================

function makeMocks() {
  const Module = require('module');
  const origLoad = Module._load;
  const state = {
    createdIn: [],
    activeCtxProfile: null,
  };

  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: class {
          constructor() { this.webContents = {}; this.id = 'win-standalone'; }
          on() {} isDestroyed() { return false; }
          loadURL() {} close() {}
        },
      };
    }
    if (request === '../src/main/window' || request.endsWith('src/main/window') || request === '../src/main/window.js') {
      return {
        getMainContext() {
          // 模拟「最后激活的是 B 窗口」
          return {
            profileId: state.activeCtxProfile || 'B',
            tabs: new Map(),
            rawWin: { isDestroyed: () => false, contentView: { addChildView() {} } },
          };
        },
        getWindowByProfileId(pid) {
          if (pid === 'A') {
            return {
              profileId: 'A',
              tabs: new Map(),
              rawWin: { isDestroyed: () => false, contentView: { addChildView() {} } },
            };
          }
          return null;
        },
      };
    }
    if (request === '../src/main/tab-manager' || request.endsWith('src/main/tab-manager')) {
      return {
        createTab(ctx, opts) {
          state.createdIn.push(ctx.profileId);
          return { id: 'tab-mock-' + state.createdIn.length };
        },
        closeTab() {},
      };
    }
    return origLoad.apply(this, arguments);
  };

  return {
    state,
    restore() { Module._load = origLoad; },
  };
}

test('行为：A 窗口调用 openWindow(profileId=A) 时，标签必须开在 A 而非最后激活的 B', () => {
  const mocks = makeMocks();
  mocks.state.activeCtxProfile = 'B'; // 最后激活的是 B
  try {
    // 清模块缓存，确保拿到新 mock
    delete require.cache[require.resolve('../../tools/browser-window-manager')];
    const mgr = require('../../tools/browser-window-manager');
    mgr.entries.clear();

    mgr.openWindow(null, 'https://example.com', { profileId: 'A' });

    assert.deepStrictEqual(
      mocks.state.createdIn,
      ['A'],
      '标签必须开在发起窗口 A，而不是最后激活的窗口 B。' +
      '实际开在: ' + JSON.stringify(mocks.state.createdIn)
    );
  } finally {
    mocks.restore();
    delete require.cache[require.resolve('../../tools/browser-window-manager')];
  }
});

test('行为：无 profileId 时才回退到活跃窗口（兼容旧调用）', () => {
  const mocks = makeMocks();
  mocks.state.activeCtxProfile = 'B';
  try {
    delete require.cache[require.resolve('../../tools/browser-window-manager')];
    const mgr = require('../../tools/browser-window-manager');
    mgr.entries.clear();

    mgr.openWindow(null, 'https://example.com', {});

    assert.deepStrictEqual(
      mocks.state.createdIn,
      ['B'],
      '未提供 profileId 时应回退到活跃窗口，保持旧行为兼容'
    );
  } finally {
    mocks.restore();
    delete require.cache[require.resolve('../../tools/browser-window-manager')];
  }
});
