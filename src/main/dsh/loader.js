/**
 * DSH 兼容层 - 插件加载器（CommonJS）
 *
 * 链路：插件目录（npm 包）→ 找入口 → esbuild 打包（@deepseek-ai/* 映射到 shim/stub）
 *      → 执行产物 → apply(ctx) → 收集注册的工具
 */
const fs = require('fs');
const path = require('path');
const { DshRuntime } = require('./runtime');
const { setDshSession, makeStub } = require('./shim');
const { PluginStorage } = require('./plugin-storage');
const state = require('./state');

let DATA_DIR = null;
function setDataDir(dir) { DATA_DIR = dir; }

/** shim 文件路径 */
function shimPath() {
  return path.join(__dirname, 'shim.js');
}

/** 在某目录里找入口文件 */
function findEntryIn(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); } catch (_) {}
  const candidates = [
    pkg && pkg.module,
    pkg && pkg.main,
    'index.js',
    'lib/index.js',
    'dist/index.js',
  ].filter((x) => typeof x === 'string' && x);
  for (const rel of candidates) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/** 找插件入口（支持"壳目录"：去 node_modules 找真插件） */
function resolveEntry(pluginDir) {
  const direct = findEntryIn(pluginDir);
  if (direct) return direct;
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8')); } catch (_) {}
  const deps = (pkg && pkg.dependencies) || {};
  for (const depName of Object.keys(deps)) {
    const depDir = path.join(pluginDir, 'node_modules', depName);
    const entry = findEntryIn(depDir);
    if (entry) return entry;
  }
  return null;
}

/**
 * 万能空接口模块（CJS）。
 *
 * 关键：esbuild 的 __toESM/__copyProps 只遍历模块的 ownKeys
 * （Object.getOwnPropertyNames → 触发 ownKeys trap；再对每个 key 调
 *  Object.getOwnPropertyDescriptor → 触发 getOwnPropertyDescriptor trap）。
 * 因此模块级 Proxy 必须：
 *   1) target 用普通对象（{}）—— 函数 target 有 ownKeys/descriptor 的 invariant 约束
 *   2) 提供 ownKeys + getOwnPropertyDescriptor，否则命名导入（import { HarnessError }）拷不到 → undefined
 *   3) ownKeys 不要含 "default"（__toESM 会自己设 default = 整个模块）
 */
const STUB_KEYS = "['HarnessError','Context','Service','defineTool','z','Schema','Logger','assert','assertNever','assertPositiveInteger','assertNonEmptyString','createUserMessage','boundContextSummary','toDisposable','disposable','Command','Agent','Session','Tool','ToolRegistry','GoalId','HarnessContext','HarnessAgent','append','emit','get','set','register','name','inject','defineService','definePlugin','isSkillName','skillName','normalizeSkillName','parseSkill','loadSkill','scanSkills','SkillError','SkillRegistry','isValidName','toErrorMessage','createId','isHarnessError']";
const STUB_MODULE_CODE = [
  "const __KEYS = " + STUB_KEYS + ";",
  "const __makeStub = (name) => {",
  "  const fn = function () { return p; };",
  "  const p = new Proxy(fn, {",
  "    get(t, prop) {",
  "      if (prop === 'then') return undefined;",
  "      if (prop === '__esModule') return false;",
  "      if (prop === 'default') return p;",
  "      if (prop === 'toString') return () => '[dsh-stub ' + name + ']';",
  "      if (prop === Symbol.toPrimitive) return () => name;",
  "      return __makeStub(name + '.' + String(prop));",
  "    },",
  "    apply() { return p; },",
  "    construct(t, args) {",
  "      if (/Error$/.test(name)) {",
  "        const e = new Error(args && args[0] != null ? String(args[0]) : name);",
  "        e.name = name;",
  "        if (args && args[1] != null) e.code = args[1];",
  "        return e;",
  "      }",
  "      return p;",
  "    },",
  "  });",
  "  return p;",
  "};",
  "const __mod = new Proxy({}, {",
  "  get(t, prop) {",
  "    if (prop === '__esModule') return true;",
  "    if (prop === 'default') return __mod;",
  "    if (typeof prop === 'symbol') return undefined;",
  "    return __makeStub('@deepseek-ai/stub.' + String(prop));",
  "  },",
  "  ownKeys() { return __KEYS.slice(); },",
  "  getOwnPropertyDescriptor(t, prop) {",
  "    return { value: __makeStub('@deepseek-ai/stub.' + String(prop)), enumerable: true, configurable: true, writable: true };",
  "  },",
  "  has() { return true; },",
  "});",
  "module.exports = __mod;",
].join(String.fromCharCode(10));

/** 用 esbuild 打包插件：把 @deepseek-ai/* 映射到 shim/stub */
async function bundlePlugin(entryFile) {
  // 打包版（asar）：esbuild 二进制在 app.asar.unpacked，但 esbuild 会去 app.asar 内找 →
  // Electron 不重定向 spawn 路径 → ENOENT。显式设 ESBUILD_BINARY_PATH 指向 unpacked。
  try {
    if (!process.env.ESBUILD_BINARY_PATH) {
      const fs2 = require('fs');
      const path2 = require('path');
      const binName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
      const pkgName = '@esbuild/' + process.platform + '-' + process.arch;
      const candidates = [];
      // 候选 1：从 require.resolve('esbuild') 的路径里替换 app.asar → app.asar.unpacked
      try {
        const resolved = require.resolve('esbuild');
        if (resolved.includes('app.asar')) {
          const base = resolved.replace('app.asar', 'app.asar.unpacked');
          // resolved 形如 .../node_modules/esbuild/lib/main.js → 上溯到 node_modules
          const nm = base.slice(0, base.indexOf('node_modules') + 'node_modules'.length);
          candidates.push(path2.join(nm, pkgName, binName));
        }
      } catch (_) {}
      // 候选 2：__dirname 上溯（loader 在 .../app.asar/src/main/dsh/）
      const here = __dirname.replace('app.asar', 'app.asar.unpacked');
      const nmIdx = here.indexOf('node_modules');
      if (nmIdx > 0) {
        candidates.push(path2.join(here.slice(0, nmIdx), 'node_modules', pkgName, binName));
      }
      // 候选 3：process.resourcesPath
      if (process.resourcesPath) {
        candidates.push(path2.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkgName, binName));
      }
      for (const c of candidates) {
        if (fs2.existsSync(c)) { process.env.ESBUILD_BINARY_PATH = c; break; }
      }
    }
  } catch (_) { /* 尽力而为 */ }
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    throw new Error('缺少 esbuild 依赖，请先 npm install esbuild（' + err.message + '）');
  }
  const shim = shimPath();
  const result = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'lingya-dsh-shim',
      setup(build) {
        // @deepseek-ai/cordis / dsh-tools / schemastery → 我们的 shim（真实现）
        build.onResolve({ filter: /^@deepseek-ai\/(cordis|dsh-tools|schemastery)$/ }, () => ({ path: shim }));
        // 其他 @deepseek-ai/* → 万能空接口
        build.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({ path: args.path, namespace: 'dsh-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'dsh-stub' }, () => ({ contents: STUB_MODULE_CODE, loader: 'js' }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

/** 宿主能力（由 app 层注入） */
// {
//   getToolNames(): string[]
//   getPluginConfig(id): object
//   setPluginConfig(id, values): boolean
//   getCurrentSession(): { id, projectDir }
//   listSessions(): [{ id, title }]
//   getSession(id): { id, title } | null
//   getSessionTitle(): string|null
//   setSessionTitle(title): boolean
// }

/** 造一个"假 ctx"——收集插件注册的工具；未知属性用 stub 兜底 */
function createCollectorCtx(pluginName, host, runtime) {
  const tools = [];
  const { DshAgentRuntime } = require('./agent-runtime');
  const { GoalsService } = require('./goals-service');
  const { SkillsService } = require('./skills-service');
  const { createFs } = require('./fs-service');
  const { registerPromptSection, getPromptSections } = require('./prompt-sections');
  const { registerBus } = require('./event-bridge');
  // 最小 agent 运行时（让依赖 agent 生命周期的插件能执行）
  const agentRuntime = new DshAgentRuntime();
  const goals = new GoalsService();
  const skills = new SkillsService();
  const pluginDisposers = [];
  const base = {
    sessionProjections: runtime ? runtime.projections : undefined,
    // ctx.agents / ctx.goals / ctx.skills：agent 生命周期 + 目标 + 技能服务
    agents: agentRuntime.agents,
    goals,
    skills,
    // ctx.web：dsh-tool-web 依赖的网页能力服务
    web: {
      fetch: (args, signal) => require('./web-service').webFetch(args, signal),
      search: (args, signal) => require('./web-service').webSearch(args, signal),
    },
    name: pluginName,
    // ctx.fs：文件服务（相对项目目录）
    fs: createFs(() => (host && host.getCurrentSession ? host.getCurrentSession().projectDir : null)),
    // ctx.systemPrompt：插件注册提示词段（合并进系统提示词）
    systemPrompt: {
      section(sec) { const d = registerPromptSection(sec, pluginName); pluginDisposers.push(d); return d; },
      sections() { return getPromptSections(); },
    },
    log: (...args) => console.log('[DSHPlugin:' + pluginName + ']', ...args),
    tools: {
      register(tool) { tools.push(tool); return () => {}; },
      list() { return host && host.getToolNames ? host.getToolNames() : tools.map((t) => t.name); },
    },
    settings: {
      get(key) {
        if (!host || !host.getPluginConfig) return undefined;
        return (host.getPluginConfig(pluginName) || {})[key];
      },
      set(key, value) {
        if (!host || !host.setPluginConfig || !host.getPluginConfig) return;
        const cur = host.getPluginConfig(pluginName) || {};
        cur[key] = value;
        host.setPluginConfig(pluginName, cur);
      },
    },
    sessions: {
      current() { return host && host.getCurrentSession ? host.getCurrentSession() : { id: null, projectDir: null }; },
      list() { return host && host.listSessions ? host.listSessions() : []; },
      get(id) { return host && host.getSession ? host.getSession(id) : null; },
    },
    sessionTitle: {
      get() { return host && host.getSessionTitle ? host.getSessionTitle() : null; },
      set(t) { return host && host.setSessionTitle ? host.setSessionTitle(t) : false; },
    },
    // 事件总线：简化为 Node EventEmitter 语义
    on(event, listener) { getBus().on(event, listener); return () => getBus().off(event, listener); },
    once(event, listener) { getBus().once(event, listener); return () => getBus().off(event, listener); },
    off(event, listener) { getBus().off(event, listener); },
    emit(event, ...args) { getBus().emit(event, ...args); },
    parallel(event, ...args) { getBus().emit(event, ...args); },
    serial(event, ...args) { getBus().emit(event, ...args); },
    bail(event, ...args) { getBus().emit(event, ...args); },
    waterfall(event, value, ...args) { getBus().emit(event, value, ...args); return value; },
    effect(fn) { try { const c = fn(); return typeof c === 'function' ? c : () => {}; } catch (_) { return () => {}; } },
    scope() { return { effect: () => () => {}, on: () => () => {}, dispose() {}, disposed: false }; },
    provide() { return () => {}; },
    get() { return undefined; },
    inject(_names, cb) { if (typeof cb === 'function') { try { cb(ctx); } catch (_) {} } return () => {}; },
  };
  // 每个插件一个事件总线（注册到 event-bridge，接收主进程 AI 事件）
  let bus = null;
  function getBus() {
    if (!bus) {
      const { EventEmitter } = require('events');
      bus = new EventEmitter();
      bus.setMaxListeners(0);
      // 包一层 emit（event-bridge 用 bus.emit 广播）
      registerBus(bus);
    }
    return bus;
  }
  const ctx = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return makeStub('ctx.' + String(prop));
    },
  });
  return { ctx, tools, agentRuntime, goals, pluginDisposers };
}

/** 从 dsh 工具参数生成 jsApi 签名，如 todo_write(todos) */
function buildJsApi(tool) {
  let keys = [];
  try { keys = Object.keys((tool.parameters && tool.parameters.properties) || {}); } catch (_) {}
  return tool.name + '(' + keys.join(', ') + ')';
}

/** 把 dsh 工具包装成 LingYa Tool 实例（execute 返回 ToolResult，带 jsApi） */
function wrapAsLingYaTool(dshTool, agentRuntime) {
  const { Tool, ToolResult } = require('../../../tools/ToolRegistry');
  const inst = new Tool(dshTool.name, dshTool.description, dshTool.parameters || { type: 'object', properties: {} }, buildJsApi(dshTool));
  inst.execute = async (params) => {
    try {
      // 开一个 model turn + 注入 exec.agent（agent 生命周期插件依赖）
      let agent = null;
      if (agentRuntime) {
        agent = agentRuntime.openTurn({ kind: 'user' });
      }
      const exec = agent ? { agent, signal: undefined } : undefined;
      const out = await dshTool.execute(params || {}, exec);
      if (agentRuntime) agentRuntime.closeTurn();
      return ToolResult.success(out);
    } catch (err) {
      try { if (agentRuntime) agentRuntime.closeTurn(); } catch (_) {}
      return ToolResult.error('DSH 工具执行失败: ' + (err && err.message ? err.message : String(err)));
    }
  };
  return inst;
}

/** 从插件目录加载，返回 { pluginName, tools }（tools 是 LingYa Tool 实例） */
async function loadDshPlugin(pluginDir, host) {
  const entry = resolveEntry(pluginDir);
  if (!entry) throw new Error('未找到插件入口（package.json main / index.js）');
  const id = path.basename(pluginDir);
  const runtime = new DshRuntime();
  // 接持久化（JSONL 落盘 + 启动重放）
  try { if (DATA_DIR) runtime.session.attachStorage(new PluginStorage(DATA_DIR, id)); } catch (_) {}
  setDshSession(runtime.session);
  const code = await bundlePlugin(entry);
  const moduleObj = { exports: {} };
  const fn = new Function('module', 'exports', 'require', code + String.fromCharCode(10) + ';return module.exports;');
  const mod = fn(moduleObj, moduleObj.exports, require);
  const plugin = (mod && mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const pluginName = (plugin && typeof plugin.name === 'string' && plugin.name) ? plugin.name : id;
  const { ctx, tools, agentRuntime } = createCollectorCtx(pluginName, host, runtime);
  if (plugin && typeof plugin.apply === 'function') {
    // 用插件导出的 Config schema 解析默认值（schemastery 约定：Config(config) 合并默认）
    let resolvedConfig = plugin.config || {};
    try {
      if (typeof plugin.Config === 'function') resolvedConfig = plugin.Config(resolvedConfig) || resolvedConfig;
    } catch (err) {
      console.warn('[DSH] 解析插件 Config 失败 (' + pluginName + '):', err.message);
    }
    await plugin.apply(ctx, resolvedConfig);
  }
  // 包装成 LingYa Tool 实例
  const wrapped = tools.map((t) => wrapAsLingYaTool(t, agentRuntime));
  return { pluginName, tools: wrapped, runtime };
}

module.exports = { loadDshPlugin, resolveEntry, bundlePlugin, setDataDir, createCollectorCtx, findEntryIn, wrapAsLingYaTool, buildJsApi };
