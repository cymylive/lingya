/**
 * Hook 隐蔽性回归测试
 *
 * 背景：LingYa 需要往 AI 网页的主世界注入 fetch/XHR 拦截器来抓取流式回复。
 * 注入本身会留下指纹，历史上做过两轮不同的取舍：
 *
 *   第一轮（2026-10-24）：主动伪装
 *     - 幂等标记改用 Symbol.for()，不出现在 Object.keys / for...in
 *     - 用 Object.defineProperty 给被 hook 的函数加自有 toString，
 *       返回 "function fetch() { [native code] }"
 *
 *   第二轮（2026-10-30）：撤掉伪装
 *     - 伪装是失败的：原生函数的 toString 是继承的，defineProperty 加上自有属性后
 *       fn.hasOwnProperty('toString') 恒为 true —— 两行代码即可判定劫持。
 *     - 性质更重：主动伪造 native 标识在平台协议里属于「假扮身份」，
 *       比「自动化操作」严重一档。伪装失败是双输。
 *
 * 本测试锁住第二轮的两条结论：
 *   1. 幂等标记继续用 Symbol.for（这条是对的，保留）
 *   2. 绝不再引入 spoofNative 之类的 toString 伪装
 *
 * 边界说明：hook 本身仍会被 Function.prototype.toString.call(fn) 看到真实源码。
 * 这是有意接受的 —— 与其做必然失败的伪装，不如接受「这是自动化工具」这个事实。
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

  test(p.name + '：不得给被 hook 的函数伪装 native toString', () => {
    const src = srcOf(p.file);
    // 伪装失败比不伪装更糟：defineProperty 加自有 toString 后，
    // hasOwnProperty('toString') 恒为 true，两行代码即可判定劫持。
    // 且主动伪造 native 标识在平台协议里属于「假扮身份」，性质更重。
    assert.ok(!src.includes('function spoofNative'), '不应再定义 spoofNative');
    // 只匹配「真正的伪装代码」，不匹配注释里的说明文字：
    //   - 实际伪装代码形如：Object.defineProperty(fn, 'toString', {...})
    //   - 实际伪装文案形如：return 'function ' + name + '() { [native code] }'
    // 注释里出现 [native code] 是解释「为什么删掉」，不算违规。
    assert.ok(!/Object\.defineProperty\(\s*fn\s*,\s*['"]toString['"]/.test(src),
      '不应给函数挂自有 toString（这是可被 hasOwnProperty 检测的伪装）');
    assert.ok(!/return\s+['"]function\s+['"]\s*\+\s*name/.test(src),
      '不应拼接 native 伪装文案');
    // spoofNative 的调用点也必须为空
    assert.ok(!/\bspoofNative\s*\(/.test(src), '不应存在 spoofNative 调用');
    // hook 本身仍要挂上（功能必须正常）
    assert.ok(src.includes('window.fetch =') || src.includes('window.fetch = function'), p.name + ' 缺少 fetch hook');
    assert.ok(src.includes('XMLHttpRequest.prototype.send'), p.name + ' 缺少 XHR.send hook');
  });
}

test('hook 源码序列化后必须自包含且语法正确', () => {
  for (const p of PROVIDERS) {
    const mod = require(path.join(__dirname, '..', '..', 'src', 'providers', p.file));
    if (typeof mod.getHookSource !== 'function') continue;
    const src = mod.getHookSource();
    assert.ok(!src.includes('function spoofNative'), p.name + ' 序列化后仍含 spoofNative');
    assert.ok(!/Object\.defineProperty\(\s*fn\s*,\s*['"]toString['"]/.test(src),
      p.name + ' 序列化后仍含 toString 伪装');
    assert.ok(!/return\s+['"]function\s+['"]\s*\+\s*name/.test(src),
      p.name + ' 序列化后仍含 native 伪装文案拼接');
    // 关键：序列化后必须仍是合法 JS（hook 要能真正注入）
    assert.doesNotThrow(() => new Function(src), p.name + ' hook 源码有语法错误');
  }
});
