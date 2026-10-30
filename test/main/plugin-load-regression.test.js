/**
 * 插件加载回归测试
 *
 * 覆盖两类已修复的 bug：
 * 1. refusal-rewriter 的 PRELOAD_SCRIPT 内联脚本必须能被解析成合法 JS
 *    （曾因正则 [\\s\\S] 写成 [sS]、字符串内裸换行未转义而抛 SyntaxError，
 *      导致整个 preload 注入失败，插件静默失效）
 * 2. plugin-host 用 new Function 执行打包后的插件代码时必须注入
 *    __dirname / __filename（曾导致插件内 path.join(__dirname, ...) 抛
 *    "__dirname is not defined"）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const BS = String.fromCharCode(92); // 反斜杠，避免测试文件里堆转义

function readPreloadSourceLine() {
  const src = fs.readFileSync(
    path.join(ROOT, 'plugins', 'refusal-rewriter', 'index.js'),
    'utf8'
  );
  const line = src.split(/\r?\n/).find((l) => l.startsWith('const PRELOAD_SCRIPT = '));
  assert.ok(line, '未找到 PRELOAD_SCRIPT 定义');
  return line;
}

function decodePreload() {
  const line = readPreloadSourceLine();
  const m = line.match(/^const PRELOAD_SCRIPT = (".*");?$/s);
  assert.ok(m, 'PRELOAD_SCRIPT 不是合法的 JSON 字符串字面量');
  return JSON.parse(m[1]);
}

test('refusal-rewriter: PRELOAD_SCRIPT 必须是可解析的合法 JS', () => {
  const code = decodePreload();
  assert.ok(code.length > 100, 'PRELOAD_SCRIPT 内容过短，疑似解析异常');

  // 关键断言：能被 vm 编译（语法错误会在这里抛出）
  assert.doesNotThrow(() => new vm.Script(code), 'PRELOAD_SCRIPT 存在语法错误');
});

test('refusal-rewriter: 正则必须是 [\\s\\S] 而非退化的 [sS]', () => {
  const code = decodePreload();
  const good = '[' + BS + 's' + BS + 'S]'; // 解码后应为 [\s\S]
  assert.ok(code.includes(good), '缺少 [\\s\\S] 正则（曾被误写为 [sS]）');
  assert.ok(!code.includes('[sS]'), '仍存在退化的 [sS] 正则');
});

test('refusal-rewriter: 提示文案的换行必须是转义序列而非裸换行', () => {
  const line = readPreloadSourceLine();
  // 源码层：JSON 字符串里换行必须写成两个反斜杠 + n（JSON.parse 后得到 \n）
  const escaped = BS + BS + 'n' + BS + BS + 'n';
  assert.ok(
    line.includes('不要解释。' + escaped),
    '改写提示文案的换行必须写成转义序列，否则解码后是裸换行 → SyntaxError'
  );
});

test('plugin-host: 打包执行时注入 __dirname / __filename', () => {
  const hostSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'main', 'plugin-host.js'),
    'utf8'
  );
  assert.match(
    hostSrc,
    /new Function\(\s*'module',\s*'exports',\s*'require',\s*'__dirname',\s*'__filename'/,
    'new Function 未注入 __dirname/__filename'
  );
  assert.match(
    hostSrc,
    /fn\(moduleObj, moduleObj\.exports, require, plugin\.dir, entryPath\)/,
    '未把 plugin.dir / entryPath 传入执行函数'
  );
});

test('plugin-host: 注入的 __dirname 指向插件目录（行为验证）', () => {
  const fakePluginDir = 'C:/fake/plugins/demo';
  const entryPath = path.join(fakePluginDir, 'index.js');
  const code = 'module.exports = { dir: __dirname, file: __filename };';

  const moduleObj = { exports: {} };
  const fn = new Function(
    'module', 'exports', 'require', '__dirname', '__filename',
    code + '\n;return module.exports;'
  );
  const mod = fn(moduleObj, moduleObj.exports, require, fakePluginDir, entryPath);

  assert.strictEqual(mod.dir, fakePluginDir);
  assert.strictEqual(mod.file, entryPath);
});
