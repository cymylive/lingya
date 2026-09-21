'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decodeOutput, normalizeCommand } = require('../../tools/decodeOutput');

test('decodeOutput 空/无输入返回空串', () => {
  assert.strictEqual(decodeOutput(null), '');
  assert.strictEqual(decodeOutput(undefined), '');
  assert.strictEqual(decodeOutput(Buffer.alloc(0)), '');
});

test('decodeOutput UTF-8 正常解码', () => {
  const buf = Buffer.from('hello 中文', 'utf8');
  assert.strictEqual(decodeOutput(buf), 'hello 中文');
});

test('decodeOutput GBK 回退', () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  const out = decodeOutput(gbk);
  assert.ok(out.length > 0);
  assert.ok(!out.includes('\uFFFD') || out === '你好');
});

test('decodeOutput 非法 UTF-8 无法 GBK 时返回字符串', () => {
  const bad = Buffer.from([0xff, 0xfe, 0xfd]);
  const out = decodeOutput(bad);
  assert.strictEqual(typeof out, 'string');
});

test('normalizeCommand 非字符串原样返回', () => {
  assert.strictEqual(normalizeCommand(null), null);
  assert.strictEqual(normalizeCommand(undefined), undefined);
  assert.strictEqual(normalizeCommand(123), 123);
  assert.strictEqual(normalizeCommand(''), '');
});

test('normalizeCommand 非 powershell 不处理', () => {
  const cmd = 'Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), cmd);
  const bash = 'bash -c "Get-Content x"';
  assert.strictEqual(normalizeCommand(bash), bash);
});

test('normalizeCommand powershell 含 Get-Content 注入 UTF8', () => {
  const cmd = 'powershell -NoProfile -Command Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), 'powershell -NoProfile -Command Get-Content -Encoding UTF8 file.txt');
});

test('normalizeCommand pwsh 含 Get-Content 注入 UTF8', () => {
  const cmd = 'pwsh Get-Content file.txt';
  assert.strictEqual(normalizeCommand(cmd), 'pwsh Get-Content -Encoding UTF8 file.txt');
});

test('normalizeCommand 已有 -Encoding 不动', () => {
  const cmd = 'powershell Get-Content -Encoding UTF8 file.txt';
  assert.strictEqual(normalizeCommand(cmd), cmd);
});

test('normalizeCommand 无 Get-Content 不动', () => {
  const cmd = 'powershell Get-ChildItem';
  assert.strictEqual(normalizeCommand(cmd), cmd);
});
