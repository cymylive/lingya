const { Tool, ToolResult } = require('./ToolRegistry');
const windowManager = require('./browser-window-manager');

class InjectJSTool extends Tool {
  constructor() {
    super(
      'inject_js',
      '向指定窗口注入 JS 代码并返回执行结果（代码自动包装为 async，支持 await 和 return）',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '目标窗口 ID' },
          code: { type: 'string', description: '要注入的 JS 代码（支持 await/return，返回值会返回给 AI）' }
        },
        required: ['windowId', 'code'],
        additionalProperties: false
      },
      'injectJS(windowId, code)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:inject_js',
      order: 113,
      text: '使用 injectJS(windowId, code) 向指定窗口注入 JS。code 支持两种写法：以 return 开头的语句块，或表达式（如 IIFE，其返回值会被捕获）。执行出错会抛出异常。'
    };
  }

  async execute(params) {
    const { windowId, code } = params;
    const result = await windowManager.injectJS(windowId, code);
    return ToolResult.success(result);
  }
}

module.exports = { InjectJSTool };
