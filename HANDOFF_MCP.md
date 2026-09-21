# MCP 功能开发交接文档

## 当前状态

- **分支**：`feature/mcp-20260831`
- **最新提交**：`693bd61 feat: MCP 保存后自动发送工具信息，移除独立发送按钮修复循环发送`
- **工作区**：干净
- **MCP SDK 版本**：`@modelcontextprotocol/sdk@1.30.0`（已安装）

## 已完成内容

### 1. MCP 配置管理（src/main/mcp-config.js）
- 采用**主流 Claude Desktop 格式**：`{ "mcpServers": { "name": { "command": "npx", "args": [...] } } }`
- 启用状态单独存 `mcp-state.json`，不污染主配置
- 支持 stdio（command+args）和 http（url+headers）两种类型，自动判断（有 url 就是 http）

### 2. MCP Client（src/main/mcp-client.js）
- 基于官方 SDK（不是自己实现协议）
- 连接 stdio/HTTP server、拉取工具列表、调用工具
- 懒加载：AI 调用 mcpCall 时若未连接会自动连

### 3. mcpCall 工具（tools/McpCallTool.js）
- 注册为 `mcp_call` 工具，AI 用 `mcpCall(server, tool, args)` 调用
- 返回结果已优化：提取纯文本、错误友好化（带 server.tool 前缀）

### 4. MCP UI（覆盖层）
- 覆盖层有「MCP」按钮，打开左右布局面板
- 左侧：server 列表（名字 + 状态圆点，绿=已连、黄=未连、灰=禁用）
- 右侧：大 JSON 编辑框（完整 mcpServers 格式）+ 保存按钮
- 点击左侧列表项 = 连接/断开切换
- 保存配置后**自动发送一次** MCP 工具信息给 AI

### 5. 提示词注入（src/main/project-context.js）
- 初始化项目时注入「MCP 能力」章节
- 有连接的工具则列出具体工具名和参数，没有则引导用户配置

### 6. 关键 bug 修复
- **循环发送**：之前「发送 MCP 信息」按钮被反复触发导致不停向输入框填内容。已移除按钮，改为保存后自动发一次
- **eventsBound 防重复绑定**：SPA 导航/preload 重载时避免事件重复绑定

## 未完成/待办

### 1. AI 调用 mcpCall 完整闭环（最高优先级）
- **待验证**：让 AI 实际调用 `mcpCall("everything", "echo", {...})`，确认全链路正常
- **测试步骤**：连接 everything → 初始化项目 → 发消息让 AI 调 echo

### 2. http 类型 server 测试
- stdio 已验证（everything 连接成功）
- http 类型还没实际测过（需要一个远程 MCP server）

### 3. 可能的优化
- MCP 工具调用结果的展示格式
- 连接失败时的错误提示更友好
- 配置文件打开入口（方便用户直接编辑）

## 关键技术要点

1. **SDK require 路径**（重要！）
   - SDK 是 ESM 包，不能用包名 require
   - 必须用完整路径：`require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js')`
   - stdio: `.../client/stdio.js`，http: `.../client/streamableHttp.js`

2. **MCP server 包名**
   - 已验证存在：`@modelcontextprotocol/server-everything`、`@modelcontextprotocol/server-filesystem`
   - **不存在**：`@modelcontextprotocol/server-time`（之前测试踩坑）

3. **配置格式**
   - 主配置 `mcp.json`：主流格式，可直接分享
   - 状态 `mcp-state.json`：只存启用/禁用，不污染主流格式

## 测试用配置

### everything（官方测试 server，13 个工具）
```json
{ "mcpServers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } }
```

### filesystem（实用，读写本地文件）
```json
{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/d/SourceCode/2026/lingya"] } } }
```

## 当前 MCP 配置状态

用户数据目录 `%APPDATA%/lingya-ai-pro-session/` 下有：
- `mcp.json`：已配置 everything
- `mcp-state.json`：everything 已启用

## 其他未提交的分支

- `feature/multi-provider-handler-20260831`：多平台 Provider 框架（DeepSeek + Claude），已提交但未合并到 master
- master 已发布 v0.2.4

## 下一步建议

1. 先完成 AI 调用 mcpCall 的完整闭环验证
2. 测试 filesystem server（更实用的场景）
3. 考虑 http 类型测试
4. 完成后合并到 master
