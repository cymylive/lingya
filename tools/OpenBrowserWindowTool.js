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
    // profileId 由 JsRunner 注入（见 tools/JsRunner.js 的 tool.execute({... profileId})），
    // 标识「是哪个窗口发起的这次工具调用」。
    //
    // 【必须传下去】多窗口场景下，若不带 profileId，browser-window-manager 只能用
    // 「最后激活的窗口」猜测归属 —— A 窗口调用工具、用户切到 B 窗口，标签就会开到 B。
    // 这是用户实测反馈的 bug（A 开 5 个标签全跑到 B 的标签栏）。
    const { url, id, width, height, profileId } = params;
    const options = { profileId };
    if (width) options.width = width;
    if (height) options.height = height;
    const windowId = windowManager.openWindow(id || null, url, options);
    return ToolResult.success({ windowId, message: `窗口已打开，ID: ${windowId}，URL: ${url}` });
  }
}

module.exports = { OpenBrowserWindowTool };
