'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ViewImageTool } = require('../../tools/ViewImageTool');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC',
  'base64'
);

function tmpPng(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewimg-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, PNG);
  return p;
}

test('viewImage 加载图片并收集到 imageCollector', async () => {
  const p = tmpPng('a.png');
  const tool = new ViewImageTool();
  const collector = [];
  const r = await tool.execute({ file_path: p, imageCollector: collector });
  assert.strictEqual(r.success, true);
  assert.strictEqual(collector.length, 1);
  assert.strictEqual(collector[0].mime, 'image/png');
  assert.strictEqual(collector[0].size, PNG.length);
  assert.ok(collector[0].base64.length > 0);
  fs.unlinkSync(p);
});

test('viewImage 相对路径基于 projectDir 解析', async () => {
  const p = tmpPng('b.png');
  const dir = path.dirname(p);
  const tool = new ViewImageTool();
  const collector = [];
  const r = await tool.execute({ file_path: 'b.png', projectDir: dir, imageCollector: collector });
  assert.strictEqual(r.success, true);
  assert.strictEqual(collector.length, 1);
  fs.unlinkSync(p);
});

test('viewImage 不支持的格式报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewimg-'));
  const p = path.join(dir, 'x.txt');
  fs.writeFileSync(p, 'hello');
  const tool = new ViewImageTool();
  const r = await tool.execute({ file_path: p, imageCollector: [] });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不支持的图片格式/);
  fs.unlinkSync(p);
});

test('viewImage 文件不存在报错', async () => {
  const tool = new ViewImageTool();
  const r = await tool.execute({ file_path: 'no-such-file-xyz.png', imageCollector: [] });
  assert.strictEqual(r.success, false);
});

test('viewImage 空路径报错', async () => {
  const tool = new ViewImageTool();
  const r = await tool.execute({ file_path: '', imageCollector: [] });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /不能为空/);
});
