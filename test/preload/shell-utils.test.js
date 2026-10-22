'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const u = require('../../src/preload/shell-utils');

/**
 * shell-utils 纯函数测试。
 *
 * 审计发现 shell-renderer.js 2127 行、零测试覆盖，
 * 其中转义/递归/高亮这类易错逻辑被提取到本模块。
 */

// ===================== esc（HTML 转义）=====================

test('esc 转义 & < > "', () => {
  assert.strictEqual(u.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(u.esc('a & b'), 'a &amp; b');
  assert.strictEqual(u.esc('say "hi"'), 'say &quot;hi&quot;');
});

test('esc 处理 null/undefined/非字符串', () => {
  assert.strictEqual(u.esc(null), '');
  assert.strictEqual(u.esc(undefined), '');
  assert.strictEqual(u.esc(123), '123');
});

test('esc 不转义单引号（与前端 HTML 属性用双引号一致）', () => {
  assert.strictEqual(u.esc("it's"), "it's");
});

test('esc 幂等性：已转义的再转义会双重编码（说明不可重复调用）', () => {
  const once = u.esc('<');
  const twice = u.esc(once);
  assert.strictEqual(once, '&lt;');
  assert.strictEqual(twice, '&amp;lt;', '这是预期行为，调用方不应重复转义');
});

// ===================== attr（属性转义）=====================

test('attr 转义 & < > "', () => {
  assert.strictEqual(u.attr('a&b'), 'a&amp;b');
  assert.strictEqual(u.attr('<x>'), '&lt;x&gt;');
  assert.strictEqual(u.attr('say "hi"'), 'say &quot;hi&quot;');
});

test('attr 处理 null', () => {
  assert.strictEqual(u.attr(null), '');
});

// ===================== extOf =====================

test('extOf 提取并小写扩展名', () => {
  assert.strictEqual(u.extOf('a.TSX'), 'tsx');
  assert.strictEqual(u.extOf('file.tar.gz'), 'gz', '取最后一个点之后');
  assert.strictEqual(u.extOf('README'), '', '无扩展名返回空串');
});

test('extOf 处理边界', () => {
  assert.strictEqual(u.extOf(null), '');
  assert.strictEqual(u.extOf(''), '');
  assert.strictEqual(u.extOf('.gitignore'), 'gitignore', '隐藏文件取其名作为扩展名');
});

// ===================== highlight =====================

test('highlight 无关键词时只转义', () => {
  assert.strictEqual(u.highlight('<a>', ''), '&lt;a&gt;');
  assert.strictEqual(u.highlight('<a>', null), '&lt;a&gt;');
});

test('highlight 包裹匹配片段', () => {
  const r = u.highlight('hello world', 'world');
  assert.ok(r.includes('<mark class="ck-ft-hl">world</mark>'));
});

test('highlight 大小写不敏感', () => {
  const r = u.highlight('Hello', 'hello');
  assert.ok(r.includes('<mark'), '应匹配到，实际: ' + r);
});

test('highlight 转义正则元字符（关键词含 . * [ ]）', () => {
  assert.doesNotThrow(() => u.highlight('a.b', 'a.b'));
  assert.doesNotThrow(() => u.highlight('x', '*'));
  assert.doesNotThrow(() => u.highlight('x', '['));
});

test('highlight 先转义再高亮（防 XSS）', () => {
  const r = u.highlight('<script>', 'script');
  assert.ok(!r.includes('<script>'), '原始标签必须被转义');
  assert.ok(r.includes('&lt;'), '应含转义后的 &lt;');
});

// ===================== colorClass / nameClass =====================

test('colorClass 目录返回空串', () => {
  assert.strictEqual(u.colorClass('src', 'dir'), '');
});

test('colorClass 已知扩展名返回对应 class', () => {
  assert.strictEqual(u.colorClass('a.ts', 'file'), 'ck-ft-c-ts');
  assert.strictEqual(u.colorClass('a.py', 'file'), 'ck-ft-c-py');
});

test('colorClass 未知扩展名返回 ck-ft-c-file', () => {
  assert.strictEqual(u.colorClass('a.xyz', 'file'), 'ck-ft-c-file');
});

test('nameClass 目录 vs 文件', () => {
  assert.strictEqual(u.nameClass('src', 'dir'), 'ck-ft-name');
  assert.strictEqual(u.nameClass('a.ts', 'file'), 'ck-ft-name ck-ft-c-ts');
});

// ===================== iconHtml =====================

test('iconHtml 目录用文件夹图标', () => {
  const r = u.iconHtml('src', 'dir');
  assert.ok(r.includes('ck-ft-i-dir'));
});

test('iconHtml 媒体文件用图片图标', () => {
  assert.ok(u.iconHtml('a.png', 'file').includes('ck-ft-i-media'));
  assert.ok(u.iconHtml('a.mp4', 'file').includes('ck-ft-i-media'));
});

test('iconHtml 已知扩展名用语言角标', () => {
  const r = u.iconHtml('a.ts', 'file');
  assert.ok(r.includes('ck-ft-badge'));
  assert.ok(r.includes('>TS<'));
});

test('iconHtml 未知扩展名用普通文件图标', () => {
  assert.ok(u.iconHtml('a.xyz', 'file').includes('ck-ft-i-file'));
});

// ===================== flatten（递归拍平）=====================

test('flatten 拍平嵌套树', () => {
  const tree = [
    { name: 'a', children: [{ name: 'a1' }, { name: 'a2', children: [{ name: 'a2x' }] }] },
    { name: 'b' },
  ];
  const flat = u.flatten(tree);
  assert.strictEqual(flat.length, 5, 'a, a1, a2, a2x, b');
  assert.deepStrictEqual(flat.map(n => n.name), ['a', 'a1', 'a2', 'a2x', 'b']);
});

test('flatten 处理空/非数组', () => {
  assert.deepStrictEqual(u.flatten([]), []);
  assert.deepStrictEqual(u.flatten(null), []);
});

// ===================== renderNodes（递归渲染）=====================

test('renderNodes 渲染文件节点', () => {
  const html = u.renderNodes([{ name: 'a.ts', path: 'src/a.ts', type: 'file' }], 0, {});
  assert.ok(html.includes('ck-ft-file'));
  assert.ok(html.includes('data-path="src/a.ts"'));
  assert.ok(html.includes('a.ts'));
});

test('renderNodes 目录折叠时不渲染子节点', () => {
  const tree = [{
    name: 'src', path: 'src', type: 'dir',
    children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
  }];
  const collapsed = u.renderNodes(tree, 0, {});
  assert.ok(!collapsed.includes('src/a.ts'), '折叠时子节点不渲染');
});

test('renderNodes 目录展开时递归渲染子节点', () => {
  const tree = [{
    name: 'src', path: 'src', type: 'dir',
    children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
  }];
  const expanded = u.renderNodes(tree, 0, { src: true });
  assert.ok(expanded.includes('src/a.ts'), '展开时应包含子节点路径');
});

test('renderNodes 转义文件名（防 XSS）', () => {
  const html = u.renderNodes([{ name: '<img onerror=x>', path: 'x', type: 'file' }], 0, {});
  assert.ok(!html.includes('<img onerror'), '文件名必须被转义');
  assert.ok(html.includes('&lt;img'));
});

test('renderNodes 缩进随深度递增', () => {
  const d0 = u.renderNodes([{ name: 'a', path: 'a', type: 'file' }], 0, {});
  const d2 = u.renderNodes([{ name: 'a', path: 'a', type: 'file' }], 2, {});
  assert.ok(d0.includes('padding-left:6px'));
  assert.ok(d2.includes('padding-left:34px'), '6 + 2*14 = 34');
});

test('renderNodes 处理空/非数组', () => {
  assert.strictEqual(u.renderNodes([], 0, {}), '');
  assert.strictEqual(u.renderNodes(null, 0, {}), '');
});
