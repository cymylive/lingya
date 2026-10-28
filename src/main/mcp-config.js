/**
 * MCP 配置管理
 *
 * mcp.json 采用主流 Claude Desktop 格式（可直接分享/导入）：
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": [...] },          // stdio
 *     "remote-db":  { "url": "https://..." }                       // http（扩展）
 *   }
 * }
 *
 * 启用/禁用状态单独存 mcp-state.json（不污染主流格式）：
 * { "filesystem": true, "remote-db": false }
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getConfigFile() {
  return path.join(app.getPath('userData'), 'mcp.json');
}

function getStateFile() {
  return path.join(app.getPath('userData'), 'mcp-state.json');
}

function readConfig() {
  try {
    const file = getConfigFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[MCP] 读取配置失败:', err.message);
  }
  return { mcpServers: {} };
}

function writeConfig(config) {
  try {
    const file = getConfigFile();
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[MCP] 配置已保存:', file);
    return true;
  } catch (err) {
    console.error('[MCP] 写入配置失败:', err.message);
    return false;
  }
}

function readState() {
  try {
    const file = getStateFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {}
  return {};
}

function writeState(state) {
  try {
    fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[MCP] 写入状态失败:', err.message);
    return false;
  }
}

/**
 * 把 mcpServers 对象转成数组（带 name / type / enabled），便于 UI 和 client 使用。
 * type 判断：有 url 就是 http，否则 stdio。
 */
function getServers() {
  const config = readConfig();
  const state = readState();
  const servers = [];
  for (const [name, def] of Object.entries(config.mcpServers || {})) {
    servers.push({
      name,
      type: def && def.url ? 'http' : 'stdio',
      command: def && def.command,
      args: def && def.args || [],
      url: def && def.url,
      headers: def && def.headers,
      env: def && def.env,
      enabled: state[name] !== false, // 默认启用
    });
  }
  return servers;
}

function getEnabledServers() {
  return getServers().filter(s => s.enabled);
}

function upsertServer(server) {
  const config = readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const def = {};
  if (server.type === 'http') {
    if (server.url) def.url = server.url;
    if (server.headers) def.headers = server.headers;
  } else {
    if (server.command) def.command = server.command;
    if (server.args && server.args.length) def.args = server.args;
    if (server.env) def.env = server.env;
  }
  config.mcpServers[server.name] = def;
  writeConfig(config);
  return server;
}

function setServerEnabled(name, enabled) {
  const state = readState();
  state[name] = !!enabled;
  writeState(state);
  return true;
}

/**
 * 判断一个已有的 graphify server 配置是否指向「应用自带的 exe」。
 *
 * 区分两种来源，决定是否允许覆盖：
 * - 自带 exe（resources/graphify 或 process.resourcesPath/graphify）→ 这是应用自己注册过的，
 *   若 args 里的 graph.json 路径不对（比如升级前指向了旧位置），应该更新
 * - 其他路径 → 用户自己装的，尊重不动
 */
function isBundledGraphifyCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const norm = cmd.replace(/\\/g, '/').toLowerCase();
  return norm.includes('/graphify/graphify-mcp.exe');
}

/**
 * 注册内置 graphify MCP server（随应用分发，用户无需自行安装）。
 *
 * 行为：
 * - 不存在 graphify server → 直接写入
 * - 已存在且 command 指向自带 exe → 更新 args / env 为当前约定（保留用户的额外字段）
 * - 已存在但 command 指向其他 exe → 视为用户自定义，保留不动
 *
 * 为什么第二种情况要更新：应用升级后 graph.json 的落点可能变化（旧版可能写到
 * 项目内的 graphify-out/，新版统一到 <userData>/graphify/）。若不更新，MCP
 * server 会查着一张过期的旧图，而 AI 完全不知道。
 *
 * @returns {{registered: boolean, updated?: boolean, reason?: string, path?: string}}
 */
function registerBuiltinGraphify() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'graphify', 'graphify-mcp.exe'));
  }
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'graphify', 'graphify-mcp.exe'));
  let exePath = null;
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) { exePath = p; break; } } catch (_) {}
  }
  if (!exePath) return { registered: false, reason: 'graphify-mcp.exe 未找到' };

  const config = readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  // 图谱默认位置：<userData>/graphify/graph.json
  const graphDir = path.join(app.getPath('userData'), 'graphify');
  try { fs.mkdirSync(graphDir, { recursive: true }); } catch (_) {}
  const graphPath = path.join(graphDir, 'graph.json');

  const existing = config.mcpServers.graphify;
  if (existing) {
    if (!isBundledGraphifyCommand(existing.command)) {
      return { registered: false, reason: '已存在用户自定义 graphify server（尊重用户配置）', path: exePath };
    }
    // 自带来源：对齐到当前约定的 args / env，其余字段保留
    const next = {
      ...existing,
      command: exePath,
      args: [graphPath, '--transport', 'stdio'],
      env: {
        ...(existing.env || {}),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    };
    // 无变化就不写盘，减少无谓的配置写入
    const same =
      existing.command === next.command &&
      Array.isArray(existing.args) &&
      existing.args[0] === graphPath &&
      existing.args[1] === '--transport' &&
      existing.args[2] === 'stdio';
    if (same) {
      return { registered: false, updated: false, reason: '配置已是最新', path: exePath };
    }
    config.mcpServers.graphify = next;
    writeConfig(config);
    console.log('[MCP] 已更新内置 graphify server 配置:', exePath);
    return { registered: true, updated: true, path: exePath };
  }

  config.mcpServers.graphify = {
    command: exePath,
    args: [graphPath, '--transport', 'stdio'],
    env: {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  };
  writeConfig(config);
  console.log('[MCP] 已注册内置 graphify server:', exePath);
  return { registered: true, path: exePath };
}


function removeServer(name) {
  const config = readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  delete config.mcpServers[name];
  writeConfig(config);
  const state = readState();
  delete state[name];
  writeState(state);
  return true;
}

module.exports = {
  getConfigFile,
  getStateFile,
  readConfig,
  writeConfig,
  getServers,
  getEnabledServers,
  upsertServer,
  setServerEnabled,
  removeServer,
  registerBuiltinGraphify,
};
