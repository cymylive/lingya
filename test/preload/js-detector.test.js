'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  BT,
  FENCE,
  JS_TOOL_CALL_RE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
} = require('../../src/preload/dom/js-detector');

test('BT 和 FENCE 定义', () => {
  assert.strictEqual(BT, '`');
  assert.strictEqual(FENCE, '```');
});

test('looksLikeToolScript 识别 await 工具调用', () => {
  assert.strictEqual(looksLikeToolScript('await bash("echo hi")'), true);
  assert.strictEqual(looksLikeToolScript('const x = await readFile("a.txt")'), true);
  assert.strictEqual(looksLikeToolScript('await writeFile("a", "b")'), true);
});

test('looksLikeToolScript 拒绝普通代码', () => {
  assert.strictEqual(looksLikeToolScript('fs.readFile("a.txt")'), false);
  assert.strictEqual(looksLikeToolScript('console.log(1)'), false);
  assert.strictEqual(looksLikeToolScript(''), false);
  assert.strictEqual(looksLikeToolScript(null), false);
});

test('looksLikeIncompleteCodeError 匹配语法错误', () => {
  assert.strictEqual(looksLikeIncompleteCodeError('SyntaxError: Unexpected end'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('Unexpected token'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('normal error'), false);
  assert.strictEqual(looksLikeIncompleteCodeError(null), false);
});

test('hasOnlyFences 仅代码块', () => {
  assert.strictEqual(hasOnlyFences('```js\ncode\n```'), true);
  assert.strictEqual(hasOnlyFences('```js\ncode\n```\n\n```js\nmore\n```'), true);
  assert.strictEqual(hasOnlyFences('text ```js\ncode\n```'), false);
  assert.strictEqual(hasOnlyFences('no fence'), false);
  assert.strictEqual(hasOnlyFences(null), false);
});

test('extractJsToolBlocks 提取 lingya 块', () => {
  const text = '```lingya\nawait read("a.txt")\n```';
  const blocks = extractJsToolBlocks(text);
  assert.deepStrictEqual(blocks, ['await read("a.txt")']);
});

test('extractJsToolBlocks js 块仅当只有代码块', () => {
  const js = '```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), ['await bash("echo")']);
  const mixed = '说明\n```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(mixed), []);
});

test('extractJsToolBlocks 忽略普通 js', () => {
  const js = '```js\nconsole.log(1)\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), []);
});

test('extractJsToolBlocks 空输入', () => {
  assert.deepStrictEqual(extractJsToolBlocks(''), []);
  assert.deepStrictEqual(extractJsToolBlocks(null), []);
});


// ===== <lingya> XML 标签兼容（AI 偶尔误用 XML 格式） =====

test('extractLingyaTags: 标准闭合 <lingya>...</lingya>', () => {
  const { extractLingyaTags } = require('../../src/preload/dom/js-detector');
  const NL = String.fromCharCode(10);
  const text = '这是说明' + NL + '<lingya>await write("a.txt", "hi");</lingya>' + NL + '后续说明';
  const blocks = extractLingyaTags(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0], 'await write("a.txt", "hi");');
});

test('extractLingyaTags: 未闭合 <lingya> 取到结尾', () => {
  const { extractLingyaTags } = require('../../src/preload/dom/js-detector');
  const NL = String.fromCharCode(10);
  const text = '<lingya> await todoWrite([{content:"x"}]);' + NL + 'const t = await bash("ls");';
  const blocks = extractLingyaTags(text);
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].indexOf('await todoWrite') >= 0);
  assert.ok(blocks[0].indexOf('await bash') >= 0);
});

test('extractLingyaTags: 多个闭合标签', () => {
  const { extractLingyaTags } = require('../../src/preload/dom/js-detector');
  const text = '<lingya>await write("a",1);</lingya> 中间 <lingya>await read("b");</lingya>';
  const blocks = extractLingyaTags(text);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].indexOf('write') >= 0);
  assert.ok(blocks[1].indexOf('read') >= 0);
});

test('extractLingyaTags: 大小写不敏感', () => {
  const { extractLingyaTags } = require('../../src/preload/dom/js-detector');
  const text = '<LINGYA>await write("a",1);</LINGYA>';
  const blocks = extractLingyaTags(text);
  assert.strictEqual(blocks.length, 1);
});

test('extractLingyaTags: 无标签返回空', () => {
  const { extractLingyaTags } = require('../../src/preload/dom/js-detector');
  assert.deepStrictEqual(extractLingyaTags('普通文本，没有标签'), []);
});

test('extractJsToolBlocks: 兼容 <lingya> 标签（模拟截图场景）', () => {
  const { extractJsToolBlocks } = require('../../src/preload/dom/js-detector');
  const NL = String.fromCharCode(10);
  const text = '<lingya> await todoWrite([ { content: "升版本", status: "completed" } ]);' + NL + 'const t = await bash("npm test");';
  const blocks = extractJsToolBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].indexOf('todoWrite') >= 0);
});

test('extractJsToolBlocks: 三反引号围栏与 <lingya> 标签共存', () => {
  const { extractJsToolBlocks } = require('../../src/preload/dom/js-detector');
  const NL = String.fromCharCode(10);
  const BT = String.fromCharCode(96);
  const FENCE = BT + BT + BT;
  const text = '说明' + NL + FENCE + 'lingya' + NL + 'await write("a",1);' + NL + FENCE + NL + '然后' + NL + '<lingya>await read("b");</lingya>';
  const blocks = extractJsToolBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].indexOf('write') >= 0);
  assert.ok(blocks[1].indexOf('read') >= 0);
});
