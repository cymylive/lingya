'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 侧边栏工作区分组「展开/收起」测试。
 *
 * 回归背景（2026-11-01）：
 *   wsRenderGroup 里原来写的是
 *     var isOpen = (dir === currentDir) || !!_wsExpandedDirs['dir:' + dir];
 *   当前项目目录恒满足左边，导致「展开后再点击收不起来」。
 *   而切换函数又按 _wsExpandedDirs 取反，永远追不上 currentDir 的默认展开。
 *
 * 修复要求：
 *   1. 渲染时「显式状态」优先于「currentDir 默认展开」
 *   2. 切换时按 DOM 当前的 open 状态取反（DOM 是唯一事实来源）
 */

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/preload/shell-renderer.js'), 'utf8');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('wsRenderGroup 必须区分「有显式展开状态」与「无显式状态」', () => {
  const idx = CODE.indexOf('function wsRenderGroup');
  assert.ok(idx >= 0, '必须有 wsRenderGroup');
  const seg = CODE.slice(idx, idx + 2500);
  const hasExplicitCheck =
    /hasOwnProperty\.call\(_wsExpandedDirs/.test(seg) ||
    /_wsExpandedDirs\.hasOwnProperty\(/.test(seg);
  assert.ok(
    hasExplicitCheck,
    'wsRenderGroup 必须用 hasOwnProperty 判断是否存在显式状态，' +
    '否则当前项目（dir === currentDir）永远展开、无法手动收起'
  );
});

test('wsRenderGroup 不得再用 (dir === currentDir) || 短路决定展开', () => {
  const idx = CODE.indexOf('function wsRenderGroup');
  const seg = CODE.slice(idx, idx + 2500);
  assert.ok(
    !/\(dir === currentDir\)\s*\|\|/.test(seg),
    '(dir === currentDir) || ... 会让当前项目恒展开，必须改成「显式状态优先」'
  );
});

test('分组切换必须按 DOM 当前 open 状态取反', () => {
  const idx = CODE.indexOf('function bindWorkspaceEvents');
  assert.ok(idx >= 0, '必须有 bindWorkspaceEvents');
  const seg = CODE.slice(idx, idx + 1800);
  assert.match(
    seg,
    /classList\.contains\('open'\)/,
    '切换必须读取 .ck-ws-group 的当前 open 状态再取反，' +
    '否则 _wsExpandedDirs 与 currentDir 默认值会打架'
  );
});

test('切换后必须写入显式布尔值（不能只 delete）', () => {
  const idx = CODE.indexOf('function bindWorkspaceEvents');
  const seg = CODE.slice(idx, idx + 1800);
  assert.ok(
    /_wsExpandedDirs\[key\]\s*=/.test(seg),
    '切换时必须写入显式布尔值，否则当前项目收起后又被 currentDir 默认展开顶回来'
  );
});
