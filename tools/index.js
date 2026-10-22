/**
 * 工具库统一入口
 * 导出所有可用工具（主进程注册工具的唯一入口，与 src/main/tool-registry.js 配套）
 */
const { ToolRegistry } = require('./ToolRegistry');
const { JsRunner } = require('./JsRunner');
const { FileWriteTool } = require('./FileWriteTool');
const { WriteTool } = require('./WriteTool');
const { FileReadTool } = require('./FileReadTool');
const { ReadTool } = require('./ReadTool');
const { ReadLinesTool } = require('./ReadLinesTool');
const { FileEditTool } = require('./FileEditTool');
const { EditTool } = require('./EditTool');
const { GlobTool } = require('./GlobTool');
const { GlobToolNew } = require('./GlobToolNew');
const { GrepTool } = require('./GrepTool');
const { GrepToolNew } = require('./GrepToolNew');
const { TodoWriteTool } = require('./TodoWriteTool');
const { BashTool } = require('./BashTool');
const { PwshTool } = require('./PwshTool');
const { FileDeleteTool } = require('./FileDeleteTool');
const { WebFetchTool } = require('./WebFetchTool');
const { MySQLTool } = require('./MySQLTool');
const { OpenBrowserWindowTool } = require('./OpenBrowserWindowTool');
const { InjectJSTool } = require('./InjectJSTool');
const { McpCallTool } = require('./McpCallTool');
const { McpListServersTool, McpGetToolsTool } = require('./McpQueryTools');
const { MemorySaveTool, MemoryUpdateTool, MemoryDeleteTool, MemoryListTool } = require('./MemoryTool');
const { WebSearchTool } = require('./WebSearchTool');
const { ViewImageTool } = require('./ViewImageTool');
const { BashBackgroundTool, BashOutputTool, BashKillTool } = require('./BackgroundTaskTool');
const { NameConversationTool } = require('./NameConversationTool');
const { ListPluginsTool } = require('./ListPluginsTool');
const { PurgeTool } = require('./PurgeTool');

// 创建全局工具注册表
const registry = new ToolRegistry();

// 注册所有工具
// 只注册新版工具。旧版（file_write / file_read / file_edit / file_glob / file_grep）
// 仍保留类文件供历史测试使用，但不再注册进 registry：
//   - AI 看到的工具描述减半，没有选择困惑
//   - 新旧实现有差异（GlobTool 自己遍历 vs GlobToolNew 用 ripgrep），只留一套避免行为不一致
registry.register(new WriteTool());
registry.register(new ReadTool());
registry.register(new ReadLinesTool());
registry.register(new EditTool());
registry.register(new GlobToolNew());
registry.register(new GrepToolNew());
registry.register(new TodoWriteTool());
registry.register(new BashTool());
registry.register(new PwshTool());
registry.register(new FileDeleteTool());
registry.register(new WebFetchTool());
registry.register(new MySQLTool());
registry.register(new OpenBrowserWindowTool());
registry.register(new InjectJSTool());
registry.register(new McpCallTool());
registry.register(new McpListServersTool());
registry.register(new McpGetToolsTool());
registry.register(new MemorySaveTool());
registry.register(new MemoryUpdateTool());
registry.register(new MemoryDeleteTool());
registry.register(new MemoryListTool());
registry.register(new WebSearchTool());
registry.register(new ViewImageTool());
registry.register(new BashBackgroundTool());
registry.register(new BashOutputTool());
registry.register(new BashKillTool());
registry.register(new NameConversationTool());
registry.register(new ListPluginsTool());
registry.register(new PurgeTool());

// 导出
module.exports = {
  ToolRegistry,
  JsRunner,
  registry,
  FileWriteTool,
  WriteTool,
  FileReadTool,
  ReadLinesTool,
  FileEditTool,
  EditTool,
  GlobTool,
  GlobToolNew,
  GrepTool,
  GrepToolNew,
  TodoWriteTool,
  BashTool,
  PwshTool,
  FileDeleteTool,
  WebFetchTool,
  MemorySaveTool,
  MemoryUpdateTool,
  MemoryDeleteTool,
  MemoryListTool,
  WebSearchTool,
  ViewImageTool,
  BashBackgroundTool,
  BashOutputTool,
  BashKillTool,
  NameConversationTool,
  ListPluginsTool,
  PurgeTool,
  // 便捷方法
  getAllTools: () => registry,
  getToolDescriptions: () => registry.getDescriptions(),
  getFormattedToolsForPrompt: () => registry.getFormattedToolsForPrompt(),
  executeTool: (name, params) => registry.execute(name, params)
};
