/**
 * initProject 上下文守卫测试
 * 验证：拿不到窗口上下文时不再静默回退主窗口，而是明确报错。
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let fakeMainCtx = null;
let dialogCalls = 0;

function installStubs() {
  Module._load = function (request) {
    if (request === './window' || request === '../src/main/window') {
      return {
        getMainContext: () => fakeMainCtx,
        getMainWindow: () => (fakeMainCtx ? fakeMainCtx.win : null),
      };
    }
    if (request === 'electron') {
      return {
        app: { getPath: () => 'C:/tmp', isPackaged: true },
        dialog: {
          showOpenDialogSync: () => { dialogCalls++; return null; },
        },
      };
    }
    if (request === './tool-registry') return { toolRegistry: { getFormattedToolsForPrompt: () => '' } };
    if (request === './mcp-client') return { getToolsForPrompt: () => '' };
    if (request === './memory-store') return { getInjectionText: () => '' };
    if (request === './skill-store') return { getInjectionText: () => '' };
    if (request === './security-store') return { getCtfPrompt: () => '' };
    if (request === './agent-store') return {
      getProfile: () => null,
      getAgentId: () => null,
      getState: () => null,
    };
    if (request === './agents') return {
      getAgent: () => ({ id: 'build', deniedTools: [] }),
    };
    if (request === './plugin-host') return { getPromptSections: () => [] };
    return origLoad.apply(this, arguments);
  };
}

function uninstallStubs() {
  Module._load = origLoad;
}

function loadCtx() {
  delete require.cache[require.resolve('../../src/main/project-context')];
  return require('../../src/main/project-context');
}

test.beforeEach(() => {
  fakeMainCtx = null;
  dialogCalls = 0;
  installStubs();
});

test.afterEach(() => {
  uninstallStubs();
});

test('initProject: windowContext 为 null 时直接返回错误，不弹对话框', async () => {
  const { initProject } = loadCtx();
  const r = await initProject(false, null, null, false);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /找不到当前窗口上下文/);
  assert.strictEqual(dialogCalls, 0, '不应该弹出目录选择对话框');
});

test('initProject: 即使主窗口存在，传 null 也不能静默回退', async () => {
  // 模拟「主窗口存在」的场景 —— 旧逻辑会 fallback 到它
  fakeMainCtx = {
    profileId: 'p-main',
    win: { isDestroyed: () => false, webContents: { getURL: () => '' } },
    sessionStore: null,
  };
  const { initProject } = loadCtx();
  const r = await initProject(false, null, null, false);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /找不到当前窗口上下文/);
  assert.strictEqual(dialogCalls, 0);
});

// 说明：原本还有一条「传合法 ctx 时不弹框」的用例，但它会走完 initProject 的整条
// 提示词组装链路（模板 / 工具描述 / 记忆 / 技能 / MCP / 插件 sections），
// 需要为十几个模块写 stub，维护成本高且与本次修复无关。
// 「正常路径未被破坏」已由全量测试覆盖，这里只保留针对本次修复的两条守卫用例。
