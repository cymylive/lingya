# 灵鸦（LINGYA）项目地图 — 0.6.194 全量扫描

> 扫描时间：2026-11-05
> 版本：package.json 声明 0.6.194
> 方式：全量静态扫描（目录树 + 文件行数 + 头部注释 + 注册表 + 测试对照 + 数据目录）
> 本文件是「当前状态快照」，替代已过时的 .lingyaCode/LINGYA.md 中的规模数据

---

## 一、总览

| 指标 | 数值 |
|---|---|
| 版本 | 0.6.194 |
| 许可 | GPL-3.0-only |
| 源码总行数（不含 prompt） | **67,344 行** |
| 源码总行数（含 prompt） | 约 76,154 行 |
| 文件总数（src + tools + test） | 约 342 个 .js 文件 |
| 测试用例 | 1272（1271 通过，1 个已知失败） |
| 注册工具数 | 39 |

---

## 二、分层规模

| 层 | 文件 | 行数 | 大小 | 最大单文件 |
|---|---:|---:|---:|---|
| `src/main` | 79 | 20,827 | 788 KB | `index.js` 2,744 行 |
| `src/preload` | 70 | 23,209 | 1,084 KB | `shell-render.js` 5,329 行 |
| `src/providers` | 7 | 1,957 | 70 KB | `deepseek.js` 559 行 |
| `tools` | 43 | 6,798 | 252 KB | `JsRunner.js` 673 行 |
| `test` | 143 | 14,553 | 552 KB | — |
| `src/prompt` | 59 (md) | 8,810 | — | — |

---

## 三、主进程 src/main（79 文件）

### 3.1 入口与窗口

| 文件 | 行数 | 职责 |
|---|---:|---|
| `index.js` | 2,744 | 应用入口：窗口创建、生命周期、全局异常保护安装 |
| `window.js` | 277 | 多窗口管理（每窗口独立 profile 上下文） |
| `tab-manager.js` | 249 | 标签页管理（窗口内多 WebContentsView） |
| `profile-manager.js` | 299 | Profile 隔离（每 profile 独立 partition） |
| `window-merge.js` | 84 | 窗口合并业务规则（纯逻辑） |
| `split-layout.js` | 83 | 分屏布局计算（纯函数） |
| `dropdown-window.js` | 144 | 下拉浮层窗口 |
| `overflow-window.js` | 132 | 状态栏溢出浮层 |

### 3.2 IPC 与安全

| 文件 | 行数 | 职责 |
|---|---:|---|
| `ipc.js` | 2,397 | **最大 IPC 文件**：全部 handler 注册，含 execute-tool / execute-js / execute-command 三条工具通道 |
| `ipc-guard.js` | 108 | IPC 来源校验（审计 P0） |
| `global-guard.js` | 126 | 主进程全局异常保护（uncaughtException / unhandledRejection） |
| `dangerous-commands.js` | 16 | 危险命令检测入口（转发到 tools） |

### 3.3 工具链路

| 文件 | 行数 | 职责 |
|---|---:|---|
| `tool-registry.js` | 14 | 薄壳：require tools/index.js 的 registry + JsRunner |
| `activity-tracker.js` | 68 | 工具活动追踪（按会话隔离） |
| `generation-state.js` | 68 | AI 生成状态追踪 |
| `task-status.js` | 70 | 跨窗口任务状态推导（纯函数） |
| `round-collector.js` | 164 | 一轮任务里 AI 回复与工具调用流水的聚合 |

### 3.4 存储层

| 文件 | 行数 | 职责 |
|---|---:|---|
| `session-store.js` | 510 | 会话↔目录映射（每 profile 独立） |
| `memory-store.js` | 684 | 长期记忆存储（v2 数据模型：scope/kind/confidence） |
| `skill-store.js` | 636 | 技能存储（含本地 SKILL.md 导入） |
| `redaction-store.js` | 582 | **脱敏映射存储**（出站/入站双向替换） |
| `plugin-store.js` | 212 | 插件启用状态 |
| `preset-store.js` | 160 | 分屏布局预设 |
| `prompt-template-store.js` | 272 | 初始化提示词模板草稿 |
| `security-store.js` | 163 | 安全增强配置（CTF + Purge） |
| `agent-store.js` | 89 | Agent 模式状态（build/plan，per-profile） |
| `schedule-store.js` | 122 | 定时任务存储 |
| `conversation-archive.js` | 126 | 会话存档（jsonl） |

### 3.5 平台与通道

| 文件 | 行数 | 职责 |
|---|---:|---|
| `feishu-ipc.js` | 623 | 飞书同步 IPC |
| `weixin-ipc.js` | 444 | 微信 iLink IPC |
| `qq-ipc.js` | 390 | QQ 通道 IPC |
| `channel-commands.js` | 265 | 通道通用指令 /help /new /list /say /stop |
| `channel-panel.js` | 164 | 通道通用面板格式化 |
| `media-ipc.js` | 105 | 媒体收件箱配置 |
| `media/` | 5 文件 | 媒体收发（inbox / outbox / registry / config / index） |

### 3.6 DSH 兼容层（15 文件，约 1,800 行）

`dsh/` 目录：plugin-loader / runtime / shim / installer / market / market-zh / paths / plugin-storage / state / agent-runtime / event-bridge / fs-service / skills-service / web-service / prompt-sections / index

职责：兼容 Cordis/dsh 插件生态（CommonJS 版），支持本地插件 + 市场插件。

### 3.7 其他

| 文件 | 行数 | 职责 |
|---|---:|---|
| `project-context.js` | 816 | 项目初始化（目录选择 + 提示词组装 + 发送） |
| `cdp-capture.js` | 472 | CDP 网络捕获（替代页面 hook fetch） |
| `cdp-wiring.js` | 113 | CDP 事件接线到隔离世界 |
| `token-rotation.js` | 467 | 跨窗口 Token 轮转 |
| `plugin-host.js` | 996 | 轻量插件宿主（4 个核心思想） |
| `mcp-config.js` / `mcp-client.js` | 245 / 177 | MCP 配置与连接 |
| `user-agent.js` | 218 | UA + Client Hints + 反检测补丁 |
| `file-tree.js` | 91 | 只读文件树 |
| `data-dir.js` | 211 | 数据目录解析（便携优先） |
| `updater.js` | 267 | 自动更新 |
| `tray.js` | 230 | 系统托盘 |
| `scheduler.js` / `schedule-ipc.js` / `cron.js` | 56 / 254 / 78 | 定时任务 |
| `graphify-builder.js` | 243 | 代码知识图谱构建 |
| `workspace-aggregator.js` | 103 | 跨窗口工作区聚合 |
| `memory-redact.js` | 77 | 记忆出口脱敏规则 |
| `core-rule-fallback.js` | 38 | 核心规则占位符兜底 |
| `pet-loader.js` | 180 | 外部宠物加载器 |
| `plugin-zip.js` | 187 | 最小 ZIP 读写（零依赖） |

---

## 四、注入层 src/preload（70 文件）

### 4.1 入口与 API 暴露

| 文件 | 行数 | 职责 |
|---|---:|---|
| `index.js` | 439 | Preload 入口：初始化时序（指纹修复 → UI 注入 → 各模块启动） |
| `preload-api.js` | 573 | contextBridge 暴露的 electronAPI |
| `plugin-api.js` | 130 | 本地插件运行时 API |
| `shell-preload.js` | 256 | 壳页面 preload（左侧栏） |
| `harness-preload.js` | 89 | Harness 模式 preload |
| `harness-bridge.js` | 323 | Harness 模式 bridge |
| `dropdown-preload.js` | 21 | 下拉浮层极简 IPC 桥 |

### 4.2 DOM 层（35 文件，核心链路）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `send-input.js` | 1,649 | **输入框交互**：查找、填入（CDP trustedInsertText）、发送、工具结果回传 |
| `intercept.js` | 1,118 | 拦截模式回复处理（监听 lingya-ai-response 事件） |
| `deepseek-history-archiver.js` | 705 | DeepSeek 侧栏对话归档注入 |
| `tool-executor.js` | 361 | 工具/JS 执行器（拦截 + DOM 模式共用） |
| `conversation-log.js` | 337 | 会话记录 + 导出 Markdown |
| `task-state.js` | 335 | **任务状态机（单一真相源）** |
| `auto-inject.js` | 289 | 新会话自动注入记忆+技能 |
| `compaction.js` | 288 | 手动压缩上下文 |
| `page-title-sync.js` | 272 | 会话标题同步到页面标题 |
| `rate-limit-retry.js` | 255 | 失败自动重试引擎 |
| `session-list.js` | 241 | 会话列表渲染与导航 |
| `file-upload.js` | 208 | 长文本转 .md 附件上传 |
| `tool-parser.js` | 193 | 工具调用宽容 JSON 解析 |
| `js-detector.js` | 181 | JS 工具脚本检测 |
| `auto-rename.js` | 170 | 自动 AI 重命名会话 |
| `idempotency.js` | 152 | 工具调用幂等键 |
| `cdp-bridge.js` | 151 | CDP 桥（隔离世界侧） |
| `state.js` | 149 | preload 全局共享状态 |
| `feishu-bridge.js` | 146 | 飞书 bridge |
| `qq-bridge.js` | 144 | QQ bridge |
| `dom-unredact.js` | 143 | **DOM 占位符还原**（2026-11-05 新增） |
| `weixin-bridge.js` | 138 | 微信 bridge |
| `send-merge.js` | 137 | 自动消息合并缓冲 |
| `dom-fallback.js` | 114 | DOM 兜底探测（hook 失效时） |
| `redaction-filter.js` | 102 | **preload 侧脱敏引擎**（redactText + unredactText） |
| `schedule-bridge.js` | 90 | 定时任务 bridge |
| `initial-prompt-guard.js` | 85 | 初始提示词接收端守卫 |
| `tps-meter.js` | 85 | TPS 测速器 |
| `export-filename.js` / `export-source.js` | 64 / 64 | 导出文件名与数据源 |
| `xml-detect.js` | 55 | XML/DSML 格式工具调用检测 |
| `intercept-preempt.js` | 47 | 工具调用抢占 |
| `timeout.js` | 45 | Promise 超时包装 |
| `evt-names.js` | 44 | 事件名混淆器（每会话随机后缀） |
| `upload-hint.js` | 22 | 上传引导语生成 |

### 4.3 覆盖层 overlay（20 文件）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `events.js` | 1,373 | 覆盖层按钮事件绑定 |
| `template.js` | 1,280 | UI 模板（HTML + CSS） |
| `ui.js` | 891 | 基础能力：注入、提示、历史、徽章、巡检 |
| `plan-panel.js` | 546 | 计划（todoWrite）面板 |
| `file-tree-panel.js` | 340 | 项目文件树 UI |
| `memory-panel.js` | 311 | 记忆管理面板 |
| `schedule-panel.js` | 252 | 定时任务面板 |
| `weixin-panel.js` | 243 | 微信通道面板 |
| `skill-panel.js` | 241 | 技能管理面板 |
| `comm-panel.js` | 213 | 通信中枢面板 |
| `feishu-panel.js` | 198 | 飞书面板 |
| `tool-card.js` | 172 | 工具调用卡片 |
| `security-panel.js` | 164 | 安全增强面板 |
| `redaction-panel.js` | 160 | 脱敏规则管理面板 |
| `eye-tracking.js` | 153 | 眼珠跟随鼠标 |
| `pets/index.js` | 151 | 宠物注册表 |
| `qq-panel.js` | 140 | QQ 面板 |
| `agent-panel.js` | 90 | Agent 模式切换面板 |
| `project-dir.js` | 75 | 项目目录显示与修改 |
| `dom-prefix.js` | 41 | DOM 前缀随机化 |
| `pets/pet-bird.js` / `pet-robot48.js` | 19 / 26 | 宠物造型 |

### 4.4 壳页面（左侧栏）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `shell-render.js` | 5,329 | **最大单文件**：文件树 + 预览 + 拖拽调宽 |
| `shell-utils.js` | 130 | 纯函数工具 |
| `shell-render-helpers.js` | 67 | 工作区渲染纯函数 |
| `shell-token-utils.js` | 42 | 状态栏 token 纯函数 |
| `statusbar-layout.js` | 51 | 状态栏布局计算 |
| `tool-names.js` | 101 | 工具名集合（白名单校验） |

---

## 五、工具层 tools（43 文件，39 个已注册）

### 5.1 已注册工具（按 tools/index.js 顺序）

| # | 工具名 | 文件 | 职责 |
|---|---|---|---|
| 1 | write | WriteTool.js | 写文件 |
| 2 | read | ReadTool.js | 读文件（带行号窗口） |
| 3 | read_lines | ReadLinesTool.js | 结构化行读取 |
| 4 | edit | EditTool.js | 精确替换 |
| 5 | glob | GlobToolNew.js | 路径模式匹配 |
| 6 | grep | GrepToolNew.js | 内容正则搜索 |
| 7 | todo_write | TodoWriteTool.js | 任务列表 |
| 8 | bash | BashTool.js | 执行命令（cmd.exe） |
| 9 | pwsh | PwshTool.js | PowerShell |
| 10 | file_delete | FileDeleteTool.js | 删除文件 |
| 11 | web_fetch | WebFetchTool.js | 抓取 URL |
| 12 | mysql | MySQLTool.js | MySQL 查询 |
| 13 | open_browser_window | OpenBrowserWindowTool.js | 打开 Electron 浏览器 |
| 14 | inject_js | InjectJSTool.js | 向窗口注入 JS |
| 15 | mcp_call | McpCallTool.js | 调用 MCP 工具 |
| 16 | mcp_list_servers | McpQueryTools.js | 列 MCP server |
| 17 | mcp_get_tools | McpQueryTools.js | 列 MCP 工具 |
| 18 | memory_save | MemoryTool.js | 保存记忆 |
| 19 | memory_update | MemoryTool.js | 更新记忆 |
| 20 | memory_delete | MemoryTool.js | 删除记忆 |
| 21 | memory_list | MemoryTool.js | 记忆索引 |
| 22 | memory_recall | MemoryTool.js | 检索记忆 |
| 23 | memory_get | MemoryTool.js | 取记忆正文 |
| 24 | memory_get_full | MemoryTool.js | 取完整原文 |
| 25 | skill_list | SkillTool.js | 列技能 |
| 26 | web_search | WebSearchTool.js | 联网搜索 |
| 27 | view_image | ViewImageTool.js | 查看图片 |
| 28 | wait_for | WaitForTool.js | 轮询等待 |
| 29 | bash_background | BackgroundTaskTool.js | 后台任务 |
| 30 | bash_output | BackgroundTaskTool.js | 查后台输出 |
| 31 | bash_kill | BackgroundTaskTool.js | 终止后台任务 |
| 32 | nameConversation | NameConversationTool.js | 生成标题建议 |
| 33 | list_plugins | ListPluginsTool.js | 列已安装插件 |
| 34 | purge | PurgeTool.js | 切换破甲规则集 |
| 35 | send_media | SendMediaTool.js | 发送文件到 IM |
| 36 | list_windows | DispatchTool.js | 列应用内窗口 |
| 37 | dispatchToWindow | DispatchTool.js | 派发指令到窗口 |
| 38 | redact_lookup | RedactLookupTool.js | 查脱敏占位符含义 |
| 39 | redaction_auto_scan | RedactionAutoScanTool.js | 自动扫描记忆生成规则 |

### 5.2 未注册但存在的支撑模块

| 文件 | 行数 | 说明 |
|---|---:|---|
| `JsRunner.js` | 673 | **JS 沙箱执行器**（vm.createContext） |
| `ToolRegistry.js` | 230 | 工具注册表 |
| `DispatchTool.js` | 321 | 含 ListWindowsTool + DispatchToWindowTool 两个类 |
| `UserTodoStore.js` | 256 | 用户手动待办（与 AI todo 分离） |
| `active-processes.js` | 249 | 子进程跟踪（停止用） |
| `tool-lifecycle.js` | 140 | 工具生命周期追踪 |
| `browser-window-manager.js` | 180 | 浏览器窗口/标签管理 |
| `MemoryTool.js` | 319 | 含 7 个 memory_* 工具类 |
| `dangerous-commands.js` | 60 | 危险命令规则（单一事实来源） |
| `readonly-guard.js` | 79 | 只读模式写操作拦截 |
| `plan-gate.js` | 78 | 计划门禁（写前须建计划） |
| `with-timeout.js` | 77 | Promise 超时包装 |
| `memory-audit.js` | 100 | 记忆库体检 |
| `memory-janitor.js` | 94 | 内存清理 |
| `decodeOutput.js` | 44 | 命令输出解码（GBK/UTF-8） |

---

## 六、平台适配层 src/providers（7 文件）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `deepseek.js` | 559 | DeepSeek：输入框选择器、hook 源码（SSE 拦截）、会话 ID 提取 |
| `chatgpt.js` | 420 | ChatGPT：ProseMirror 输入框、hook |
| `claude.js` | 340 | Claude：ProseMirror 输入框、hook |
| `sse/deepseek-parse.js` | 272 | SSE 流解析（纯函数） |
| `custom/loader.js` | 225 | 自定义 Provider 加载（导入复制到 userData） |
| `custom/provider.template.js` | 109 | 自定义 Provider 模板 |
| `index.js` | 32 | Provider 注册表 |

---

## 七、工具调用完整链路

```
用户提问
  ↓
AI 网页回复（含 \`\`\`lingya 代码块 或 JSON 工具调用）
  ↓
【preload 层】
  ├─ intercept.js（拦截模式）/ DOM 观察（DOM 模式）
  ↓ tool-parser.js 宽容 JSON 解析
  ↓ js-detector.js 识别 JS 工具脚本
  ↓ tool-executor.js（幂等 + 超时 + 卡片实时反馈）
  ↓ IPC
【主进程层】ipc.js
  ├─ execute-tool（JSON 工具调用）→ unredactDeep → tool-registry → 门禁链
  ├─ execute-js（代码块）→ JsRunner.run → 沙箱内 __ipc 桥接 → unredactDeep → 工具
  └─ execute-command（弹窗确认）→ unredactText → shell 执行
  ├─ dangerous-commands.js   危险命令拦截
  ├─ readonly-guard.js       只读模式写操作拦截
  ├─ plan-gate.js            写前须建计划
  └─ tool-lifecycle.js       按会话隔离追踪
  ↓
【沙箱层】tools/JsRunner.js（vm.createContext）
  ├─ 禁 eval / Function / require / process / global
  ├─ SYNC_TIMEOUT 30s，RUN_DEADLINE 660s
  ├─ __ipc 单向桥接
  └─ OUTPUT_LIMIT 20000 字符
  ↓ IPC 回传
【preload 层】
  ├─ 结果写入覆盖层卡片
  ├─ conversation-log.addEntry（还原真词后存档）
  └─ sendToolResultToChat（出站脱敏后回传 AI）
  ↓
AI 看到工具结果 → 下一轮
```

---

## 八、脱敏双向闭环（2026-11-05 完成）

| 方向 | 位置 | 机制 |
|---|---|---|
| **出站** | `deepseek-input.js` 3 处 / `file-upload.js` / `harness-bridge.js` | `redactText` 真词 → 占位符 |
| **入站 1** | `ipc.js:1143` execute-tool | `unredactDeep(params)` |
| **入站 2** | `JsRunner.js:475` execute-js | `unredactDeep(args)` |
| **入站 3** | `ipc.js` execute-command | `unredactText(command)` |
| **本地还原 1** | `dom-unredact.js` | MutationObserver 节流 150ms 还原网页 DOM |
| **本地还原 2** | `feishu/weixin/qq-bridge.js` 的 `report()` | IM 推送前还原 |
| **本地还原 3** | `conversation-log.js` 的 `addEntry()` | 存档前还原 |
| **本地还原 4** | `overlay/ui.js` 的 `addHistory()` | 面板历史前还原 |

规则表位置：`H:\\灵鸦数据\\灵鸦-脱敏.json`（221 条启用，由 data-location.json 的 customDir 指定）

---

## 九、测试覆盖

| 目录 | 测试文件数 |
|---|---:|
| `test/main` | 59 |
| `test/preload` | 48 |
| `test/tools` | 35 |
| **合计** | **142** |

**无直接对应测试的 src/main 文件（28/57）**：

agent-store / agents / channel-commands / cron / dropdown-window / feishu-ipc / file-tree / global-guard / ipc-guard / mcp-client / mcp-config / media-ipc / memory-redact / memory-store / overflow-window / pet-loader / plugin-host / plugin-store / plugin-zip / prompt-template-store / qq-ipc / schedule-ipc / schedule-store / scheduler / skill-store / tool-registry / tray / weixin-ipc

**测试基线**：1272 tests / 1271 pass / 1 fail（`redaction-store.test.js` 的「导出→导入往返」，2 字符规则与长度校验冲突，已知问题）

---

## 十、数据目录结构（H:\灵鸦数据）

### 数据文件

| 文件 | 大小 | 内容 |
|---|---:|---|
| `lingya-skills.json` | 3.6 MB | **最大**：技能库 |
| `lingya-memory.json` | 996 KB | 长期记忆 |
| `lingya-dsh-market.json` | 315 KB | DSH 市场缓存 |
| `lingya-redaction.json` | 51 KB | 脱敏规则（221 条） |
| `lingya-todos.json` | 7 KB | AI 待办 |
| `session-dir-map-profile-*.json` | 4.8 / 0.3 KB | 会话↔目录映射（每 profile） |
| `lingya-plugins.json` | 3.6 KB | 插件启用状态 |
| `lingya-presets.json` | 0.9 KB | 分屏预设 |
| `mcp.json` | 1.0 KB | MCP 配置 |
| `profile-list.json` | 1.0 KB | Profile 列表 |
| `weixin.json` / `qq.json` | 0.4 / 0.2 KB | IM 通道配置 |
| `en-US-10-1.bdic` | 441 KB | 拼写检查词典 |

### 子目录

`conversations/`（会话存档 jsonl）、`plugins/`、`graphify/`、`media-inbox/`、`dsh-plugins/`、`instances/`（多实例隔离）、`wyp/log/`（开发日志）、`Partitions/`（每 profile 独立）、`blob_storage/`、`Cache/`、`Local Storage/`、`Session Storage/`

---

## 十一、启动链路（preload/index.js 初始化顺序）

```
1. require('./api')                          — contextBridge API
2. redaction-filter.refreshRules()            — 拉脱敏规则（异步）
3. webFrame.executeJavaScript(指纹修复脚本)    — 主世界注入（最早）
4. ui.injectOverlay()                         — 覆盖层注入
5. projectDir.initProjectDirSection()         — 项目目录区块
6. interceptObserver.startInterceptObserver() — 拦截监听启动
7. rate-limit-retry.startRateLimitEngine()    — 重试引擎
8. harness-bridge.initHarnessBridge()         — Harness 模式
9. eye-tracking.startEyeTracking()            — 眼珠跟随
10. auto-inject.startAutoInjectWatcher()      — 自动注入监听
11. feishu-bridge / weixin-bridge / qq-bridge — 三 IM 通道
12. schedule-bridge.initScheduleBridge()      — 定时任务
13. plugin-api.install()                      — 本地插件 API
14. deepseek-history-archiver                 — DeepSeek 侧栏归档
15. page-title-sync                           — 标题同步
16. conversation-log.initConversationLog()    — 会话记录
17. dom-unredact.startDomUnredact()           — DOM 占位符还原（2026-11-05）
```

---

## 十二、关键数据流总结

| 数据流 | 入口 | 出口 |
|---|---|---|
| **AI 回复** | intercept.js（网络拦截）/ DOM observer | 覆盖层卡片 + conversation-log + 三 IM bridge |
| **工具调用** | tool-executor.js | ipc.js → JsRunner / registry → 结果回传 |
| **记忆** | auto-inject.js（新会话注入） | AI（system prompt 内置） |
| **技能** | auto-inject.js | AI（system prompt 内置） |
| **脱敏** | redactText（出站）/ unredactDeep（入站） | 8 个调用点（见第八节） |
| **定时任务** | scheduler.js（30s tick） | sendToChat → AI |
| **Token 轮转** | token-rotation.js | 跨窗口 dispatch |

---

## 十三、与 .lingyaCode/LINGYA.md 的差异

`.lingyaCode/LINGYA.md` 停留在 **0.6.86**（落后 108 个版本），缺以下关键模块：

**主进程**：memory-redact.js / global-guard.js / ipc-guard.js / task-status.js / token-rotation.js / workspace-aggregator.js / cdp-capture.js / cdp-wiring.js / channel-commands.js / channel-panel.js / media/*（5 个）/ qq-ipc.js / weixin-ipc.js / pet-loader.js / overflow-window.js / conversation-archive*.js（2 个）/ preset-store.js / prompt-template-store.js / graphify-builder.js / round-collector.js / activity-tracker.js / generation-state.js

**preload**：cdp-bridge.js / dom-fallback.js / rate-limit-retry.js / redaction-filter.js / dom-unredact.js / tps-meter.js / upload-hint.js / xml-detect.js / harness-bridge.js / harness-preload.js / statusbar-layout.js / send-merge.js / intercept-preempt.js / idempotency.js / timeout.js / evt-names.js

**overlay**：comm-panel.js / eye-tracking.js / pets/* / qq-panel.js / redaction-panel.js / weixin-panel.js / dom-prefix.js

**tools**：DispatchTool.js / PurgeTool.js / SkillTool.js / WaitForTool.js / UserTodoStore.js / memory-janitor.js / memory-audit.js / redaction-auto-scan-tool.js / RedactLookupTool.js / SendMediaTool.js / with-timeout.js / tool-lifecycle.js / active-processes.js / browser-window-manager.js

**建议**：以本文件为准，逐步更新 LINGYA.md，或直接把本文件作为当前项目地图。
