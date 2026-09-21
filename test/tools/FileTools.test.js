'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FileWriteTool } = require('../../tools/FileWriteTool');
const { FileReadTool } = require('../../tools/FileReadTool');
const { FileEditTool } = require('../../tools/FileEditTool');
const { FileDeleteTool } = require('../../tools/FileDeleteTool');
const { WriteTool } = require('../../tools/WriteTool');
const { ReadTool } = require('../../tools/ReadTool');
const { EditTool } = require('../../tools/EditTool');

const tmpRoot = path.join(process.cwd(), 'test', 'tmp', 'filetools');

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('FileWriteTool 写入新文件', async () => {
  const tool = new FileWriteTool();
  const r = await tool.execute({ file_path: 'sub/a.txt', content: 'hello', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'sub', 'a.txt'), 'utf8'), 'hello');
  assert.ok(fs.statSync(path.join(tmpRoot, 'sub', 'a.txt')).isFile());
});

test('FileWriteTool 覆盖已有文件', async () => {
  const f = path.join(tmpRoot, 'a.txt');
  fs.writeFileSync(f, 'old');
  const tool = new FileWriteTool();
  const r = await tool.execute({ file_path: 'a.txt', content: 'new', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
});

test('FileReadTool 读取文件', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello');
  const tool = new FileReadTool();
  const r = await tool.execute({ file_path: 'a.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data, 'hello');
});

test('FileReadTool 文件不存在', async () => {
  const tool = new FileReadTool();
  const r = await tool.execute({ file_path: 'missing.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /文件不存在/);
});

test('FileReadTool 路径是目录', async () => {
  const tool = new FileReadTool();
  const r = await tool.execute({ file_path: '.', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不是文件/);
});

test('FileEditTool 替换文本', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello world');
  const tool = new FileEditTool();
  const r = await tool.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'lingya', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8'), 'hello lingya');
});

test('FileEditTool old_string 未找到', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello');
  const tool = new FileEditTool();
  const r = await tool.execute({ file_path: 'a.txt', old_string: 'zzz', new_string: 'yyy', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /未找到要替换的文本/);
});

test('FileEditTool 多次匹配且未 replace_all', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'x x x');
  const tool = new FileEditTool();
  const r = await tool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /出现 3 次/);
});

test('FileEditTool replace_all 全部替换', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'x x x');
  const tool = new FileEditTool();
  const r = await tool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true, projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8'), 'y y y');
});

test('FileEditTool 空 old_string', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'x');
  const tool = new FileEditTool();
  const r = await tool.execute({ file_path: 'a.txt', old_string: '', new_string: 'y', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /old_string 不能为空/);
});

test('FileDeleteTool 删除文件', async () => {
  const f = path.join(tmpRoot, 'a.txt');
  fs.writeFileSync(f, 'x');
  const tool = new FileDeleteTool();
  const r = await tool.execute({ file_path: 'a.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.existsSync(f), false);
});

test('FileDeleteTool 文件不存在', async () => {
  const tool = new FileDeleteTool();
  const r = await tool.execute({ file_path: 'missing.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /删除文件失败/);
});

test('FileDeleteTool 目录不是文件', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'dir'));
  const tool = new FileDeleteTool();
  const r = await tool.execute({ file_path: 'dir', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /路径不是文件/);
});

test('FileDeleteTool 缺少 file_path', async () => {
  const tool = new FileDeleteTool();
  const r = await tool.execute({ projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /缺少参数 file_path/);
});

test('WriteTool 新建与覆盖', async () => {
  const tool = new WriteTool();
  const r1 = await tool.execute({ file_path: 'b.txt', content: 'one', projectDir: tmpRoot });
  assert.strictEqual(r1.success, true);
  assert.match(r1.data, /Created file/);
  const r2 = await tool.execute({ file_path: 'b.txt', content: 'two', projectDir: tmpRoot });
  assert.strictEqual(r2.success, true);
  assert.match(r2.data, /Updated file/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'b.txt'), 'utf8'), 'two');
});

test('WriteTool 目标是目录报错', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'dir'));
  const tool = new WriteTool();
  const r = await tool.execute({ file_path: 'dir', content: 'x', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /目标路径是目录/);
});

test('ReadTool 读取带行号', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'c.txt'), 'line1\nline2\nline3');
  const tool = new ReadTool();
  const r = await tool.execute({ file_path: 'c.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /1: line1/);
  assert.match(r.data, /3: line3/);
  assert.match(r.data, /\(End of file - total 3 lines\)/);
});

test('ReadTool 文件不存在', async () => {
  const tool = new ReadTool();
  const r = await tool.execute({ file_path: 'missing.txt', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /文件不存在/);
});

test('EditTool 成功替换', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'hello world');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'world', new_string: 'lingya', projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /updated successfully/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'hello lingya');
});

test('EditTool old_string 不存在', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'abc');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'zzz', new_string: 'y', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /未找到要替换的文本/);
});

test('EditTool 多次匹配需要 replace_all', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'x x x');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'x', new_string: 'y', projectDir: tmpRoot });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /出现 3 次/);
});

test('EditTool replace_all', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'x x x');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'x', new_string: 'y', replaceAll: true, projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'y y y');
});

test('EditTool dry-run 预览不写入', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'x x x');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'x', new_string: 'y', replaceAll: true, dryRun: true, projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /DRY-RUN/);
  assert.match(r.data, /将全部替换 3 处/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'x x x');
});

test('EditTool dry-run 唯一替换预览', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'hello world');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'world', new_string: 'lingya', dryRun: true, projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /DRY-RUN/);
  assert.match(r.data, /将替换 1 处/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'hello world');
});

test('EditTool dry-run 删除预览', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'd.txt'), 'remove me');
  const tool = new EditTool();
  const r = await tool.execute({ file_path: 'd.txt', old_string: 'remove', new_string: '', dryRun: true, projectDir: tmpRoot });
  assert.strictEqual(r.success, true);
  assert.match(r.data, /DRY-RUN/);
  assert.match(r.data, /old: "remove" → new: ""/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'd.txt'), 'utf8'), 'remove me');
});
