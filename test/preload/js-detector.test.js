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
