const { Tool, ToolResult } = require('./ToolRegistry');

/**
 * MCP 查询工具 - 列出已配置的 MCP server
 */
class McpListServersTool extends Tool {
  constructor() {
    super(
      'mcp_list_servers',
      '列出所有已配置的 MCP server（含启用状态、连接状态和工具数量）',
      {
        type: 'object',
        properties: {},
        required: []
      },
      'mcpListServers()'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:mcp-list',
      order: 119,
      text: 'mcpListServers() 列出已配置的 MCP server（含启用/连接状态）。'
    };
  }

  async execute() {
    try {
      const mcpClient = require('../src/main/mcp-client');
      const servers = mcpClient.listConfiguredServers();
      if (servers.length === 0) {
        return ToolResult.success('当前没有配置任何 MCP server。');
      }
      const allTools = mcpClient.getMcpToolList();
      const lines = [];
      for (const s of servers) {
        const status = !s.enabled ? '禁用' : (s.connected ? '已连接' : '未连接');
        lines.push('- ' + s.name + ' [' + s.type + '] ' + status + '，工具数: ' + s.toolCount);
        if (s.connected) {
          const serverTools = allTools.filter(t => t.server === s.name);
          for (const t of serverTools) {
            lines.push('  - ' + t.name);
          }
        }
      }
      return ToolResult.success(lines.join('\n'));
    } catch (err) {
      return ToolResult.error('获取 MCP server 列表失败: ' + (err.message || String(err)));
    }
  }
}

/**
 * MCP 查询工具 - 查看指定 server 的工具列表
 */
class McpGetToolsTool extends Tool {
  constructor() {
    super(
      'mcp_get_tools',
      '查看指定 MCP server 提供的工具列表（含描述和参数）',
      {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server 名称' }
        },
        required: ['server']
      },
      'mcpGetTools(serverName)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:mcp-get-tools',
      order: 120,
      text: 'mcpGetTools(serverName) 查看指定 MCP server 的工具和参数。'
    };
  }

  async execute(params) {
    const { server } = params;
    if (!server || typeof server !== 'string') {
      return ToolResult.error('server 不能为空');
    }
    try {
      const mcpClient = require('../src/main/mcp-client');
      const tools = await mcpClient.getToolsByServer(server);
      if (tools.length === 0) {
        return ToolResult.success('server "' + server + '" 没有提供任何工具。');
      }
      const lines = tools.map(t => {
        let line = '- **' + t.name + '**' + (t.description ? ' - ' + t.description : '');
        const schema = t.inputSchema && t.inputSchema.properties;
        if (schema && Object.keys(schema).length > 0) {
          const props = Object.entries(schema).map(([k, v]) => {
            return k + ': ' + (v.type || 'any') + (v.description ? ' (' + v.description + ')' : '');
          });
          line += '\n  args: ' + props.join(', ');
        }
        return line;
      });
      return ToolResult.success(server + ' 的工具列表：\n\n' + lines.join('\n'));
    } catch (err) {
      return ToolResult.error('获取 "' + server + '" 的工具列表失败: ' + (err.message || String(err)));
    }
  }
}

module.exports = { McpListServersTool, McpGetToolsTool };
