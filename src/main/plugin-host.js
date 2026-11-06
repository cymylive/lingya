/**
 * PluginHost —— 轻量插件宿主（借鉴 dsh/Cordis 的 4 个核心思想，去掉框架重量）
 *
 * 核心概念：
 *   - 插件 = 一个目录，含 manifest.json + entry 指向的 index.js
 *   - 插件导出 { apply(ctx) }，在 apply 里通过 ctx 注册能力
 *   - 注册是可逆副作用：ctx.registerTool / ctx.on / ctx.effect 都返回 disposer
 *   - 卸载时按注册逆序调用所有 disposer，实现"删掉插件 = 干净消失"
 *
 * 目录约定：
 *   <userData>/plugins/<id>/manifest.json
 *   <userData>/plugins/<id>/index.js
 *
 * manifest.json 字段：
 *   { id, name, version, entry?, description?, icon?, author? }
 *
 * 安全：插件在【主进程】执行，与内置工具同权限级别（本地信任模型）。
 *       插件作者需自行保证代码安全；宿主只做加载/卸载/隔离注册表。
 */
const fs = require('fs');
const path = require('path');
const { Tool } = require('../../tools/ToolRegistry');
const pluginStore = require('./plugin-store');
const pluginZip = require('./plugin-zip');

// 惰性获取工具注册表：plugin-host 只在主进程使用，但单元测试可能在纯 Node 环境
// require 本模块；此时 tool-registry 会连带加载 electron 相关模块而失败。
let _toolRegistry = null;
function getToolRegistry() {
  if (!_toolRegistry) {
    _toolRegistry = require('./tool-registry').toolRegistry;
  }
  return _toolRegistry;
}

// 已加载的插件：id -> { manifest, dir, disposers: [], status }
const loaded = new Map();
// 插件目录（由 init 设置）
let PLUGINS_DIR = null;
// 最近一次使用的源目录 override（测试用；同时让 isBundledId 在测试环境也能找到源目录）
let _lastSourceOverride = null;
// 插件注册的 IPC 处理器：fullChannel(=pluginId:channel) -> { pluginId, channel, handler }
const pluginIpcHandlers = new Map();
// 插件注册的视图：viewKey(=pluginId:viewId) -> { pluginId, viewId, icon, label, render }
const pluginViews = new Map();
// 插件注册的 preload 脚本：pluginId -> [scriptText, ...]
const pluginPreloads = new Map();
// 插件事件总线（简单的 EventEmitter，供插件挂钩）
const { EventEmitter } = require('events');
const pluginEvents = new EventEmitter();
pluginEvents.setMaxListeners(0);

// 插件注册的提示词段落：placeholder -> getter
const pluginPromptSections = new Map();



/**
 * 初始化：确定插件目录 + 播种随应用附带的示例插件
 * @param {string} storeDir  userData 目录
 */
function init(storeDir) {
  PLUGINS_DIR = path.join(storeDir, 'plugins');
  try {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  } catch (err) {
    console.error('[PluginHost] 创建插件目录失败:', err.message);
  }
  console.log('[PluginHost] 插件目录:', PLUGINS_DIR);
  seedBundledPlugins();
}

/**
 * 比较两个语义化版本号。
 * @returns {number} a > b 返回 1，a < b 返回 -1，相等返回 0
 */
function compareVersion(a, b) {
  if (a === b) return 0;
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = isNaN(pa[i]) ? 0 : pa[i];
    const nb = isNaN(pb[i]) ? 0 : pb[i];
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 探测应用自带插件源目录。
 * 打包后在 resources/plugins；开发时在项目根 plugins/。
 * @param {string} [srcDirOverride] 测试用，强制指定源目录
 * @returns {string|null} 存在的目录路径，找不到返回 null
 */
function findBundledSourceDir(srcDirOverride) {
  if (srcDirOverride) _lastSourceOverride = srcDirOverride;
  // 显式指定 override 但它不存在时直接返回 null，不回退到真实目录 ——
  // 保证测试可以模拟「源目录被裁掉」而不被真实项目 plugins/ 干扰。
  if (_lastSourceOverride && !fs.existsSync(_lastSourceOverride)) return null;
  const candidates = [
    _lastSourceOverride,
    path.join(process.resourcesPath || '', 'plugins'),
    path.join(__dirname, '..', '..', 'plugins'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; } catch (_) {}
  }
  return null;
}

/**
 * 判断某个插件是否为应用内置插件（源目录中存在同名子目录）。
 * 源目录找不到时一律返回 false —— 测试/打包异常环境下宁可当作普通插件。
 * @param {string} pluginId
 * @returns {boolean}
 */
function isBundledId(pluginId) {
  if (!pluginId) return false;
  const srcDir = findBundledSourceDir();
  if (!srcDir) return false;
  try {
    return fs.existsSync(path.join(srcDir, pluginId)) &&
      fs.statSync(path.join(srcDir, pluginId)).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * 把应用自带的 plugins/ 目录复制到 userData/plugins/。
 * 规则：
 * 1. 目标不存在 -> 全量复制
 * 2. 目标存在，且内置插件版本号大于目标版本号 -> 强制覆盖（修复升级后旧版插件缓存不更新的问题）
 * 3. 目标存在，版本相同 -> 只补齐缺失文件，不覆盖用户改动
 * 4. 带墓碑（用户主动删除）的内置插件 -> 跳过，不播种
 * @param {string} [srcDirOverride] 测试用，强制指定源目录
 */
function seedBundledPlugins(srcDirOverride) {
  const srcDir = findBundledSourceDir(srcDirOverride);
  if (!srcDir) return;
  let items = [];
  try { items = fs.readdirSync(srcDir, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of items) {
    if (!ent.isDirectory()) continue;
    // 【墓碑】用户主动删除过的内置插件不再播种，否则重启会复活
    if (pluginStore.isDeleted(ent.name)) {
      console.log('[PluginHost] 跳过带墓碑的插件:', ent.name);
      continue;
    }
    const src = path.join(srcDir, ent.name);
    const dst = path.join(PLUGINS_DIR, ent.name);
    if (fs.existsSync(dst)) {
      let srcVer = null;
      let dstVer = null;
      try {
        const srcMf = path.join(src, 'manifest.json');
        if (fs.existsSync(srcMf)) srcVer = JSON.parse(fs.readFileSync(srcMf, 'utf8')).version;
        const dstMf = path.join(dst, 'manifest.json');
        if (fs.existsSync(dstMf)) dstVer = JSON.parse(fs.readFileSync(dstMf, 'utf8')).version;
      } catch (_) {}

      if (srcVer && dstVer && compareVersion(srcVer, dstVer) > 0) {
        console.log('[PluginHost] 插件有新版本，执行强制覆盖升级:', ent.name, dstVer, '->', srcVer);
        try {
          fs.rmSync(dst, { recursive: true, force: true });
          copyDirRecursive(src, dst);
        } catch (err) {
          console.error('[PluginHost] 覆盖升级插件失败 (' + ent.name + '):', err.message);
        }
      } else {
        // 版本相同或无法解析：只补齐缺失文件（老用户升级场景），不覆盖用户改动
        try { mergeDirRecursive(src, dst); } catch (err) {
          console.error('[PluginHost] 补齐插件文件失败 (' + ent.name + '):', err.message);
        }
      }
      continue;
    }
    try {
      copyDirRecursive(src, dst);
      console.log('[PluginHost] 已播种插件:', ent.name);
    } catch (err) {
      console.error('[PluginHost] 播种插件失败 (' + ent.name + '):', err.message);
    }
  }
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 合并式复制：只补齐目标目录里**缺失**的文件，绝不覆盖已有文件。
 * 场景：老用户升级到新版，插件目录已存在，但新版插件新增了文件
 * （如 preload.js），需要补上；同时用户改过的文件必须保持原样。
 */
function mergeDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      mergeDirRecursive(s, d);
    } else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      console.log('[PluginHost] 补齐插件缺失文件:', d);
    }
  }
}

function getPluginsDir() {
  return PLUGINS_DIR;
}

/**
 * 扫描插件目录，返回所有找到的插件（不加载，只读 manifest）
 * @returns {Array<{id, name, version, description, icon, dir, manifest, enabled}>}
 */
function scanPlugins() {
  if (!PLUGINS_DIR || !fs.existsSync(PLUGINS_DIR)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error('[PluginHost] 读取插件目录失败:', err.message);
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(PLUGINS_DIR, ent.name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.error('[PluginHost] 解析 manifest 失败 (' + ent.name + '):', err.message);
      continue;
    }
    if (!manifest || !manifest.id) {
      console.error('[PluginHost] 插件缺少 id 字段:', ent.name);
      continue;
    }
    out.push({
      id: manifest.id,
      name: manifest.name || manifest.id,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      icon: manifest.icon || '🔌',
      entry: manifest.entry || 'index.js',
      dir,
      manifest,
      enabled: pluginStore.isEnabled(manifest.id, true),
      pinned: pluginStore.isPinned(manifest.id),
      bundled: isBundledId(manifest.id),
    });
  }
  return out;
}

/**
 * 构造插件上下文 ctx（借鉴 Cordis 但简化）
 * 所有注册方法都返回 disposer。
 * @param {object} plugin 扫描得到的插件对象
 */
function createContext(plugin) {
  const disposers = [];

  const ctx = {
    pluginId: plugin.id,
    pluginDir: plugin.dir,
    // 配置优先级：持久化的用户配置 > manifest 默认 config
    config: Object.assign({}, plugin.manifest.config || {}, (() => {
      try { return pluginStore.getPluginConfig(plugin.id) || {}; } catch (_) { return {}; }
    })()),

    log(...args) {
      console.log('[' + plugin.id + ']', ...args);
    },

    /**
     * 注册一个工具（对象或 Tool 实例）
     * @returns {Function} disposer（注销工具 + 移除注册记录）
     */
    registerTool(tool) {
      if (!tool || !tool.name) throw new Error('registerTool: 工具必须有 name');
      // 允许传普通对象，包装成 Tool 实例
      const instance = tool instanceof Tool ? tool : Object.assign(new Tool(
        tool.name, tool.description, tool.parameters, tool.jsApi
      ), tool);
      const registry = getToolRegistry();
      registry.register(instance);
      if (Array.isArray(plugin._toolNames) && plugin._toolNames.indexOf(instance.name) < 0) {
        plugin._toolNames.push(instance.name);
      }
      const dispose = () => { registry.unregister(instance.name); };
      disposers.push(dispose);
      return dispose;
    },

    /**
     * 监听插件事件（可挂钩宿主事件）
     * @returns {Function} disposer
     */
    on(event, handler) {
      pluginEvents.on(event, handler);
      const dispose = () => { pluginEvents.off(event, handler); };
      disposers.push(dispose);
      return dispose;
    },

    /** 派发插件事件 */
    emit(event, ...args) {
      pluginEvents.emit(event, ...args);
    },

    /**
     * 注册任意可逆副作用（fn 返回 disposer，或本身是清理函数）
     * @returns {Function} disposer
     */
    effect(fn) {
      const result = typeof fn === 'function' ? fn() : fn;
      const dispose = typeof result === 'function' ? result : () => {};
      disposers.push(dispose);
      return dispose;
    },

    /**
     * 注册一个 IPC 通道（渲染进程通过 shellAPI.invokePlugin / electronAPI.invokePlugin 调用）
     * channel 建议加插件前缀避免冲突；宿主内部会再加 pluginId: 前缀。
     * @param {string} channel
     * @param {Function} handler  async (args, event) => any
     * @returns {Function} disposer
     */
    registerIpc(channel, handler) {
      if (!channel || typeof handler !== 'function') throw new Error('registerIpc: 需要 channel 和 handler');
      const full = plugin.id + ':' + channel;
      pluginIpcHandlers.set(full, { pluginId: plugin.id, channel, handler });
      const dispose = () => { pluginIpcHandlers.delete(full); };
      disposers.push(dispose);
      return dispose;
    },

    /**
     * 注册一段系统提示词内容。
     * 宿主在组装 systemPrompt 时会调用所有已注册的 getter，替换模板中的对应占位符。
     * @param {string} placeholder 占位符名称（不含花括号），如 'CORE_RULE_REPORT'
     * @param {Function} getter  () => string，返回要注入的内容
     * @returns {Function} disposer
     */
    registerPromptSection(placeholder, getter) {
      if (!placeholder || typeof getter !== 'function') {
        throw new Error('registerPromptSection: 需要 placeholder 和 getter 函数');
      }
      pluginPromptSections.set(placeholder, getter);
      const dispose = () => { pluginPromptSections.delete(placeholder); };
      disposers.push(dispose);
      return dispose;
    },

    /**
     * 注册一个侧栏视图（往活动栏加图标 + 面板）
     * @param {object} view { id, icon, label, title?, render }
     *   - id: 视图 id（同一插件内唯一）
     *   - icon: 活动栏图标（emoji 或 HTML）
     *   - label: 活动栏文字
     *   - title: 面板标题（默认同 label）
     *   - render: () => string，返回面板 HTML（在主进程执行，纯字符串）
     * @returns {Function} disposer
     */
    registerView(view) {
      if (!view || !view.id || typeof view.render !== 'function') {
        throw new Error('registerView: 需要 { id, render }');
      }
      const viewId = plugin.id + ':' + view.id;
      pluginViews.set(viewId, {
        pluginId: plugin.id,
        viewId: view.id,
        icon: view.icon || '🔌',
        label: view.label || view.id,
        title: view.title || view.label || view.id,
        render: view.render,
      });
      const dispose = () => { pluginViews.delete(viewId); };
      disposers.push(dispose);
      return dispose;
    },

    /**
     * 注册一段 preload 脚本（注入到 AI 网页的渲染进程）
     * 用于挂钩 AI 页面 DOM / 网络，与 ctx.on 配合。
     * @param {string} scriptText
     * @returns {Function} disposer
     */
    registerPreload(scriptText) {
      if (typeof scriptText !== 'string' || !scriptText.trim()) {
        throw new Error('registerPreload: 需要非空脚本文本');
      }
      if (!pluginPreloads.has(plugin.id)) pluginPreloads.set(plugin.id, []);
      pluginPreloads.get(plugin.id).push(scriptText);
      const dispose = () => {
        const arr = pluginPreloads.get(plugin.id);
        if (!arr) return;
        const i = arr.indexOf(scriptText);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) pluginPreloads.delete(plugin.id);
      };
      disposers.push(dispose);
      return dispose;
    },
  };

  // 记录本插件注册的工具名（供 listPlugins / 能力注入使用）
  plugin._toolNames = [];

  // ===== DSH 标准别名（统一插件标准：本地插件也能用 DSH 风格 API）=====
  const wrapDshTool = (tool) => {
    if (!tool || !tool.name) throw new Error('tools.register: 工具必须有 name');
    if (tool instanceof Tool) return tool;
    const { ToolResult } = require('../../tools/ToolRegistry');
    // DSH 参数格式（隐式 object，每属性 required 标注）→ 标准 JSON Schema
    let params = tool.parameters || {};
    if (params && params.type !== 'object' && !params.properties) {
      try { params = require('./dsh/shim').dshParamsToJsonSchema(params); } catch (_) { params = { type: 'object', properties: {} }; }
    } else if (!params.type) {
      params = { type: 'object', properties: params.properties || {} };
    }
    const propKeys = Object.keys((params && params.properties) || {});
    const inst = new Tool(
      tool.name, tool.description || '', params,
      tool.jsApi || (tool.name + '(' + propKeys.join(', ') + ')')
    );
    inst.execute = async (params) => {
      try {
        const out = await tool.execute(params || {});
        if (out && typeof out === 'object' && 'success' in out) return out;
        return ToolResult.success(typeof out === 'string' ? out : JSON.stringify(out));
      } catch (err) {
        return ToolResult.error('工具执行失败: ' + (err && err.message ? err.message : String(err)));
      }
    };
    return inst;
  };
  ctx.tools = {
    register(tool) { return ctx.registerTool(wrapDshTool(tool)); },
    list() { try { return getToolRegistry().listNames(); } catch (_) { return []; } },
  };
  ctx.settings = {
    get(key) { return (ctx.config || {})[key]; },
    set(key, value) {
      ctx.config = ctx.config || {};
      ctx.config[key] = value;
      // 落盘（重启保留）；失败不影响运行
      // 【2026-11-06 修复 #7】写盘失败不再完全静默，至少记录错误
      try { pluginStore.savePluginConfig(plugin.id, ctx.config); } catch (e) {
        console.warn('[PluginHost] 保存插件配置失败 (' + plugin.id + ', key=' + key + '):', e && e.message);
      }
    },
    // 保存整个配置对象，供插件在修改多处配置时统一落盘
    save() {
      try { pluginStore.savePluginConfig(plugin.id, ctx.config || {}); } catch (e) {
        console.warn('[PluginHost] 保存插件配置失败 (' + plugin.id + '):', e && e.message);
      }
    }
  };
  ctx.sessions = {
    current() { try { const dsh = require('./dsh'); return dsh.getCurrentSession ? dsh.getCurrentSession() : { id: null, projectDir: null }; } catch (_) { return { id: null, projectDir: null }; } },
    list() { try { const dsh = require('./dsh'); return dsh.listSessions ? dsh.listSessions() : []; } catch (_) { return []; } },
    get(id) { try { const dsh = require('./dsh'); return dsh.getSession ? dsh.getSession(id) : null; } catch (_) { return null; } },
  };

  return { ctx, disposers };
}

/**
 * 加载单个插件
 * @param {object} plugin 扫描得到的插件对象
 * @returns {{ success: boolean, error?: string }}
 */
async function loadPlugin(plugin) {
  if (loaded.has(plugin.id)) {
    return { success: false, error: '插件已加载: ' + plugin.id };
  }
  const entryPath = path.join(plugin.dir, plugin.entry);
  if (!fs.existsSync(entryPath)) {
    return { success: false, error: '入口文件不存在: ' + plugin.entry };
  }
  let mod = null;
  // 优先走 esbuild 打包（统一标准：支持 ESM + @deepseek-ai/* import）
  try {
    const dshLoader = require('./dsh/loader');
    const code = await dshLoader.bundlePlugin(entryPath);
    if (code) {
      const moduleObj = { exports: {} };
      // 注入 __dirname/__filename：new Function 执行的代码没有模块作用域，
      // 插件里用 path.join(__dirname, ...) 会抛 "__dirname is not defined"
      const fn = new Function(
        'module', 'exports', 'require', '__dirname', '__filename',
        code + '\n;return module.exports;'
      );
      mod = fn(moduleObj, moduleObj.exports, require, plugin.dir, entryPath);
    }
  } catch (err) {
    console.warn('[PluginHost] esbuild 打包失败，回退 require:', err.message);
  }
  if (!mod) {
    try {
      // 清除 require 缓存，支持重载
      delete require.cache[require.resolve(entryPath)];
      mod = require(entryPath);
    } catch (err) {
      console.error('[PluginHost] 加载插件失败 (' + plugin.id + '):', err.message);
      return { success: false, error: 'require 失败: ' + err.message };
    }
  }
  // 兼容：模块可能是 { apply } / 函数 / { default: { apply } }
  if (mod && mod.default && typeof mod.default === 'object' && typeof mod.default.apply === 'function') {
    mod = mod.default;
  }
  const apply = mod && (typeof mod === 'function' ? mod : mod.apply);
  if (typeof apply !== 'function') {
    return { success: false, error: '插件未导出 apply(ctx) 函数' };
  }
  const { ctx, disposers } = createContext(plugin);
  try {
    const ret = apply(ctx);
    // 支持 apply 返回 Promise（异步初始化会被等待）
    if (ret && typeof ret.then === 'function') {
      await ret;
    }
  } catch (err) {
    // apply 失败：回滚已注册的副作用
    console.error('[PluginHost] 插件 apply 失败 (' + plugin.id + '):', err.message);
    for (let i = disposers.length - 1; i >= 0; i--) {
      try { disposers[i](); } catch (_) {}
    }
    return { success: false, error: 'apply 执行失败: ' + err.message };
  }
  loaded.set(plugin.id, { manifest: plugin.manifest, dir: plugin.dir, disposers, status: 'loaded', toolNames: plugin._toolNames || [] });
  console.log('[PluginHost] 已加载插件:', plugin.id, 'v' + plugin.version);
  return { success: true };
}

/**
 * 卸载单个插件（按注册逆序回滚所有副作用）
 * @param {string} pluginId
 * @returns {{ success: boolean, error?: string }}
 */
function unloadPlugin(pluginId) {
  const rec = loaded.get(pluginId);
  if (!rec) return { success: false, error: '插件未加载: ' + pluginId };
  for (let i = rec.disposers.length - 1; i >= 0; i--) {
    try { rec.disposers[i](); } catch (err) {
      console.error('[PluginHost] 卸载 disposer 失败 (' + pluginId + '):', err.message);
    }
  }
  loaded.delete(pluginId);
  console.log('[PluginHost] 已卸载插件:', pluginId);
  return { success: true };
}

/**
 * 按依赖顺序排列已启用插件（拓扑排序）。
 * manifest 可声明 depends: ["otherId", ...]；缺失或被禁用的依赖会被跳过并警告。
 */
function orderByDependencies(plugins) {
  const enabled = plugins.filter((p) => p.enabled);
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const visited = new Set();
  const visiting = new Set();
  const out = [];

  function visit(p, chain) {
    if (visited.has(p.id)) return;
    if (visiting.has(p.id)) {
      console.warn('[PluginHost] 检测到循环依赖，跳过:', chain.concat(p.id).join(' -> '));
      return;
    }
    visiting.add(p.id);
    const deps = Array.isArray(p.manifest.depends) ? p.manifest.depends : [];
    for (const dep of deps) {
      const dp = byId.get(dep);
      if (!dp) {
        console.warn('[PluginHost] 插件 ' + p.id + ' 依赖 ' + dep + ' 未启用/不存在，已忽略');
        continue;
      }
      visit(dp, chain.concat(p.id));
    }
    visiting.delete(p.id);
    visited.add(p.id);
    out.push(p);
  }

  for (const p of enabled) visit(p, []);
  return out;
}

/**
 * 加载所有已启用的插件（宿主启动时调用，按依赖顺序）
 */
async function loadAllEnabled() {
  const plugins = scanPlugins();
  const ordered = orderByDependencies(plugins);
  let ok = 0, fail = 0;
  for (const p of ordered) {
    const res = await loadPlugin(p);
    if (res.success) ok++; else fail++;
  }
  console.log('[PluginHost] 启动加载完成：成功 ' + ok + '，失败 ' + fail);
  return { total: plugins.length, loaded: ok, failed: fail };
}

/**
 * 列出插件（含加载状态），供 UI 显示
 */
function listPlugins() {
  const scanned = scanPlugins();
  return scanned.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    icon: p.icon,
    enabled: p.enabled,
    // 置顶状态必须透传给前端：draw() 依赖 p.pinned 排序 + 回显复选框。
    // 漏传会导致「勾选后不生效、刷新后勾选消失」（scanPlugins 里本来就有这个字段）。
    pinned: p.pinned === true,
    loaded: loaded.has(p.id),
    toolNames: loaded.has(p.id) ? (loaded.get(p.id).toolNames || []) : [],
    dir: p.dir,
  }));
}

/**
 * 设置插件置顶状态（仅影响侧边栏列表的排序，不改变插件加载行为）
 */
async function setPluginPinned(pluginId, pinned) {
  if (!pluginId) throw new Error('pluginId 不能为空');
  pluginStore.setPinned(pluginId, pinned);
  return { success: true, pinned: !!pinned };
}

/**
 * 启用/禁用插件（运行时生效）
 * @param {string} pluginId
 * @param {boolean} enabled
 */
async function setPluginEnabled(pluginId, enabled) {
  pluginStore.setEnabled(pluginId, enabled);
  if (enabled) {
    const plugin = scanPlugins().find((p) => p.id === pluginId);
    if (!plugin) return { success: false, error: '插件不存在: ' + pluginId };
    if (loaded.has(pluginId)) return { success: true, message: '已启用（原本就加载中）' };
    return loadPlugin(plugin);
  } else {
    if (loaded.has(pluginId)) return unloadPlugin(pluginId);
    return { success: true, message: '已禁用（原本未加载）' };
  }
}

/** 重载插件（先卸载再加载） */
async function reloadPlugin(pluginId) {
  if (loaded.has(pluginId)) unloadPlugin(pluginId);
  const plugin = scanPlugins().find((p) => p.id === pluginId);
  if (!plugin) return { success: false, error: '插件不存在: ' + pluginId };
  if (!plugin.enabled) return { success: false, error: '插件未启用' };
  return loadPlugin(plugin);
}

/** 已加载插件 id 列表 */
function loadedIds() {
  return Array.from(loaded.keys());
}

// ========== 阶段3：热重载（文件监听）==========
let _watchers = [];
let _watchDebounce = null;

/**
 * 监听所有已加载插件目录，文件变化时自动 reload（带 300ms 防抖）。
 * 让"改插件代码不用重启 LingYa"成为现实。
 */
function startWatching() {
  stopWatching();
  for (const [id, rec] of loaded) {
    try {
      const w = fs.watch(rec.dir, { recursive: true }, () => {
        if (_watchDebounce) clearTimeout(_watchDebounce);
        _watchDebounce = setTimeout(() => {
          console.log('[PluginHost] 检测到插件变化，热重载:', id);
          Promise.resolve(reloadPlugin(id)).then((res) => {
            if (res && !res.success) console.warn('[PluginHost] 热重载失败:', id, res.error);
          }).catch(() => {});
          // 变化后重新挂监听（目录可能新增/删除文件）
          setTimeout(startWatching, 100);
        }, 300);
      });
      // 必须捕获 error 事件：目录被删除或锁定时，fs.watch 会触发该事件
      // 如果不处理，会冒泡为 uncaughtException 直接杀死主进程
      w.on('error', (err) => {
        console.warn('[PluginHost] 插件监听异常 (' + id + '):', err.message);
      });
      _watchers.push(w);
    } catch (err) {
      // 某些平台不支持 recursive，退化为非递归
      try {
        const w2 = fs.watch(rec.dir, () => {
          if (_watchDebounce) clearTimeout(_watchDebounce);
          _watchDebounce = setTimeout(() => {
            Promise.resolve(reloadPlugin(id)).catch((e) => console.warn('[PluginHost] 热重载失败:', id, e && e.message));
          }, 300);
        });
        _watchers.push(w2);
      } catch (_) {}
    }
  }
  if (_watchers.length) console.log('[PluginHost] 已监听 ' + _watchers.length + ' 个插件目录（热重载）');
}

function stopWatching() {
  for (const w of _watchers) { try { w.close(); } catch (_) {} }
  _watchers = [];
}

/**
 * 调用插件注册的 IPC handler
 * @param {string} pluginId
 * @param {string} channel
 * @param {*} args
 * @param {object} [event] 原始 IPC event（可选）
 */
async function invokePluginIpc(pluginId, channel, args, event) {
  const full = pluginId + ':' + channel;
  const rec = pluginIpcHandlers.get(full);
  if (!rec) return { success: false, error: '插件通道不存在: ' + full };
  try {
    const data = await rec.handler(args, event);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * 列出所有插件视图（含渲染后的 HTML）
 * @returns {Array<{viewId, pluginId, icon, label, title, html}>}
 */
function listPluginViews() {
  const out = [];
  for (const [viewId, v] of pluginViews) {
    let html = '';
    try {
      html = String(v.render() || '');
    } catch (err) {
      html = '<div class="sh-panel-body" style="color:#f87171;padding:12px;">视图渲染失败: ' + (err.message || err) + '</div>';
    }
    out.push({ viewId, pluginId: v.pluginId, icon: v.icon, label: v.label, title: v.title, html });
  }
  return out;
}

/**
 * 收集所有插件的 preload 脚本
 * @returns {Array<{pluginId, script}>}
 */
function collectPreloadScripts() {
  const out = [];
  for (const [pluginId, arr] of pluginPreloads) {
    for (const script of arr) out.push({ pluginId, script });
  }
  return out;
}

/**
 * 导出插件为 ZIP Buffer
 * @param {string} pluginId
 * @returns {{ success: boolean, data?: Buffer, filename?: string, error?: string }}
 */
function exportPlugin(pluginId) {
  const plugin = scanPlugins().find((p) => p.id === pluginId);
  if (!plugin) return { success: false, error: '插件不存在: ' + pluginId };
  try {
    const buf = pluginZip.zipDir(plugin.dir, pluginId);
    const safeName = String(plugin.name || pluginId).replace(/[\\/:*?"<>|]/g, '_');
    return { success: true, data: buf, filename: safeName + '-' + plugin.version + '.lingya-plugin.zip' };
  } catch (err) {
    return { success: false, error: '打包失败: ' + err.message };
  }
}

/**
 * 从 ZIP Buffer 导入插件（解压到 plugins/<id>/）
 * @param {Buffer} buf
 * @returns {{ success: boolean, id?: string, name?: string, error?: string }}
 */
async function importPlugin(buf) {
  if (!buf || !buf.length) return { success: false, error: '空文件' };
  // 先解压到临时目录，校验 manifest 后再决定最终 id 目录
  const tmpBase = path.join(PLUGINS_DIR, '.import-tmp-' + Date.now());
  let written;
  try {
    written = pluginZip.unzipToDir(buf, tmpBase);
  } catch (err) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: '解压失败: ' + err.message };
  }

  // 定位 manifest.json：可能在根，也可能在一层子目录里
  let root = tmpBase;
  if (!fs.existsSync(path.join(root, 'manifest.json'))) {
    const subs = fs.readdirSync(tmpBase, { withFileTypes: true }).filter((e) => e.isDirectory());
    const hit = subs.find((e) => fs.existsSync(path.join(tmpBase, e.name, 'manifest.json')));
    if (hit) root = path.join(tmpBase, hit.name);
  }
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: '插件包中未找到 manifest.json（文件列表: ' + written.slice(0, 8).join(', ') + '）' };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: 'manifest.json 解析失败: ' + err.message };
  }
  if (!manifest || !manifest.id) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: 'manifest.json 缺少 id 字段' };
  }
  // id 合法性：仅允许字母数字 - _ .
  if (!/^[A-Za-z0-9._-]+$/.test(manifest.id)) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: '插件 id 含非法字符（仅允许字母数字 - _ .）' };
  }

  const destDir = path.join(PLUGINS_DIR, manifest.id);
  const existed = fs.existsSync(destDir);

  // 【关键】覆盖安装前，必须先卸载旧实例。
  // 否则：1) 文件被进程占用，Windows 下 rmSync 会报 EBUSY
  //       2) 稍后 loadPlugin 会因 loaded.has(id) 为 true 直接拒绝加载，导致面板白屏
  if (loaded.has(manifest.id)) {
    unloadPlugin(manifest.id);
  }

  // 【关键】Windows 下 fs.watch 会锁定目录句柄，导致 rmSync 抛出 EPERM/EBUSY。
  // 必须临时关闭监听，操作完成后再恢复。
  stopWatching();

  try {
    if (existed) fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(root, destDir);
    // 若 root 是子目录，清掉外层临时目录
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  } catch (err) {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: '写入插件目录失败: ' + err.message };
  } finally {
    // 恢复监听（此时扫描到的插件目录已经是最新状态）
    startWatching();
  }

  // 默认启用新导入的插件
  pluginStore.setEnabled(manifest.id, true);
  const loadRes = await loadPlugin(scanPlugins().find((p) => p.id === manifest.id));
  return {
    success: true,
    id: manifest.id,
    name: manifest.name || manifest.id,
    overwritten: existed,
    loaded: !!loadRes.success,
    loadError: loadRes.success ? undefined : loadRes.error,
  };
}

/**
 * 删除插件目录（连带卸载）
 *
 * 内置插件（源目录中存在同名目录）走墓碑流程：
 *   - 删目录，写 deleted 标记，**保留 config/enabled/pinned**
 *   - 下次启动播种时跳过，不会复活
 *   - 可通过 restoreBundledPlugins() 一键恢复（配置原样还在）
 *
 * 普通插件维持原行为：删目录 + removeRecord。
 *
 * @param {string} pluginId
 * @returns {{ success: boolean, bundled?: boolean, error?: string }}
 */
function deletePlugin(pluginId) {
  if (loaded.has(pluginId)) unloadPlugin(pluginId);
  const destDir = path.join(PLUGINS_DIR, pluginId);
  const resolved = path.resolve(destDir);
  if (!resolved.startsWith(path.resolve(PLUGINS_DIR) + path.sep)) {
    return { success: false, error: '非法插件 id' };
  }
  const bundled = isBundledId(pluginId);
  // 必须先停止监听，否则 Windows 下文件被锁无法删除
  stopWatching();
  try {
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    if (bundled) {
      pluginStore.markDeleted(pluginId);
    } else {
      pluginStore.removeRecord(pluginId);
    }
    return { success: true, bundled };
  } catch (err) {
    return { success: false, bundled, error: err.message };
  } finally {
    startWatching();
  }
}

/**
 * 恢复全部被删除的内置插件：清墓碑 + 重新播种 + 加载。
 * 源目录不存在时不做任何破坏性操作（不清墓碑），返回失败。
 * @returns {Promise<{ success: boolean, restored?: string[], error?: string }>}
 */
async function restoreBundledPlugins() {
  const srcDir = findBundledSourceDir();
  if (!srcDir) {
    return { success: false, error: '未找到应用内置插件目录' };
  }
  const pending = pluginStore.listDeleted();
  if (!pending.length) {
    return { success: true, restored: [] };
  }
  pluginStore.clearDeleted();
  seedBundledPlugins();
  try {
    await loadAllEnabled();
  } catch (err) {
    console.error('[PluginHost] 恢复后加载插件失败:', err.message);
  }
  return { success: true, restored: pending };
}

/** 测试用：清掉源目录 override，避免影响其他用例 */
function resetBundledSourceOverride() {
  _lastSourceOverride = null;
}

/**
 * 获取所有插件注册的提示词内容。
 * @returns {Object} { placeholder: content }
 */
function getPluginPromptSections() {
  const out = {};
  for (const [placeholder, getter] of pluginPromptSections) {
    try {
      const text = getter();
      if (typeof text === 'string' && text.trim()) {
        out[placeholder] = text;
      }
    } catch (err) {
      console.error('[PluginHost] 提示词段落生成失败 (' + placeholder + '):', err.message);
    }
  }
  return out;
}

module.exports = {
  init,
  getPluginPromptSections,
  getPluginsDir,
  seedBundledPlugins,
  compareVersion,
  scanPlugins,
  loadPlugin,
  unloadPlugin,
  loadAllEnabled,
  listPlugins,
  setPluginEnabled,
  setPluginPinned,
  reloadPlugin,
  loadedIds,
  startWatching,
  stopWatching,
  invokePluginIpc,
  listPluginViews,
  collectPreloadScripts,
  exportPlugin,
  importPlugin,
  deletePlugin,
  restoreBundledPlugins,
  isBundledId,
  findBundledSourceDir,
  resetBundledSourceOverride,
  pluginEvents,
};
