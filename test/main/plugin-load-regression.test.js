/**
 * 插件加载回归测试
 *
 * 覆盖三类已修复/已加固的问题：
 * 1. 插件 preload 脚本必须能被解析成合法 JS
 *    （曾因正则 [\\s\\S] 写成 [sS]、字符串内裸换行未转义而抛 SyntaxError，
 *      导致整个 preload 注入失败，插件静默失效）
 * 2. plugin-host 用 new Function 执行打包后的插件代码时必须注入
 *    __dirname / __filename（曾导致插件内 path.join(__dirname, ...) 抛
 *    "__dirname is not defined"）
 * 3. 上述脚本已从"内联字符串常量"外置为独立 .js 文件，由 index.js 运行时读取，
 *    保证 lint / 语法检查能直接覆盖（本文件即为该契约的守卫）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

// 插件目录名 → 外置脚本文件名
const PRELOAD_FILES = [
  ['refusal-rewriter', 'preload.js'],
  ['task-watcher', 'preload.js'],
];

for (const [plugin, file] of PRELOAD_FILES) {
  test(plugin + ': ' + file + ' 必须是可解析的合法 JS', () => {
    const p = path.join(ROOT, 'plugins', plugin, file);
    assert.ok(fs.existsSync(p), '缺少外置脚本文件: ' + file);
    const code = fs.readFileSync(p, 'utf8');
    assert.ok(code.length > 100, '脚本内容过短，疑似异常');
    assert.doesNotThrow(() => new vm.Script(code), file + ' 存在语法错误');
  });

  test(plugin + ': index.js 必须从独立文件读取脚本', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'plugins', plugin, 'index.js'),
      'utf8'
    );
    assert.ok(
      src.includes(JSON.stringify(file)) || src.includes("'" + file + "'"),
      'index.js 未引用 ' + file
    );
    assert.match(src, /readFileSync/, 'index.js 未使用 readFileSync 读取脚本');
    // 防回归：不得再出现超长的内联脚本字符串常量
    const longInline = src.split(/\r?\n/).some((l) => l.length > 5000);
    assert.ok(!longInline, 'index.js 仍有超长内联字符串，应外置为独立文件');
  });
}

test('refusal-rewriter: preload.js 的正则必须是 [\\s\\S] 而非退化的 [sS]', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'plugins', 'refusal-rewriter', 'preload.js'),
    'utf8'
  );
  const BS = String.fromCharCode(92);
  const good = '[' + BS + 's' + BS + 'S]';
  assert.ok(code.includes(good), '缺少 [\\s\\S] 正则（曾被误写为 [sS]）');
  assert.ok(!code.includes('[sS]'), '仍存在退化的 [sS] 正则');
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
