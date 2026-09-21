# LingYa（灵鸦）

> **本项目是 [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code) 的二次开发版（fork / secondary development），遵循 GPL-3.0-only 许可。**
> 上游原作者与项目归属：Cuckoo Code Contributors — https://github.com/wangyongpeng90/cuckoo-code
> 本分支（[cymylive/lingya](https://github.com/cymylive/lingya)）的改动与发行由 cymylive 维护。

<p align="center">
  <a href="https://github.com/cymylive/lingya/releases/latest"><img src="https://img.shields.io/github/v/release/cymylive/lingya?style=flat-square&color=2dd4bf" alt="Latest Release"></a>
  <a href="https://github.com/cymylive/lingya/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/cymylive/lingya/build.yml?style=flat-square&label=Build" alt="Build Status"></a>
  <a href="https://github.com/cymylive/lingya/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/github/stars/cymylive/lingya?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/cymylive/lingya/releases"><img src="https://img.shields.io/github/downloads/cymylive/lingya/total?style=flat-square&color=green" alt="Downloads"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-2dd4bf?style=flat-square" alt="Platform"></a>
  <a href="https://github.com/cymylive/lingya"><img src="https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
</p>

[English](README.en.md) | 中文

[下载最新版本](https://github.com/cymylive/lingya/releases/latest)

**LingYa（灵鸦）** 是一个零 Token 成本的 AI Agent 桌面端。

它通过 Electron 将 AI 网页版（DeepSeek、ChatGPT、Claude 等）嵌入本地窗口，并注入覆盖层（悬浮球 + 面板）。AI 被系统提示词引导生成工具调用（`lingya` 代码块），在本地沙箱中执行，再把结果回传给 AI。整个过程不需要 API Key，不产生 API 调用费用——你用的是网页版账号，而不是按 Token 计费的接口。

---

## 本分支特性（相对上游 cuckoo-code）

LingYa 在上游基础上做了品牌重塑与功能扩展：

| 特性 | 说明 |
|------|------|
| **品牌重塑** | Cuckoo Code → **LingYa（灵鸦）**，包名 `lingya`，独立数据目录 |
| **墨鸦主题 UI** | 青碧主色 `#2dd4bf` + 墨黑底 + 方形「灵」球，与上游靛蓝紫截然不同 |
| **分页签布局** | 主页 / 会话 / 日志三页签 + 2×3 快捷操作网格，取代单列长滚动 |
| **安全增强 MOD** | 移植 Codex Session Patcher：CTF 提示词注入 + 拒绝拦截 + AI 改写 |
| **任务停止** | 面板「停止」按钮 + 悬浮球右键，三层全断（AI 生成 / 工具执行 / 自动循环） |
| **鸦头图标** | 全新设计的品牌图标（icon / tray / logo） |

安全增强 MOD 详见 [SECURITY-MOD.md](SECURITY-MOD.md)，改名记录见 [RENAME-LINGYA.md](RENAME-LINGYA.md)。

---

## 核心特性

### 零 Token 成本

不调用任何 AI 平台 API，不使用 API Token。直接复用网页版聊天能力，把网页版 AI 变成可执行本地操作的 Agent。

### 多平台 Provider 框架

- 内置 **DeepSeek**、**ChatGPT**、**Claude** 三个平台
- 每个平台独立封装输入框定位、发送按钮检测、回复完成判断、消息解析等差异
- 新建窗口时可选择平台，也可**导入自定义 Provider**（提供类型声明和模板，降低扩展门槛）

### 真正的 AI Agent

不只是聊天。AI 可以读写文件、搜索代码、执行命令、查询数据库、调用 MCP 工具，并依据执行结果继续下一步，形成"思考 → 行动 → 观察 → 再行动"的 Agent 循环。

---

## 主要功能

- **多窗口管理**：每个窗口独立 Profile 上下文，互不干扰
- **项目初始化**：选择项目目录后，AI 获得目录树和系统提示词，操作基于真实项目上下文
- **工具调用系统**：AI 可调用读写文件、搜索代码、执行命令、查询数据库等工具
- **命令拦截**：自动检测 cmd / powershell / bash 代码块，确认后执行
- **MCP 支持**：采用 Claude Desktop 兼容格式配置，支持 stdio / http 类型 server
- **覆盖层面板**：显示命令预览、执行结果和历史记录，支持 Ctrl+Shift+C 或 Esc 切换
- **长期记忆与技能**：跨会话记忆注入 + 技能库（支持本地文件夹导入 SKILL.md）
- **自动重试**：JS 代码执行失败且疑似代码不完整时，自动等待 1 秒重新获取并重试（最多 3 次）
- **会话持久化**：登录状态和设置保存到 `%APPDATA%/lingya-ai-pro-session`
- **安全机制**：30 秒命令超时、60 秒沙箱超时、1MB 输出缓冲区、危险命令确认

---

## 安装与运行

### 环境要求

- Node.js >= 16.0.0
- npm

### 步骤

```bash
# 克隆仓库
git clone https://github.com/cymylive/lingya.git
cd lingya

# 安装依赖
npm install

# 如果 npm 提示 electron postinstall 脚本被阻止（allowScripts），先批准：
#   npm install-scripts ls
#   npm install-scripts approve electron
#   npm install
# 否则 electron 二进制不会下载，启动会报错

# 启动应用
npm start
```

### 直接下载

Windows 便携版：见 [Releases](https://github.com/cymylive/lingya/releases)。

---

## 使用指南

1. 启动应用，选择平台（DeepSeek / ChatGPT / Claude / 自定义 Provider）
2. 正常登录对应平台的网页版账号
3. 点击「初始化项目」选择项目目录，AI 会获得目录树和系统提示词
4. 与 AI 对话，让它帮你修改文件、运行命令、查询代码等
5. AI 回复中的工具调用会被自动检测并执行
6. 执行结果自动回传 AI，AI 继续下一步，直到任务完成

### 工具调用示例

AI 回复中包含以下格式的 `lingya` 代码块时，系统会在沙箱中执行，并把结果回传给 AI：

````markdown
```lingya
const content = await read("src/utils/helper.js");
await write("src/utils/helper.js", content.replace("formatDate", "formatTime"));
```
````

---

## 工具系统

支持的工具（通过 `lingya` 代码块调用）：

| JS 函数 | 功能描述 |
|----------|----------|
| `read(path, options?)` | 读取文本文件（带行号窗口） |
| `readLines(path, options?)` | 读取文件为结构化行数组 |
| `write(path, content)` | 创建或覆盖文件 |
| `edit(path, old, new, replaceAll?, dryRun?)` | 精确替换文件内容 |
| `glob(pattern, searchPath?)` | 按 glob 模式查找文件 |
| `grep(pattern, options?)` | 正则搜索文件内容 |
| `bash(command, options?)` | 执行 shell 命令（cmd） |
| `pwsh(command, options?)` | 执行 PowerShell 命令 |
| `todoWrite(todos)` | 管理结构化任务列表 |
| `deleteFile(path)` | 删除文件（不可恢复） |
| `webFetch(url)` | 获取 HTTP(S) URL 内容（HTML 转 Markdown） |
| `webSearch(query, opts)` | 联网搜索 |
| `mysql(options)` | 执行 MySQL SQL |
| `openBrowserWindow(url, options?)` | 打开 Electron 浏览器窗口 |
| `injectJS(windowId, code)` | 向指定窗口注入 JS |
| `mcpListServers()` | 列出已配置的 MCP server |
| `mcpGetTools(serverName)` | 查看 MCP server 工具列表 |
| `mcpCall(server, tool, args)` | 调用 MCP 工具 |
| `log(...args)` | 输出中间结果到执行日志 |

所有文件操作均相对于当前绑定的项目目录，确保安全。

---

## 安全增强 MOD

移植自 [Codex Session Patcher](https://github.com/cymylive/codex-session-patcher)，默认全部关闭，不影响原有行为。

- **CTF 提示词注入**：可开关。两种生效方式 —— 自动（初始化项目时注入 systemPrompt）/ 手动（面板「立即注入当前对话」，任意会话可用）
- **拒绝拦截**：检测 AI 回复是否为拒绝（两级检测：强短语全文 + 弱关键词开头 150 字），命中则自动改写重发
  - 改写模式 1：**用当前对话改写**（免 API，推荐）
  - 改写模式 2：外部 API 改写（OpenAI 兼容接口）
- **重试保护**：同一轮连续拒绝最多 3 次（60 秒窗口），避免无限循环

配置存 `lingya-security.json`。详见 [SECURITY-MOD.md](SECURITY-MOD.md)。

---

## MCP 配置

MCP 配置采用 **Claude Desktop 兼容格式**（可直接分享/导入）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/my-project"]
    }
  }
}
```

支持 stdio（command + args）和 http（url + headers）两种类型。启用/禁用状态单独存储，不污染主配置。通过覆盖层的「MCP」按钮打开管理面板。

---

## 自定义 Provider

想要接入新的 AI 平台？复制 `src/providers/custom/provider.template.js`，按模板填写：

- `id` / `name` / `homeUrl` 等基本信息
- 输入框、发送按钮的选择器
- `matchesUrl()`、`extractSessionId()` 等方法
- 自动解析相关方法（完成检测、消息定位等）

类型声明见 `src/providers/custom/provider.d.ts`。在应用内通过平台选择页导入 JS 文件即可使用。

---

## 项目结构

```text
lingya/
├── main.js                 # Electron 主进程入口（薄壳，转发到 src/main/）
├── preload.js              # Preload 入口（薄壳，转发到 src/preload/）
├── start.js                # 跨平台启动脚本（日志写入 wyp/log/）
├── src/
│   ├── main/               # 主进程逻辑
│   │   ├── index.js        # 应用入口、窗口创建、IPC 注册
│   │   ├── window.js       # 多窗口管理（每窗口 profile 上下文）
│   │   ├── ipc.js          # IPC 处理器
│   │   ├── project-context.js  # 项目初始化、目录树、systemPrompt 组装
│   │   ├── session-store.js    # 会话持久化
│   │   ├── memory-store.js     # 长期记忆存储
│   │   ├── skill-store.js      # 技能存储
│   │   ├── security-store.js   # 安全增强配置
│   │   ├── refusal-rewriter.js # AI 改写服务
│   │   ├── mcp-config.js       # MCP 配置管理
│   │   ├── mcp-client.js       # MCP SDK 客户端
│   │   ├── tool-registry.js    # 工具注册（主进程侧）
│   │   ├── dangerous-commands.js  # 危险命令检测
│   │   └── updater.js          # 自动更新
│   ├── preload/            # 渲染进程逻辑
│   │   ├── index.js        # Preload 入口
│   │   ├── api.js          # contextBridge API 暴露
│   │   ├── overlay/        # 覆盖层 UI（模板、事件、样式、各管理面板）
│   │   └── dom/            # DOM 监测、解析、执行、拒绝检测
│   ├── prompt/             # 系统提示词模板（含 ctf.md）
│   └── providers/          # 平台 Provider
│       ├── deepseek.js     # DeepSeek 平台定义
│       ├── chatgpt.js      # ChatGPT 平台定义
│       ├── claude.js       # Claude 平台定义
│       └── custom/         # 自定义 Provider 加载器和模板
├── tools/                  # 工具实现
│   ├── ToolRegistry.js     # 工具注册表
│   ├── JsRunner.js         # JS 沙箱执行器
│   ├── lingya-tools.d.ts   # 工具 API 类型声明
│   └── *.js                # 各工具实现
├── test/                   # 单元测试（246 用例）
├── assets/                 # 图标
├── .lingyaCode/            # AI 助手项目说明（LINGYA.md）
└── dist/                   # 构建产物
```

---

## 构建与发布

- 本仓库已配置 GitHub Actions，推送 `v*` 标签会自动构建 Windows 和 macOS 安装包并发布到 Releases
- 本地手动构建： `npm run build:win:portable:local` 或 `npm run build:mac:local`
- 构建产物输出到 `dist/` 目录

---

## Roadmap

下一阶段计划见 [Roadmap.md](Roadmap.md)。

---

## 贡献

欢迎提交 Issue 和 Pull Request。

- 报告 Bug 或建议新功能：Issues
- 提交代码：Pull Requests

---

## 许可证

本项目使用 GNU General Public License v3.0 许可证。详见 LICENSE 文件。

本项目是 cuckoo-code 的二次开发版，遵循 GPL-3.0-only。**上游原作者归属信息（LICENSE、contributors、上游链接）依法保留，不得移除。**

---

## 致谢

- 上游项目 [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code) 及全体 Cuckoo Code Contributors
- [Codex Session Patcher](https://github.com/cymylive/codex-session-patcher)：安全增强 MOD 的能力来源
- DeepSeek、ChatGPT、Claude 提供强大的 AI 能力
- Electron 提供跨平台桌面框架
- [@27584](https://github.com/27584)：Provider 发送扩展接口、流式稳定性双通道、自定义 Provider 渲染进程加载、MCP 工具识别等框架级改进（PR #9）
- 所有贡献者和用户
