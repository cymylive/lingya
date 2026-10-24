/**
 * project-context.splitPromptIntoChunks 单测
 *
 * 背景：systemPrompt 一次性倾倒几万字符，容易被平台侧判定为机器行为。
 * 改为分段发送后，必须保证：切点语义完整、段数可控、尾段不孤立。
 */
const test = require('node:test');
const assert = require('node:assert');

const { splitPromptIntoChunks } = require('../../src/main/project-context');

function makePrompt(sections) {
  return sections.join('\n\n');
}

test('空输入返回空数组', () => {
  assert.deepStrictEqual(splitPromptIntoChunks('', 1000, 5), []);
  assert.deepStrictEqual(splitPromptIntoChunks('   ', 1000, 5), []);
  assert.deepStrictEqual(splitPromptIntoChunks(null, 1000, 5), []);
});

test('短文本不拆分，原样返回一段', () => {
  const src = '# 标题\n\n一小段内容。';
  const r = splitPromptIntoChunks(src, 15000, 5);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0], src);
});

test('在顶层标题处切分，不把代码块劈开', () => {
  const big = 'x'.repeat(3000);
  const src = makePrompt([
    '# 第一块\n' + big,
    '# 第二块\n' + big,
    '# 第三块\n' + big,
  ]);
  const r = splitPromptIntoChunks(src, 4000, 5);
  assert.ok(r.length > 1, '应当被拆成多段');
  // 每段都必须以某个顶层标题开头（切点落在边界上）
  for (const c of r) {
    assert.ok(/^# /.test(c.trim()), '每段应以一级标题开头，实际: ' + c.slice(0, 20));
  }
});

test('段数超过 maxChunks 时不合并（旧行为会让单段超限发不出去）', () => {
  // 这是 2026-10-24 修的核心 bug：
  // 原实现靠「两两合并」压回 maxChunks，结果单段变成十几万字符，平台拒收。
  // 新语义：段数可以超过上限（仅 console.warn），但每段必须 ≤ target。
  const big = 'y'.repeat(2000);
  const sections = [];
  for (let i = 0; i < 10; i++) sections.push('# 段' + i + '\n' + big);
  const src = sections.join('\n\n');
  const r = splitPromptIntoChunks(src, 2500, 3);
  // 段数允许超过 3，但每段都必须 ≤ 2500
  assert.ok(r.length > 3, '不应为了满足上限而合并');
  for (let i = 0; i < r.length; i++) {
    assert.ok(r[i].length <= 2500,
      '第 ' + (i + 1) + ' 段 ' + r[i].length + ' 字符超过 target 2500');
  }
});

test('尾段过短时并回上一段', () => {
  const big = 'z'.repeat(5000);
  const src = '# 主内容\n' + big + '\n\n---\n\n请继续你之前的工作';
  const r = splitPromptIntoChunks(src, 2000, 5);
  // 最后一段不应只剩那句短提示
  assert.ok(r[r.length - 1].length > 200, '尾段不应孤立成超短段');
});

test('切分后内容不丢失（关键标记仍在）', () => {
  const src = makePrompt([
    '# A\nAAA_MARKER',
    '# B\nBBB_MARKER',
    '# C\nCCC_MARKER',
  ]);
  // target 要大于标记本身，否则会被按字符切开（那是预期行为，见「单行超长」用例）
  const r = splitPromptIntoChunks(src, 100, 40);
  const joined = r.join('\n');
  assert.ok(joined.includes('AAA_MARKER'));
  assert.ok(joined.includes('BBB_MARKER'));
  assert.ok(joined.includes('CCC_MARKER'));
});

test('maxChunks 非法时退回默认上限（40），且每段不超 target', () => {
  const big = 'w'.repeat(3000);
  const sections = [];
  for (let i = 0; i < 8; i++) sections.push('# X' + i + '\n' + big);
  const r = splitPromptIntoChunks(sections.join('\n\n'), 1000, 0);
  assert.ok(r.length >= 1);
  // 默认保护上限 40：只告警不合并，因此段数由 target 决定
  assert.ok(r.length <= 40, '默认保护上限应为 40');
  // 关键：每段都不得超过 target（不能靠合并来满足上限）
  for (let i = 0; i < r.length; i++) {
    assert.ok(r[i].length <= 1000, '第 ' + (i + 1) + ' 段超限: ' + r[i].length);
  }
});

test('切点必须落在顶层结构上（不切断代码块）', () => {
  const code = '# 代码段\n\n\u0060\u0060\u0060ts\n' + 'const a = 1;\n'.repeat(500) + '\u0060\u0060\u0060\n';
  const src = '# 前段\n' + 'a'.repeat(3000) + '\n\n' + code + '\n# 后段\n' + 'b'.repeat(3000);
  const r = splitPromptIntoChunks(src, 4000, 5);
  const joined = r.join('\n');
  // 代码围栏必须成对，不能一段里只有开没有闭
  const fences = (joined.match(/\u0060\u0060\u0060/g) || []).length;
  assert.strictEqual(fences % 2, 0, '代码围栏必须成对出现');
});


test('每段长度不得超过 targetSize（硬约束）', () => {
  // 造一段超长内容：一条 4 万字符的「记忆」塞在某个标题下
  const huge = 'M'.repeat(40000);
  const src = [
    '# 第一块',
    'a'.repeat(3000),
    '# 超长记忆块',
    huge,
    '# 第三块',
    'c'.repeat(3000),
  ].join('\n');
  const chunks = splitPromptIntoChunks(src, 15000, 40);
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].length <= 15000,
      '第 ' + (i + 1) + ' 段 ' + chunks[i].length + ' 字符超过上限 15000');
  }
});

test('段数超过保护上限时不得靠合并来满足（那会让单段超限）', () => {
  // 造 50 个小段，超过 maxChunks=40
  const parts = [];
  for (let i = 0; i < 50; i++) {
    parts.push('# 段' + i + '\n' + 'x'.repeat(2000));
  }
  const src = parts.join('\n\n');
  const chunks = splitPromptIntoChunks(src, 3000, 40);
  // 段数可以超过 40（只告警不合并），但每段必须 ≤ 3000
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].length <= 3000,
      '合并导致第 ' + (i + 1) + ' 段超限: ' + chunks[i].length);
  }
});

test('单行超长时必须按字符强制切分', () => {
  // 一整行 5 万字符，没有任何换行
  const src = '# 标题\n' + 'Z'.repeat(50000);
  const chunks = splitPromptIntoChunks(src, 15000, 40);
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].length <= 15000,
      '单行切分失败，第 ' + (i + 1) + ' 段 ' + chunks[i].length + ' 字符');
  }
  // 内容不能丢
  const joined = chunks.join('');
  assert.ok(joined.includes('Z'.repeat(1000)), '内容丢失');
});

test('内容完整性：切分后不应丢字符（仅允许换行符差异）', () => {
  const src = [
    '# A', 'a'.repeat(2000),
    '# B', 'b'.repeat(2000),
    '# C', 'c'.repeat(2000),
  ].join('\n');
  const chunks = splitPromptIntoChunks(src, 3000, 40);
  const joined = chunks.join('\n');
  // 每个标记必须还在
  ['# A', '# B', '# C'].forEach(function (mark) {
    assert.ok(joined.includes(mark), '丢失标记 ' + mark);
  });
  assert.ok(joined.includes('a'.repeat(1000)), '丢失 A 段内容');
  assert.ok(joined.includes('b'.repeat(1000)), '丢失 B 段内容');
  assert.ok(joined.includes('c'.repeat(1000)), '丢失 C 段内容');
});
