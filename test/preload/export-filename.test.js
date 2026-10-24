/**
 * 导出对话文件名生成测试
 *
 * 需求（2026-10-25）：导出文件名从固定前缀改为会话标题
 *   旧：lingya-conversation-20261025-0159.md
 *   新：LingYa 项目开工确认_20261025-0159.md
 *
 * 规则：
 *   - 标题取自 document.title，截断第一个 ' - ' 之前的平台后缀
 *   - Windows 非法字符替换为下划线
 *   - 取不到标题时回退到旧格式（向后兼容）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MODULE = path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'export-filename.js');

function fresh() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

function withTitle(title, fn) {
  global.document = { title: title };
  try { return fn(); } finally { delete global.document; }
}

test('正常标题：生成 <标题>_<时间戳>.md', () => {
  const { buildExportFilename } = fresh();
  withTitle('LingYa 项目开工确认', () => {
    const fn = buildExportFilename(new Date(2026, 9, 25, 1, 59));
    assert.strictEqual(fn, 'LingYa 项目开工确认_20261025-0159.md');
  });
});

test('带平台后缀：截断第一个 " - " 之前', () => {
  const { buildExportFilename } = fresh();
  withTitle('LingYa 项目开工确认 - DeepSeek', () => {
    const fn = buildExportFilename(new Date(2026, 9, 25, 1, 59));
    assert.strictEqual(fn, 'LingYa 项目开工确认_20261025-0159.md');
  });
});

test('多个 " - " 只截断第一个之后全部', () => {
  const { buildExportFilename } = fresh();
  withTitle('A - B - C', () => {
    const fn = buildExportFilename(new Date(2026, 0, 1, 0, 0));
    assert.ok(fn.startsWith('A_'), '应只保留第一个 - 之前的部分，实际: ' + fn);
  });
});

test('标题为空时回退到旧格式', () => {
  const { buildExportFilename } = fresh();
  withTitle('', () => {
    const fn = buildExportFilename(new Date(2026, 9, 25, 1, 59));
    assert.strictEqual(fn, 'lingya-conversation-20261025-0159.md');
  });
});

test('document 不存在时回退到旧格式（不抛异常）', () => {
  const { buildExportFilename } = fresh();
  const fn = buildExportFilename(new Date(2026, 9, 25, 1, 59));
  assert.strictEqual(fn, 'lingya-conversation-20261025-0159.md');
});

test('Windows 非法字符全部替换为下划线', () => {
  const { sanitizeTitle } = fresh();
  assert.strictEqual(sanitizeTitle('a\\b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a/b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a:b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a*b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a?b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a"b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a<b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a>b'), 'a_b');
  assert.strictEqual(sanitizeTitle('a|b'), 'a_b');
});

test('首尾空格被清理', () => {
  const { sanitizeTitle } = fresh();
  assert.strictEqual(sanitizeTitle('  前后空格  '), '前后空格');
});

test('结尾的点和空格被去掉（Windows 文件名限制）', () => {
  const { sanitizeTitle } = fresh();
  assert.strictEqual(sanitizeTitle('标题...'), '标题');
  assert.strictEqual(sanitizeTitle('标题   '), '标题');
});

test('超长标题截断到 80 字符', () => {
  const { sanitizeTitle } = fresh();
  const long = 'A'.repeat(120);
  assert.strictEqual(sanitizeTitle(long).length, 80);
});

test('时间戳格式为 YYYYMMDD-HHmm（补零）', () => {
  const { buildExportFilename } = fresh();
  withTitle('T', () => {
    const fn = buildExportFilename(new Date(2026, 0, 5, 3, 7));
    assert.ok(fn.includes('20260105-0307'), '实际: ' + fn);
  });
});
