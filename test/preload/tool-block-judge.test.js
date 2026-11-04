/**
 * hasToolBlocks 判定函数测试
 *
 * 背景：三个 IM bridge（QQ/微信/飞书）原来用粗正则判 hasTool，
 * 与执行层 extractJsToolBlocks 不一致，导致含代码示例的最终报告被判为
 * 「还要调工具」而不发 task-done，报告丢失。
 *
 * 修复：新增 hasToolBlocks(text)，复用 extractJsToolBlocks，保证与执行层一致。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;

const detector = require(path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'js-detector.js'));

test('hasToolBlocks 必须导出', () => {
  assert.strictEqual(typeof detector.hasToolBlocks, 'function', 'js-detector 必须导出 hasToolBlocks');
});

test('场景1：纯文本 → false', () => {
  assert.strictEqual(detector.hasToolBlocks('任务已完成，结果是 A。'), false);
});

test('场景2：只有 lingya 块 → true', () => {
  const text = '让我执行一下：\n' + FENCE + 'lingya\nconst x = await read("a.txt");\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), true);
});

test('场景3：纯文本 + js 示例块（无 await 工具调用）→ false', () => {
  const text = '示例代码如下：\n' + FENCE + 'js\nconsole.log("hello");\n' + FENCE + '\n以上是示例。';
  assert.strictEqual(detector.hasToolBlocks(text), false);
});

test('场景4：纯文本 + javascript 示例块（无工具调用）→ false', () => {
  const text = '参考写法：\n' + FENCE + 'javascript\nconst a = 1 + 2;\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), false);
});

test('场景5：纯文本 + python 块 → false', () => {
  const text = 'Python 版快排：\n' + FENCE + 'python\ndef qs(a): return a\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), false);
});

test('场景6：lingya 块 + js 示例块混合 → true', () => {
  const text = FENCE + 'js\nconsole.log(1);\n' + FENCE + '\n' +
    FENCE + 'lingya\nconst x = await read("a.txt");\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), true);
});

test('场景7：空字符串 → false', () => {
  assert.strictEqual(detector.hasToolBlocks(''), false);
});

test('场景8：整条回复只有 js 块且含 await write( → true（执行层会执行）', () => {
  const text = FENCE + 'js\nawait write("a.txt", "hi");\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), true);
});

test('场景9：null / undefined → false（容错）', () => {
  assert.strictEqual(detector.hasToolBlocks(null), false);
  assert.strictEqual(detector.hasToolBlocks(undefined), false);
});

test('场景10：bash / json / yaml 等非 JS 语言块 → false', () => {
  const text = '配置：\n' + FENCE + 'json\n{"a":1}\n' + FENCE;
  assert.strictEqual(detector.hasToolBlocks(text), false);
});
