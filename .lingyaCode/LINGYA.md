# LINGYA.md — LingYa 项目说明（供 AI 编码助手阅读）

> 本文件是 LingYa 项目的"地图"，供 AI 助手（LingYa / Claude / 其他编码 Agent）快速理解项目结构、运行机制与开发约定。
> 放在 `.lingyaCode/LINGYA.md`，对应 Claude Code 的 `CLAUDE.md` 惯例。

---

## 一、项目是什么

**LingYa（灵鸦）** 是一个**零 Token 成本**的 AI Agent 桌面端。

工作原理：

1. 用 Electron 把 AI **网页版**（DeepSeek / ChatGPT / Claude）嵌入本地窗口
2. 注入覆盖层（悬浮球 + 面板）和 preload 脚本
3. AI 被系统提示词引导，在回复中生成 ```lingya 代码块（调用 read/write/bash 等工具）
4. preload 拦截回复，解析出代码块，在受限沙箱中执行
5. 把执行结果回传给 AI，AI 继续下一步 → 形成"思考 → 行动 → 观察 → 再行动"的 Agent 循环

**关键特点**：不调用任何 AI 平台 API，不消耗 API Token，直接复用网页版账号。

### 来源与许可（重要）

- 本项目是 [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code) 的 **fork / 二次开发版**
- 许可：**GPL-3.0-only**
- **GPL 硬性要求：可以改品牌，但不能抹掉原作者归属**。以下内容不得删除：
  - `LICENSE` 文件
  - `package.json` 的 `contributors` 字段（标注上游原作者）
  - `README.md` / `README.en.md` 顶部的二次开发声明与上游链接
  - 所有指向 `github.com/wangyongpeng90/cuckoo-code` 的 URL

---

## 二、技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 33 |
| 主进程 | Node.js（CommonJS） |
| 渲染进程 | preload 脚本 + DOM 注入 |
| 沙箱执行 | Node `vm` 模块（禁 eval / Function / require） |
| 打包 | electron-builder 24 |
| 测试 | Node.js 内置 `node --test` |
| 依赖 | @modelcontextprotocol/sdk、@vscode/ripgrep、turndown、mysql2、electron-updater |

---

## 三、目录结构

```text
lingya/
├── main.js                 # 主进程入口（薄壳，转发到 src/main/index.js）
├── preload.js              # Preload 入口（薄壳，转发到 src/preload/index.js）
├── start.js                # 跨平台启动脚本（日志写入 wyp/log/）
├── package.json            # 包定义 + electron-builder 配置
│
├── src/
│   ├── main/               # ===== 主进程（Node 环境，有完整系统权限）=====
│   │   ├── index.js        # 应用入口：窗口创建、IPC 注册、生命周期
│   │   ├── window.js       # 多窗口管理（每个窗口独立 profile 上下文）
│   │   ├── ipc.js          # IPC 处理器（渲染进程 <-> 主进程）
│   │   ├── profile-manager.js  # 窗口 Profile 管理
│   │   ├── project-context.js  # 项目初始化：目录选择 + systemPrompt 组装 + 发送
│   │   ├── session-store.js    # 会话持久化（会话 ID <-> 项目目录映射）
│   │   ├── memory-store.js     # 长期记忆存储（lingya-memory.json）
│   │   ├── skill-store.js      # 技能存储（lingya-skills.json）
│   │   ├── security-store.js   # 安全增强配置（lingya-security.json）
│   │   ├── refusal-rewriter.js # AI 改写服务（OpenAI 兼容接口）
│   │   ├── mcp-config.js       # MCP 配置管理
│   │   ├── mcp-client.js       # MCP SDK 客户端
│   │   ├── tool-registry.js    # 工具注册表（主进程侧）
│   │   ├── dangerous-commands.js  # 危险命令检测
│   │   ├── tray.js             # 系统托盘
│   │   └── updater.js          # 自动更新
│   │
│   ├── preload/            # ===== 渲染进程（注入到 AI 网页，受限权限）=====
│   │   ├── index.js        # Preload 入口：初始化时序
│   │   ├── api.js          # contextBridge API 暴露（window.electronAPI）
│   │   ├── tool-names.js   # 工具名常量
│   │   ├── overlay/        # 覆盖层 UI
│   │   │   ├── template.js     # HTML 模板 + CSS（页签布局 / 墨鸦主题）
│   │   │   ├── ui.js           # 注入、显隐、Toast、状态球、巡检
│   │   │   ├── events.js       # 事件绑定（含页签切换 bindTabEvents）
│   │   │   ├── project-dir.js  # 项目目录区块
│   │   │   ├── memory-panel.js # 记忆管理面板
│   │   │   ├── skill-panel.js  # 技能管理面板
│   │   │   └── security-panel.js  # 安全增强面板
│   │   └── dom/            # DOM 监测与执行
│   │       ├── state.js             # 全局状态
│   │       ├── chat-input.js        # 输入框定位与发送
│   │       ├── intercept-observer.js # 网络拦截模式：解析 AI 回复
│   │       ├── tool-parser.js       # 解析 lingya 代码块
│   │       ├── js-detector.js       # 检测工具调用
│   │       ├── tool-executor.js     # 触发沙箱执行
│   │       ├── refusal-detector.js  # 拒绝检测（两级策略）
│   │       ├── auto-inject.js       # 新会话自动注入记忆+技能
│   │       ├── compaction.js        # 上下文压缩
│   │       └── session-list.js      # 会话列表
│   │
│   ├── prompt/             # ===== 系统提示词模板 =====
│   │   ├── default.md          # 默认模板
│   │   ├── deepseek.md         # DeepSeek 专用
│   │   ├── chatgpt.md          # ChatGPT 专用
│   │   ├── claude.md           # Claude 专用
│   │   └── ctf.md              # CTF 安全增强提示词（可选注入）
│   │
│   ├── providers/          # ===== AI 平台适配 =====
│   │   ├── index.js            # Provider 注册表
│   │   ├── deepseek.js         # DeepSeek 平台定义
│   │   ├── chatgpt.js          # ChatGPT 平台定义
│   │   ├── claude.js           # Claude 平台定义
│   │   └── custom/             # 自定义 Provider（loader + 模板 + d.ts）
│   │
│   └── ui/                 # ===== 应用内页面 =====
│       ├── platform-select.html  # 平台选择页
│       └── logos/                # 平台 logo
│
├── tools/                  # ===== 工具实现（沙箱侧）=====
│   ├── JsRunner.js             # JS 沙箱执行器（vm + hostBridge 桥接）
│   ├── ToolRegistry.js         # 工具注册表
│   ├── lingya-tools.d.ts       # 工具 API 类型声明（注入到 systemPrompt）
│   ├── BashTool.js / PwshTool.js       # 命令执行
│   ├── ReadTool.js / ReadLinesTool.js  # 读取
│   ├── WriteTool.js / FileWriteTool.js # 写入
│   ├── EditTool.js / FileEditTool.js   # 编辑
│   ├── GlobTool.js / GrepTool.js       # 搜索
│   ├── FileDeleteTool.js       # 删除
│   ├── TodoWriteTool.js        # 任务列表
│   ├── WebFetchTool.js / WebSearchTool.js  # 网络
│   ├── MySQLTool.js            # 数据库
│   ├── OpenBrowserWindowTool.js / InjectJSTool.js  # 浏览器
│   ├── McpCallTool.js / McpQueryTools.js   # MCP
│   ├── MemoryTool.js           # 记忆工具
│   └── index.js                # 导出
│
├── test/                   # ===== 单元测试 =====
│   ├── tools/                  # 工具测试
│   ├── main/                   # 主进程测试
│   └── preload/                # preload 测试
│
├── assets/                 # 图标（icon.png / icon.ico / tray-icon.png）
├── logo/                   # 品牌素材（lingya.svg）
├── dist/                   # 构建产物
└── .lingyaCode/LINGYA.md   # 本文件
```

用户数据目录：`%APPDATA%\lingya-ai-pro-session\`
开发日志：`<userData>\wyp\log\`

---

## 四、核心机制

### 1. 工具调用循环

```text
用户提问
  -> AI 回复（含 lingya 代码块）
  -> intercept-observer.js 拦截回复完成事件
  -> tool-parser.js 提取代码块
  -> 通过 IPC 发到主进程 tool-registry
  -> JsRunner.js 在 vm 沙箱执行
  -> 执行结果通过 hostBridge 回传
  -> preload 把结果填回输入框发送给 AI
  -> AI 继续下一步……
```

**两种模式**（由 provider 的 `useIntercept` 决定）：
- **网络拦截模式**（DeepSeek 等）：在主世界 hook fetch/XHR，拿到原始回复
- **DOM 抓取模式**（其他）：MutationObserver 监测页面 DOM 变化

### 2. 提示词组装（project-context.js）

点「初始化项目」时，组装 systemPrompt：

```text
模板（src/prompt/{providerId}.md）
  ├── {{PROJECT_DIR}}       项目路径
  ├── {{DIR_TREE}}          目录树
  ├── {{TOOL_API_TYPES}}    tools/lingya-tools.d.ts 内容
  ├── {{TOOLS_DESCRIPTION}} 工具描述（tool-registry 生成）
  ├── {{PROMPT_SECTIONS}}   工具使用指导
  ├── {{MEMORY_SECTION}}    长期记忆注入块
  ├── {{SKILL_SECTION}}     技能注入块
  ├── {{MCP_SECTION}}       MCP 能力说明
  └── {{CTF_SECTION}}       CTF 提示词（安全增强开关控制）
```

### 3. 长期记忆与技能

- **记忆**：`memory-store.js`，存 `lingya-memory.json`，按 token 预算选择注入
- **技能**：`skill-store.js`，存 `lingya-skills.json`，支持自定义 + 本地文件夹导入（扫 SKILL.md）
- **注入时机**：新会话初始化时（`initProject`）或自动注入（`auto-inject.js`）

### 4. 安全增强 MOD（详见 SECURITY-MOD.md）

移植自 Codex Session Patcher：

- **CTF 提示词注入**：可开关。两种生效方式 —— 自动（初始化时）/ 手动（面板「立即注入当前对话」）
- **拒绝拦截**：检测 AI 回复是否为拒绝（两级检测），命中则自动改写重发
  - 改写模式 1：用当前对话改写（免 API，推荐）
  - 改写模式 2：外部 API 改写（OpenAI 兼容）
- 配置存 `lingya-security.json`，默认全关

### 5. JS 沙箱（tools/JsRunner.js）

- 用 Node `vm.createContext` 创建沙箱
- 禁用 `eval` / `Function` 构造器
- AI 代码无法访问 `require` / `process` / `global`
- 工具函数通过 `__hostBridge` 桥接回主进程执行
- 同步超时 30s（vm timeout），整体 60s（RUN_DEADLINE），输出上限 20000 字符

---

## 五、开发命令

```bash
# 启动（需 PATH 含 D:\NodeJS）
npm start

# 测试（246 个用例）
npm test

# 测试覆盖率
npm run test:coverage

# 本地构建（不发布）
npm run build:win:portable:local    # Windows 便携版 -> dist/lingya-win-v{ver}-portable.exe
npm run build:win:local             # Windows 默认（nsis + portable + zip）
npm run build:mac:local             # macOS
```

### Windows 环境注意

- `node` 在 `D:\NodeJS`，执行前需 `set "PATH=D:\NodeJS;%PATH%"
- PowerShell 执行策略禁止 `npm.ps1`，构建用 `cmd /c npm run ...`
- portable 打包约 3-4 分钟（7za 压缩慢）
- portable exe 解压到 `%TEMP%\<哈希>`，解压中断会残留损坏文件导致启动报错，需删对应 temp 目录重建

---

## 六、开发约定

### 命名

- 品牌：**LingYa** / 灵鸦
- 包名：`lingya`，appId：`com.lingya.lingya`
- 代码块围栏：```lingya（不是 ```cuckoo）
- 内部事件：`lingya-ai-start` / `lingya-ai-response`
- CSS 类名：`.lingya-*`
- localStorage 键：`lingya-*`

### 代码风格

- CommonJS（`require` / `module.exports`），不用 ESM
- 主进程与渲染进程严格分离：preload 不能直接 require Node 模块（除 electron 暴露的）
- 渲染进程调主进程一律通过 `window.electronAPI`（api.js 定义）
- 危险命令（rm -rf / format 等）由 dangerous-commands.js 拦截

### 修改原则

- **外科手术式修改**：最小改动范围，不顺手重构无关代码
- 修改后必须跑 `npm test`，确保 246 用例通过
- 涉及 UI 的改动，元素 **id 保持不变**（events.js / ui.js 依赖 getElementById）

---

## 七、常见坑

1. **模板字符串反引号**：写含三反引号的字符串时，用数组 join 或转义，避免破坏代码块
2. **CSS 数组插入**：在单引号字符串元素里放真实换行会导致语法错误，必须拆成独立数组元素
3. **PowerShell 吞反斜杠**：`"a\\b"` -> `"ab"`，用正斜杠或 Python subprocess
4. **Get-Content 中文乱码**：系统会自动补 `-Encoding UTF8`
5. **electron-builder 排除 *.d.ts**：所以 `lingya-tools.d.ts` 通过 `extraResources` 复制到 `resources/tools/`
6. **用户数据目录**：改了包名后是 `%APPDATA%\lingya-ai-pro-session\`（旧 `cuckoo-ai-pro-session` 待删）

---

## 八、版本信息

- 当前版本：**0.5.1**
- 最新构建：`dist/lingya-win-v0.5.1-portable.exe`
- 仓库：https://github.com/cymylive/lingya （计划）/ https://github.com/cymylive/cuckoo-code-mod （现有）

### 本分支新增（相对上游 cuckoo-code）

1. 品牌改名 LingYa + 墨鸦主题 UI（青碧 #2dd4bf + 墨黑底 + 方形「灵」球）
2. 分页签布局（主页 / 会话 / 日志）+ 2x3 快捷操作网格
3. 安全增强 MOD（CTF 注入 + 拒绝拦截 + AI 改写）
4. CTF 手动注入当前对话
5. 任务停止（面板「停止」+ 悬浮球右键，三层全断）
6. 鸦头主题图标

---

## 九、相关文档

| 文件 | 内容 |
|------|------|
| `README.md` | 项目介绍、功能列表、使用指南 |
| `RENAME-LINGYA.md` | 改名记录 + GPL 合规 + 回滚方式 |
| `SECURITY-MOD.md` | 安全增强 MOD 详细说明 |
| `MOD-INSTALL.md` | 历史 mod 记录 |
| `CHANGELOG.md` | 更新日志 |
| `Roadmap.md` | 路线图 |
| `CONTRIBUTING.md` | 贡献指南 |
