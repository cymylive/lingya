'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveDataDir, resolvePortableDataDir, isEmptyDir } = require('../../src/main/data-dir');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-dd-'));
}

test('默认（无便携标记）→ 使用 appData 目录', () => {
  const appData = tmp();
  const exeDir = tmp();
  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(exeDir, 'LingYa.exe'),
    env: {}, fs, sessionDir: 'lingya-ai-pro-session',
  });
  assert.strictEqual(r.portable, false);
  assert.strictEqual(r.dir, path.join(appData, 'lingya-ai-pro-session'));
});

test('PORTABLE_EXECUTABLE_DIR → 便携目录', () => {
  const appData = tmp();
  const portableExeDir = tmp();
  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(tmp(), 'LingYa.exe'),
    env: { PORTABLE_EXECUTABLE_DIR: portableExeDir }, fs, sessionDir: 's',
  });
  assert.strictEqual(r.portable, true);
  assert.strictEqual(r.dir, path.join(portableExeDir, 'LingYa-Data'));
});

test('PORTABLE_EXECUTABLE_FILE → 便携目录（取 exe 所在目录）', () => {
  const appData = tmp();
  const portableExeDir = tmp();
  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(tmp(), 'LingYa.exe'),
    env: { PORTABLE_EXECUTABLE_FILE: path.join(portableExeDir, 'LingYa.exe') }, fs, sessionDir: 's',
  });
  assert.strictEqual(r.portable, true);
  assert.strictEqual(r.dir, path.join(portableExeDir, 'LingYa-Data'));
});

test('FILE 与 DIR 同时存在时 FILE 优先', () => {
  const fileDir = tmp();
  const dirDir = tmp();
  const r = resolveDataDir({
    appDataPath: tmp(), execPath: path.join(tmp(), 'x.exe'),
    env: {
      PORTABLE_EXECUTABLE_FILE: path.join(fileDir, 'LingYa.exe'),
      PORTABLE_EXECUTABLE_DIR: dirDir,
    },
    fs, sessionDir: 's',
  });
  assert.strictEqual(r.dir, path.join(fileDir, 'LingYa-Data'));
});

test('portable.txt 标记 → 便携目录', () => {
  const appData = tmp();
  const exeDir = tmp();
  fs.writeFileSync(path.join(exeDir, 'portable.txt'), '');
  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(exeDir, 'LingYa.exe'),
    env: {}, fs, sessionDir: 's',
  });
  assert.strictEqual(r.portable, true);
  assert.strictEqual(r.dir, path.join(exeDir, 'LingYa-Data'));
});

test('LINGYA_USER_DATA_DIR 显式覆盖优先', () => {
  const custom = tmp();
  const r = resolveDataDir({
    appDataPath: tmp(), execPath: path.join(tmp(), 'x.exe'),
    env: { LINGYA_USER_DATA_DIR: custom, PORTABLE_EXECUTABLE_DIR: tmp() },
    fs, sessionDir: 's',
  });
  assert.strictEqual(r.portable, false);
  assert.strictEqual(r.dir, path.resolve(custom));
});

test('首次便携运行：旧数据自动迁移', () => {
  const appData = tmp();
  const portableExeDir = tmp();
  // 旧目录造数据
  const legacy = path.join(appData, 'sess');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'lingya-memory.json'), '{"memories":[]}');
  fs.mkdirSync(path.join(legacy, 'sub'));
  fs.writeFileSync(path.join(legacy, 'sub', 'a.txt'), 'hi');

  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(tmp(), 'x.exe'),
    env: { PORTABLE_EXECUTABLE_DIR: portableExeDir }, fs, sessionDir: 'sess',
  });
  assert.strictEqual(r.migrated, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'lingya-memory.json')));
  assert.ok(fs.existsSync(path.join(r.dir, 'sub', 'a.txt')));
});

test('便携目录已有数据 → 不迁移、不覆盖', () => {
  const appData = tmp();
  const portableExeDir = tmp();
  const legacy = path.join(appData, 'sess');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'old.json'), 'old');
  const portableData = path.join(portableExeDir, 'LingYa-Data');
  fs.mkdirSync(portableData, { recursive: true });
  fs.writeFileSync(path.join(portableData, 'keep.json'), 'keep');

  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(tmp(), 'x.exe'),
    env: { PORTABLE_EXECUTABLE_DIR: portableExeDir }, fs, sessionDir: 'sess',
  });
  assert.strictEqual(r.migrated, false);
  assert.ok(fs.existsSync(path.join(r.dir, 'keep.json')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'old.json')));
});

test('LINGYA_NO_MIGRATE → 跳过迁移', () => {
  const appData = tmp();
  const portableExeDir = tmp();
  const legacy = path.join(appData, 'sess');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'x.json'), 'x');
  const r = resolveDataDir({
    appDataPath: appData, execPath: path.join(tmp(), 'x.exe'),
    env: { PORTABLE_EXECUTABLE_DIR: portableExeDir, LINGYA_NO_MIGRATE: '1' }, fs, sessionDir: 'sess',
  });
  assert.strictEqual(r.migrated, false);
});

test('isEmptyDir 对不存在/空/非空判断正确', () => {
  const d = tmp();
  assert.strictEqual(isEmptyDir(path.join(d, 'nope'), fs), true);
  assert.strictEqual(isEmptyDir(d, fs), true);
  fs.writeFileSync(path.join(d, 'f'), 'x');
  assert.strictEqual(isEmptyDir(d, fs), false);
});
