/**
 * Hook 隐蔽性回归测试
 *
 * 背景：LingYa 需要往 AI 网页的主世界注入 fetch/XHR 拦截器来抓取流式回复。
 * 但注入会留下两个极其明显的指纹：
 *
 *   1. window.__lingyaXxxHookInstalled__ —— 一行 Object.keys(window) 就能扫出来
 *   2. window.fetch 被替换后 toString() 不再包含 [native code]
 *
 * 2026-10-24 改造：
 *   - 幂等标记改用 Symbol.for()，不出现在 Object.keys / for...in / getOwnPropertyNames
 *   - 给被包裹的函数挂 toString，直接调用时返回伪装成 native 的文案
 *
 * 本测试锁住这两条，防止后续改动为了「方便」把全局标记加回来。
 *
 * 边界说明：Function.prototype.toString.call(fn) 仍会拿到真实源码 ——
 * 那需要替换 Function.prototype.toString 本身，侵入性太大且容易弄坏站点，有意不做。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROVIDERS = [
  { name: 'deepseek', file: 'deepseek.js', sym: 'l.hook.ds', old: '__lingyaDeepseekHookInstalled__' },
  { name: 'claude', file: 'claude.js', sym: 'l.hook.claude', old: '__lingyaClaudeHookInstalled__' },
  { name: 'chatgpt', file: 'chatgpt.js', sym: 'l.hook.gpt', old: '__lingyaChatgptHookInstalled__' },
];

function srcOf(file) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'providers', file), 'utf-8');
}

for (const p of PROVIDERS) {
  test(p.name + '：不得使用 window.__lingya* 全局标记', () => {
    const src = srcOf(p.file);
    assert.ok(src.indexOf(p.old) === -1, '仍存在旧全局标记 ' + p.old);
  });

  test(p.name + '：幂等标记必须用 Symbol.for', () => {
    const src = srcOf(p.file);
    assert.ok(src.includes("Symbol.for('" + p.sym + "')"), '缺少 Symbol.for 幂等标记');
  });

  test(p.name + '：必须定义 spoofNative 并挂到 fetch/XHR', () => {
    const src = srcOf(p.file);
    assert.ok(src.includes('function spoofNative'), '缺少 spoofNative 定义');
    assert.ok(src.includes("spoofNative(window.fetch, 'fetch')"), '未给 fetch 挂 toString');
    assert.ok(src.includes("spoofNative(XMLHttpRequest.prototype.open, 'open')"), '未给 XHR.open 挂 toString');
    assert.ok(src.includes("spoofNative(XMLHttpRequest.prototype.send, 'send')"), '未给 XHR.send 挂 toString');
  });
}

test('hook 源码序列化后必须自包含且语法正确', () => {
  for (const p of PROVIDERS) {
    const mod = require(path.join(__dirname, '..', '..', 'src', 'providers', p.file));
    if (typeof mod.getHookSource !== 'function') continue;
    const src = mod.getHookSource();
    assert.ok(src.includes('function spoofNative'), p.name + ' 序列化后缺少 spoofNative');
    assert.ok(src.includes('[native code]'), p.name + ' 序列化后缺少 native 伪装文案');
    assert.doesNotThrow(() => new Function(src), p.name + ' hook 源码有语法错误');
  }
});
