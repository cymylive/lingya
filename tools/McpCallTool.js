const { Tool, ToolResult } = require('./ToolRegistry');

/**
 * MCP 调用工具 - 让 AI 通过 mcpCall 调用外部 MCP server 的工具。
 */
class McpCallTool extends Tool {
  constructor() {
    super(
      'mcp_call',
      '调用 MCP server 提供的工具。传入 server 名称、工具名和参数。',
      {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server 名称' },
          tool: { type: 'string', description: '要调用的工具名' },
          args: { type: 'object', description: '工具参数对象' }
        },
        required: ['server', 'tool'],
        additionalProperties: false
      },
      'mcpCall(server, tool, args)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:mcp',
      order: 118,
      text: '调用 MCP 工具时使用 mcpCall(server, tool, args)。使用前先通过 mcpListServers() 和 mcpGetTools() 查询可用能力。'
    };
  }

  async execute(params) {
    const { server, tool, args } = params;
    try {
      if (!server || typeof server !== 'string') {
        return ToolResult.error('server 不能为空');
      }
      if (!tool || typeof tool !== 'string') {
        return ToolResult.error('tool 不能为空');
      }
      const mcpClient = require('../src/main/mcp-client');
      const result = await mcpClient.callMcpTool(server, tool, args || {});

      // 提取纯文本内容
      const content = result.content || [];
      let text = '';
      let hasNonText = false;
      for (const item of content) {
        if (item && item.type === 'text' && typeof item.text === 'string') {
          text += (text ? '\n' : '') + item.text;
        } else if (item) {
          hasNonText = true;
        }
      }

      if (result.isError) {
        // 错误友好化：把错误信息作为失败返回
        const errText = text || 'MCP 工具返回错误';
        return ToolResult.error(server + '.' + tool + ': ' + errText);
      }

      // 成功：返回纯文本，若有非文本内容则附带提示
      return ToolResult.success(text);
    } catch (err) {
      return ToolResult.error('MCP 调用失败: ' + (err.message || String(err)));
    }
  }
}

module.exports = { McpCallTool };
