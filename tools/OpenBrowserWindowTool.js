const { Tool, ToolResult } = require('./ToolRegistry');
const windowManager = require('./browser-window-manager');

class OpenBrowserWindowTool extends Tool {
  constructor() {
    super(
      'open_browser_window',
      '打开一个 Electron 浏览器窗口，返回 { windowId, message }，用返回的 windowId 传给 injectJS(windowId, code) 注入 JS 调试',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页 URL' },
          id: { type: 'string', description: '自定义窗口 ID（可选），不提供则自动生成' },
          width: { type: 'number', description: '窗口宽度（像素），默认 1200' },
          height: { type: 'number', description: '窗口高度（像素），默认 800' }
        },
        required: ['url'],
        additionalProperties: false
      },
      'openBrowserWindow(url, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:open_browser_window',
      order: 112,
      text: '使用 openBrowserWindow 打开 Electron 浏览器窗口。返回 windowId，后续用 injectJS(windowId, code) 注入 JS 并获取返回值。可传自定义 id 便于语义化管理。'
    };
  }

  async execute(params) {
    const { url, id, width, height } = params;
    const options = {};
    if (width) options.width = width;
    if (height) options.height = height;
    const windowId = windowManager.openWindow(id || null, url, options);
    return ToolResult.success({ windowId, message: `窗口已打开，ID: ${windowId}，URL: ${url}` });
  }
}

module.exports = { OpenBrowserWindowTool };
