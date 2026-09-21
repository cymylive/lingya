/**
 * 工具注册表与 JS 脚本执行器
 * 由原 main.js 拆分而来；工具注册统一走 tools/index.js（单一注册入口）。
 */
const { registry, JsRunner } = require('../../tools');

// 创建工具注册表并注册工具（tools/index.js 已注册全部内置工具）
const toolRegistry = registry;

// JS 工具脚本执行器（AI 生成 JS 代码调用工具函数）
const jsRunner = new JsRunner(toolRegistry);

module.exports = { toolRegistry, jsRunner };
