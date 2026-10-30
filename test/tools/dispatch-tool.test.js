/**
 * DispatchTool 单元测试
 * 只测纯逻辑部分（窗口匹配、忙碌拒绝、参数校验），
 * 不触碰 electron / window 模块 —— 依赖用 module._load 拦截注入。
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ===== 依赖打桩 =====
const fakeWindows = new Map();   // profileId -> ctx
let sentMessages = [];           // { profileId, channel, payload }
const origLoad = Module._load;

function installStubs() {
  Module._load = function (request, parent, isMain) {
    if (request === '../src/main/window' || request === './window') {
      return {
        getAllContexts: () => Array.from(fakeWindows.values()),
        getWindowByProfileId: (pid) => fakeWindows.get(pid) || null,
      };
    }
    if (request === '../src/main/profile-manager' || request === './profile-manager') {
      return {
        getProfileById: (pid) => {
          const ctx = fakeWindows.get(pid);
          return ctx ? { id: pid, name: ctx.__name, providerId: ctx.__providerId } : null;
        },
      };
    }
    if (request === '../src/main/activity-tracker' || request === './activity-tracker') {
      return { get: () => ({ running: 0, lastToolName: null, lastAt: 0, lastOk: null }) };
    }
    if (request === '../src/main/generation-state' || request === './generation-state') {
      return { get: () => null };
    }
    if (request === '../src/main/task-status' || request === './task-status') {
      return {
        deriveStatus: (p) => (p && p.generating ? 'running' : 'idle'),
      };
    }
    if (request === './TodoWriteTool') {
      return { getTodos: () => ({ todos: [], archived: false }) };
    }
    return origLoad.apply(this, arguments);
  };
}

function uninstallStubs() {
  Module._load = origLoad;
}

/** 造一个假窗口 ctx */
function makeCtx(profileId, name, providerId, opts = {}) {
  const wc = {
    id: opts.wcId || 1,
    isDestroyed: () => false,
    send: (channel, payload) => sentMessages.push({ profileId, channel, payload }),
  };
  const ctx = {
    profileId,
    providerId,
    __name: name,
    __providerId: providerId,
    view: { webContents: wc },
    sessionStore: { state: { currentSessionId: opts.sessionId || null } },
  };
  fakeWindows.set(profileId, ctx);
  return ctx;
}

test.beforeEach(() => {
  fakeWindows.clear();
  sentMessages = [];
  installStubs();
});

test.afterEach(() => {
  uninstallStubs();
});

// 每个用例重新 require，保证 stub 生效
function loadTools() {
  delete require.cache[require.resolve('../../tools/DispatchTool')];
  return require('../../tools/DispatchTool');
}

test('listWindows: 无窗口时返回空列表', async () => {
  const { ListWindowsTool } = loadTools();
  const r = await new ListWindowsTool().execute({});
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.data.windows, []);
  assert.strictEqual(r.data.count, 0);
});

test('listWindows: 返回名字与平台', async () => {
  makeCtx('p1', '主窗口', 'deepseek');
  makeCtx('p2', '窗口2', 'chatgpt');
  const { ListWindowsTool } = loadTools();
  const r = await new ListWindowsTool().execute({});
  assert.strictEqual(r.data.count, 2);
  const names = r.data.windows.map(w => w.name).sort();
  assert.deepStrictEqual(names, ['主窗口', '窗口2']);
  const p2 = r.data.windows.find(w => w.name === '窗口2');
  assert.strictEqual(p2.provider, 'chatgpt');
});

test('dispatchToWindow: 缺参数报错', async () => {
  const { DispatchToWindowTool } = loadTools();
  const tool = new DispatchToWindowTool();
  assert.strictEqual((await tool.execute({ target: '', instruction: 'x' })).success, false);
  assert.strictEqual((await tool.execute({ target: 'A', instruction: '' })).success, false);
});

test('dispatchToWindow: 找不到窗口时列出可用窗口', async () => {
  makeCtx('p1', '主窗口', 'deepseek');
  const { DispatchToWindowTool } = loadTools();
  const r = await new DispatchToWindowTool().execute({ target: '不存在的窗口', instruction: 'hi' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /找不到窗口/);
  assert.match(r.error, /主窗口/);
});

test('dispatchToWindow: 按名字精确匹配并发送', async () => {
  makeCtx('p1', '主窗口', 'deepseek');
  makeCtx('p2', '窗口2', 'deepseek');
  const { DispatchToWindowTool } = loadTools();
  const r = await new DispatchToWindowTool().execute({ target: '窗口2', instruction: '继续任务' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.target, '窗口2');
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].channel, 'lingya-send-to-chat');
  assert.strictEqual(sentMessages[0].payload.text, '继续任务');
});

test('dispatchToWindow: 按 profileId 匹配', async () => {
  makeCtx('profile-abc', '窗口3', 'deepseek');
  const { DispatchToWindowTool } = loadTools();
  const r = await new DispatchToWindowTool().execute({ target: 'profile-abc', instruction: 'x' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.profileId, 'profile-abc');
});

test('dispatchToWindow: 模糊包含匹配', async () => {
  makeCtx('p1', '代码窗口', 'deepseek');
  const { DispatchToWindowTool } = loadTools();
  const r = await new DispatchToWindowTool().execute({ target: '代码', instruction: 'x' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.target, '代码窗口');
});

test('dispatchToWindow: 目标视图不可用时拒绝', async () => {
  const ctx = makeCtx('p1', '主窗口', 'deepseek');
  ctx.view = null;
  const { DispatchToWindowTool } = loadTools();
  const r = await new DispatchToWindowTool().execute({ target: '主窗口', instruction: 'x' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /AI 视图不可用/);
});

test('listWindows 有 prompt section', async () => {
  const { ListWindowsTool } = loadTools();
  const sec = new ListWindowsTool().getPromptSection();
  assert.ok(sec && sec.text && sec.text.length > 0);
  assert.ok(sec.order > 0);
});

test('dispatchToWindow 有 prompt section 且说明确认规则', async () => {
  const { DispatchToWindowTool } = loadTools();
  const sec = new DispatchToWindowTool().getPromptSection();
  assert.ok(sec && sec.text);
  assert.match(sec.text, /二次确认/);
});
