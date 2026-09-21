/**
 * MCP Client 管理
 * 连接/管理多个 MCP server（stdio + HTTP），提供工具列表和调用能力。
 */
const { Client } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');
const { StreamableHTTPClientTransport } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');
const mcpConfig = require('./mcp-config');

// server name -> { client, transport, tools, connected }
const connections = new Map();

async function connectServer(server) {
  if (connections.has(server.name)) {
    return connections.get(server.name);
  }

  let transport;
  if (server.type === 'stdio') {
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      cwd: server.cwd,
      stderr: 'pipe',
    });
  } else if (server.type === 'http') {
    transport = new StreamableHTTPClientTransport(server.url, {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  } else {
    throw new Error('未知 MCP server 类型: ' + server.type);
  }

  const client = new Client({ name: 'lingya', version: '0.2.4' });
  await client.connect(transport);

  let tools = [];
  try {
    const result = await client.listTools({});
    tools = result.tools || [];
  } catch (err) {
    console.error('[MCP] 获取工具列表失败:', server.name, err.message);
  }

  const entry = { client, transport, tools, connected: true };
  connections.set(server.name, entry);
  console.log('[MCP] 已连接:', server.name, '工具数=', tools.length);
  return entry;
}

async function disconnectServer(name) {
  const entry = connections.get(name);
  if (!entry) return;
  try {
    await entry.client.close();
  } catch (_) {}
  connections.delete(name);
  console.log('[MCP] 已断开:', name);
}

async function refreshServerTools(name) {
  const entry = connections.get(name);
  if (!entry) return [];
  try {
    const result = await entry.client.listTools({});
    entry.tools = result.tools || [];
    return entry.tools;
  } catch (err) {
    console.error('[MCP] 刷新工具列表失败:', name, err.message);
    return entry.tools || [];
  }
}

async function connectEnabledServers() {
  const servers = mcpConfig.getEnabledServers();
  for (const server of servers) {
    try {
      await connectServer(server);
    } catch (err) {
      console.error('[MCP] 连接失败:', server.name, err.message);
    }
  }
  return Array.from(connections.keys());
}

async function connectServerByName(name) {
  const server = mcpConfig.getServers().find(s => s.name === name && s.enabled);
  if (!server) throw new Error('MCP server 不存在或未启用: ' + name);
  return connectServer(server);
}

async function disconnectServerByName(name) {
  await disconnectServer(name);
}

async function callMcpTool(serverName, toolName, args) {
  let entry = connections.get(serverName);
  if (!entry) {
    entry = await connectServerByName(serverName);
  }
  const result = await entry.client.callTool({ name: toolName, arguments: args });
  return result;
}

function getConnectedServers() {
  const out = [];
  for (const [name, entry] of connections) {
    out.push({ name, tools: entry.tools, connected: entry.connected });
  }
  return out;
}

function getMcpToolList() {
  const out = [];
  for (const [serverName, entry] of connections) {
    for (const tool of entry.tools) {
      out.push({
        server: serverName,
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
      });
    }
  }
  return out;
}

/**
 * 列出所有已配置的 MCP server（含启用状态和连接状态）
 * @returns {Array<{name, type, enabled, connected, toolCount}>}
 */
function listConfiguredServers() {
  const servers = mcpConfig.getServers();
  return servers.map(s => {
    const entry = connections.get(s.name);
    return {
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      connected: !!(entry && entry.connected),
      toolCount: entry ? entry.tools.length : 0,
    };
  });
}

/**
 * 获取指定 server 的工具列表（按需连接）
 * @param {string} name server 名称
 * @returns {Array<{name, description, inputSchema}>}
 */
async function getToolsByServer(name) {
  let entry = connections.get(name);
  if (!entry) {
    entry = await connectServerByName(name);
  }
  return entry.tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
  }));
}

module.exports = {
  connectServer,
  disconnectServer,
  refreshServerTools,
  connectEnabledServers,
  connectServerByName,
  disconnectServerByName,
  callMcpTool,
  getConnectedServers,
  getMcpToolList,
  listConfiguredServers,
  getToolsByServer,
};
