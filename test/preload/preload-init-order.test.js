'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 架构不变量测试：preload init() 里的「核心执行链路」必须排在「纯 UI 初始化」之前，
 * 且必须被独立的 try/catch 包裹。
 *
 * 背景（0.6.94 静默停摆 bug）：
 *   原实现把 startInterceptObserver() 埋在同一个 try 块里、排在 ui.injectCSS()/
 *   injectOverlay()/bindEvents() 之后。任一步 UI 抛异常 → catch → 事件监听器从未注册
 *   → AI 回复到达但无人接收 → 工具永不执行。而 catch 里的 forceShowOverlay()
 *   又把面板强行显示出来，伪装成"一切正常"，用户完全无从发现。
 *
 * 这类缺陷不能靠运行时测试覆盖（需要真实 DOM 异常），只能锁死源码结构。
 */

const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'),
  'utf8'
);

/** 取 init() 函数体源码 */
function extractInitBody(src) {
  const start = src.indexOf('function init()');
  assert.ok(start >= 0, 'index.js 必须定义 function init()');
  return src.slice(start);
}

const INIT_BODY = extractInitBody(INDEX_SRC);

/**
 * 去掉注释，避免注释里提到的函数名被误当成真实调用。
 * 只保留代码本体用于位置比较。
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http://）
}

const CODE = stripComments(INIT_BODY);

function pos(needle, label) {
  const i = CODE.indexOf(needle);
  assert.ok(
    i >= 0,
    'init() 中必须出现真实调用: ' + (label || needle) +
    '（注意：已剥离注释，仅匹配可执行代码）'
  );
  return i;
}

// 真实调用点（带接收者，不会与注释里的裸函数名混淆）
const OBSERVER_CALL = 'interceptObserver.startInterceptObserver()';

test('核心链路：startInterceptObserver 必须在 UI 初始化之前调用', () => {
  const observerPos = pos(OBSERVER_CALL);
  const uiPos = pos('ui.injectCSS', 'ui.injectCSS()');
  assert.ok(
    observerPos < uiPos,
    'startInterceptObserver 必须排在 ui.injectCSS 之前 —— ' +
    '否则任何 UI 异常都会让事件监听器永不注册（0.6.94 静默停摆根因）。' +
    '实际位置 observer=' + observerPos + ', injectCSS=' + uiPos
  );
});

test('核心链路：startInterceptObserver 必须早于 injectOverlay / bindEvents', () => {
  const observerPos = pos(OBSERVER_CALL);
  assert.ok(observerPos < pos('ui.injectOverlay', 'ui.injectOverlay()'), '应早于 ui.injectOverlay');
  assert.ok(observerPos < pos('bindEvents()', 'bindEvents()'), '应早于 bindEvents');
});

test('核心链路：startInterceptObserver 不得与 ui.injectCSS 处于同一个 try 块', () => {
  // 用缩进层级判定：找到 observer 调用所在行的缩进，
  // 再确认 ui.injectCSS 的缩进更深（说明它在后续嵌套块里）或两者之间隔着 catch。
  const observerPos = pos(OBSERVER_CALL);
  const uiPos = pos('ui.injectCSS', 'ui.injectCSS()');

  // 若 observer 在 ui 之后 → 直接失败（顺序错）
  assert.ok(observerPos < uiPos, 'startInterceptObserver 必须在 ui.injectCSS 之前');

  // 两者之间必须出现 catch（说明 observer 所处的 try 已经闭合，是独立块）
  const between = CODE.slice(observerPos, uiPos);
  assert.ok(
    between.includes('catch'),
    'startInterceptObserver 与 ui.injectCSS 之间必须有一个 catch —— ' +
    '说明它们不在同一个 try 块中，UI 异常不会连带杀死执行链路'
  );
});

test('核心链路：startInterceptObserver 必须有独立 try/catch 保护', () => {
  const observerPos = pos(OBSERVER_CALL);
  // 往前找最近的 try {（中间不能有未配对的 }
  const before = CODE.slice(Math.max(0, observerPos - 300), observerPos);
  const lastTry = before.lastIndexOf('try {');
  assert.ok(lastTry >= 0, 'startInterceptObserver 调用前应有 try {');

  // 往后 400 字符内应有配对 catch
  const after = CODE.slice(observerPos, observerPos + 400);
  assert.ok(after.includes('catch'), 'startInterceptObserver 调用后应有配对的 catch');
});

test('核心链路：拦截器启动失败必须有醒目的致命日志', () => {
  const observerPos = pos(OBSERVER_CALL);
  const after = CODE.slice(observerPos, observerPos + 400);
  assert.ok(
    /\[致命\]|FATAL/.test(after),
    '拦截器启动失败必须输出醒目的致命级日志（[致命] 或 FATAL），' +
    '否则用户无法从普通日志里区分"功能挂了"和"正常运行"'
  );
});
