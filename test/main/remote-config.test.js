/**
 * remote/config.js 单元测试
 * 用 LINGYA_HOME 隔离到临时目录，不触碰真实用户数据
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-remote-cfg-'));
process.env.LINGYA_HOME = TMP;

const config = require('../../src/main/remote/config.js');

beforeEach(() => {
  const f = path.join(TMP, 'remote.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
});

afterEach(() => {
  const f = path.join(TMP, 'remote.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
});

test('首次读取：自动生成 32 位 hex 令牌并落盘', () => {
  const cfg = config.readConfig();
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.port, 7799);
  assert.match(cfg.token, /^[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(path.join(TMP, 'remote.json')));
});

test('再次读取：令牌保持不变（幂等）', () => {
  const a = config.readConfig();
  const b = config.readConfig();
  assert.strictEqual(a.token, b.token);
});

test('写入后读取：字段合并正确', () => {
  config.readConfig();
  config.writeConfig({ enabled: true, port: 8080 });
  const cfg = config.readConfig();
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.port, 8080);
  assert.match(cfg.token, /^[0-9a-f]{32}$/);
});

test('端口越界回退到默认值', () => {
  fs.writeFileSync(path.join(TMP, 'remote.json'), JSON.stringify({ port: 99999 }), 'utf-8');
  const cfg = config.readConfig();
  assert.strictEqual(cfg.port, 7799);
});

test('损坏的 JSON 自动修复并重新生成令牌', () => {
  fs.writeFileSync(path.join(TMP, 'remote.json'), '{ 这不是合法 JSON', 'utf-8');
  const cfg = config.readConfig();
  assert.match(cfg.token, /^[0-9a-f]{32}$/);
  const again = config.readConfig();
  assert.strictEqual(again.token, cfg.token);
});

test('令牌为空时补生成', () => {
  fs.writeFileSync(path.join(TMP, 'remote.json'), JSON.stringify({ token: '' }), 'utf-8');
  const cfg = config.readConfig();
  assert.match(cfg.token, /^[0-9a-f]{32}$/);
});

test('writeConfig 原子写：不留临时文件', () => {
  config.readConfig();
  config.writeConfig({ enabled: true });
  const files = fs.readdirSync(TMP);
  const tmpFiles = files.filter((f) => f.includes('.tmp'));
  assert.strictEqual(tmpFiles.length, 0, '残留: ' + tmpFiles.join(','));
});

test('publicUrl 清洗：无协议时补 https://，去尾斜杠', () => {
  config.readConfig();
  config.writeConfig({ publicUrl: 'example.com/' });
  const cfg = config.readConfig();
  assert.strictEqual(cfg.publicUrl, 'https://example.com');
});
