'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const LB = String.fromCharCode(0x27E6);
const RB = String.fromCharCode(0x27E7);
const REDACTION = String.fromCharCode(114, 101, 100, 97, 99, 116, 105, 111, 110);
const JSRUNNER = String.fromCharCode(74, 115, 82, 117, 110, 110, 101, 114);
const TOOLREG = String.fromCharCode(84, 111, 111, 108, 82, 101, 103, 105, 115, 116, 114, 121);

function mockRedactionStore() {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return 'MOCK_ELECTRON';
    return origResolve.call(this, request, ...rest);
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ly-unredact-'));
  fs.writeFileSync(path.join(tmpDir, 'lingya-redaction.json'), JSON.stringify({
    version: 2,
    rules: [
      { name: 'x67', words: ['memory'], enabled: true, source: 'manual', scope: 'global' },
      { name: 'x31', words: ['const'], enabled: true, source: 'manual', scope: 'global' },
    ],
  }), 'utf8');
  require.cache['MOCK_ELECTRON'] = {
    id: 'MOCK_ELECTRON', filename: 'MOCK_ELECTRON', loaded: true,
    exports: { app: { getPath: () => tmpDir } },
  };
  Object.keys(require.cache).forEach((k) => {
    if (k.indexOf(REDACTION + '-store') >= 0) delete require.cache[k];
  });
  return () => {
    Module._resolveFilename = origResolve;
    delete require.cache['MOCK_ELECTRON'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
    Object.keys(require.cache).forEach((k) => {
      if (k.indexOf(REDACTION + '-store') >= 0) delete require.cache[k];
    });
  };
}

function makeRunner() {
  const { JsRunner } = require(path.resolve('tools', JSRUNNER + '.js'));
  const { ToolRegistry } = require(path.resolve('tools', TOOLREG + '.js'));
  const captured = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'captureArgs',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => {
      const copy = {};
      Object.keys(args).forEach((k) => { copy[k] = args[k]; });
      captured.push(copy);
      return { success: true, data: 'ok' };
    },
  });
  return { runner: new JsRunner(registry), captured };
}

test('execute-js：顶层字符串参数里的占位符被还原', async () => {
  const restore = mockRedactionStore();
  try {
    const { runner, captured } = makeRunner();
    const code = 'return await captureArgs({ filePath: "src/main/' + LB + 'x67' + RB + '-store.js" });';
    const r = await runner.run(code, process.cwd(), {});
    assert.equal(r.success, true);
    assert.equal(captured[0].filePath, 'src/main/memory-store.js');
    assert.equal(captured[0].filePath.indexOf(LB), -1);
  } finally { restore(); }
});

test('execute-js：数组元素里的占位符被还原', async () => {
  const restore = mockRedactionStore();
  try {
    const { runner, captured } = makeRunner();
    const code = 'return await captureArgs({ list: ["a", "' + LB + 'x67' + RB + '", "' + LB + 'x31' + RB + '"] });';
    const r = await runner.run(code, process.cwd(), {});
    assert.equal(r.success, true);
    assert.deepEqual(captured[0].list, ['a', 'memory', 'const']);
  } finally { restore(); }
});

test('execute-js：多键对象值里的占位符被还原', async () => {
  const restore = mockRedactionStore();
  try {
    const { runner, captured } = makeRunner();
    // 多键对象（k1/k2 两键），避开 __unwrapOne 的单键解包规则
    const code = 'return await captureArgs({ obj: { k1: "' + LB + 'x67' + RB + '", k2: "' + LB + 'x31' + RB + '" } });';
    const r = await runner.run(code, process.cwd(), {});
    assert.equal(r.success, true);
    assert.equal(captured[0].obj.k1, 'memory');
    assert.equal(captured[0].obj.k2, 'const');
  } finally { restore(); }
});

test('execute-js：不认识的占位符保持原样（不误伤）', async () => {
  const restore = mockRedactionStore();
  try {
    const { runner, captured } = makeRunner();
    const unknown = LB + 'not_exists' + RB;
    const code = 'return await captureArgs({ s: "' + unknown + '" });';
    const r = await runner.run(code, process.cwd(), {});
    assert.equal(r.success, true);
    assert.equal(captured[0].s, unknown);
  } finally { restore(); }
});

test('execute-js：无占位符时参数零改动', async () => {
  const restore = mockRedactionStore();
  try {
    const { runner, captured } = makeRunner();
    const code = 'return await captureArgs({ filePath: "src/main/index.js", n: 42 });';
    const r = await runner.run(code, process.cwd(), {});
    assert.equal(r.success, true);
    assert.equal(captured[0].filePath, 'src/main/index.js');
    assert.equal(captured[0].n, 42);
  } finally { restore(); }
});
