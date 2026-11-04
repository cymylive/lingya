/**
 * 三个 IM bridge 必须统一使用 hasToolBlocks 判定
 *
 * 背景：原来 qq-bridge / weixin-bridge / feishu-bridge 各自用粗正则
 * /(三反引号)(?:lingya|javascript|js)/i 判 hasTool，与执行层不一致。
 *
 * 本测试锁死修复后的状态：三处都必须 require 并使用 hasToolBlocks，
 * 且源码中不得再出现那条旧正则。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGES = [
  { name: 'QQ', file: 'qq-bridge.js' },
  { name: '微信', file: 'weixin-bridge.js' },
  { name: '飞书', file: 'feishu-bridge.js' },
];

function srcOf(file) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'preload', 'dom', file),
    'utf-8'
  );
}

for (const b of BRIDGES) {
  test(b.name + ' bridge 必须 require hasToolBlocks', () => {
    const src = srcOf(b.file);
    assert.match(
      src,
      /require\(['"]\.\/js-detector['"]\)/,
      b.file + ' 必须从 ./js-detector 导入'
    );
    assert.match(
      src,
      /hasToolBlocks/,
      b.file + ' 必须使用 hasToolBlocks'
    );
  });

  test(b.name + ' bridge 不得再出现旧的粗正则判定', () => {
    const src = srcOf(b.file);
    // 旧写法：const hasTool = /(反引号3)(?:lingya|javascript|js)/i.test(text)
    const oldPattern = new RegExp(
      'const\\s+hasTool\\s*=\\s*/[^/]*\\(\\?:lingya\\\\?\\|javascript\\\\?\\|js\\)[^/]*/i\\.test'
    );
    assert.ok(
      !oldPattern.test(src),
      b.file + ' 仍存在旧的粗正则 hasTool 判定'
    );
  });

  test(b.name + ' bridge 必须调用 hasToolBlocks(text)', () => {
    const src = srcOf(b.file);
    assert.match(
      src,
      /hasToolBlocks\s*\(\s*text\s*\)/,
      b.file + ' 必须调用 hasToolBlocks(text)'
    );
  });
}
