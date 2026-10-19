'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { DANGEROUS_CMDS, isDangerous } = require('../../src/main/dangerous-commands');

test('DANGEROUS_CMDS 非空数组', () => {
  assert.ok(Array.isArray(DANGEROUS_CMDS));
  assert.ok(DANGEROUS_CMDS.length >= 9);
  assert.ok(DANGEROUS_CMDS.every(p => p instanceof RegExp));
});

test('isDangerous 识别危险命令', () => {
  const dangerous = [
    'rm -rf /',
    'format C:',
    'del /f file',
    'rd /s dir',
    'shutdown /s',
    'taskkill /im app.exe',
    'diskpart',
    'reg delete HKLM',
    'cipher /w C:',
  ];
  for (const cmd of dangerous) {
    assert.strictEqual(isDangerous(cmd), true, cmd);
  }
});

test('isDangerous 识别复合命令中的危险操作（非锚定匹配）', () => {
  const dangerous = [
    'cd /tmp && rm -rf /',
    'echo x; rm -rf /',
    'git status && shutdown /s /t 0',
    'ls | taskkill /f /im node.exe',
    'cd C:\\ && rd /s C:\\',
  ];
  for (const cmd of dangerous) {
    assert.strictEqual(isDangerous(cmd), true, cmd);
  }
});

test('isDangerous 不误伤普通删除', () => {
  const safe = [
    'rm -rf ./build',
    'rm -rf node_modules',
    'rm file.txt',
    'git rm -r --cached .',
  ];
  for (const cmd of safe) {
    assert.strictEqual(isDangerous(cmd), false, cmd);
  }
});

test('isDangerous 识别安全命令', () => {
  assert.strictEqual(isDangerous('echo hello'), false);
  assert.strictEqual(isDangerous('dir'), false);
  assert.strictEqual(isDangerous('npm test'), false);
  assert.strictEqual(isDangerous('node main.js'), false);
});

test('isDangerous 忽略首尾空白', () => {
  assert.strictEqual(isDangerous('  shutdown /s  '), true);
});
