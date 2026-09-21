'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { GlobTool } = require('../../tools/GlobTool');
const { GrepTool } = require('../../tools/GrepTool');

const tmpRoot = path.join(process.cwd(), 'test', 'tmp', 'legacy');

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'a.js'), 'hello world');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'b.js'), 'foo bar');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'c.txt'), 'hello again');
  fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'x.js'), 'hello node');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('GlobTool execute 基本搜索', async () => {
  const tool = new GlobTool();
  const r = await tool.execute({ pattern: '**/*.js', path: '.', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.ok(r.data.files.includes('a.js'));
  assert.ok(r.data.files.includes('src/b.js'));
});

test('GlobTool execute 空 pattern', async () => {
  const tool = new GlobTool();
  const r = await tool.execute({ pattern: '', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /pattern 不能为空/);
});

test('GlobTool execute 目录不存在', async () => {
  const tool = new GlobTool();
  const r = await tool.execute({ pattern: '*.js', path: 'nope', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /目录不存在/);
});

test('GrepTool execute 搜索内容', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: 'hello', path: '.', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.matches.length, 2);
  assert.ok(r.data.matches.some(m => m.file === 'a.js'));
  assert.ok(r.data.matches.some(m => m.file === 'src/c.txt'));
});

test('GrepTool execute glob 过滤', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: 'hello', path: '.', glob: '*.js', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.matches.length, 1);
  assert.strictEqual(r.data.matches[0].file, 'a.js');
});

test('GrepTool execute 忽略大小写', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: 'HELLO', ignore_case: true, path: '.', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.matches.length, 2);
});

test('GrepTool execute count 模式', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: 'hello', path: '.', output_mode: 'count', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.totalMatches, 2);
});

test('GrepTool execute 无效正则', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: '[', path: '.', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无效的正则表达式/);
});

test('GrepTool execute 空 pattern', async () => {
  const tool = new GrepTool();
  const r = await tool.execute({ pattern: '', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /pattern 不能为空/);
});
