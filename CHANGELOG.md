# Changelog

## [0.6.39] - 2026-10-14

### Added
- **侧边栏功能完整性核对脚本** `npm run check:sidebar`（`scripts/verify-sidebar-parity.js`）：校验 shellAPI 三层、IPC 通道、26 个面板功能点、事件对齐

### Fixed
- **侧边栏设置不持久化**：发送延迟/自动注入/自动压缩保存后重启回默认值
  - 侧边栏设置面板不回显 + localStorage 跨 origin 隔离，改为保存时写侧边栏自己的 localStorage 并在打开时回显
- **点保存无提示**：toast 用 left:50% 落在窗口中间（AI 视图区）被 WebContentsView 盖住，改为侧栏左下角显示

### Notes
- 全量测试 361/361 通过
- 全项目审计：语法/API/IPC/事件/DOM 全对齐

## [0.6.38] - 2026-10-14


### Added
- **隔离实例目录自动清理**：启动时清理超过 7 天的 `instances/auto-*` 目录（多开残留），新增单测

### Fixed
- **点击侧边栏图标无反应**：拖拽 `pointer-events:none` 在 pointerdown 时立即加导致 click 被吞，改为移动超阈值后才加
- **活动栏拖拽不能任意换位**：拖拽元素遮挡 `elementFromPoint`，加 `pointer-events:none` 让检测穿透；并从 DOM 实际顺序持久化（原来被旧 abOrder 还原）
- **设置弹窗 2 栏时不可见**：点齿轮先展开侧栏 + 弹窗位置 clamp 到窗口内
- **启动检测更新失败弹窗**：禁用启动时自动检查更新
- **初始化项目按钮过大**：改小为 `lingya-btn-sm`
- **首次提示浮窗**：整体移除（底部/侧边栏已有初始化按钮）

### Changed
- 清理 2 个废弃事件（`page-loaded`/`session-restored`，无监听方）
- `_shouldQuit`（单实例模式未拿到锁）时提前退出，跳过无用初始化

### Audit
- 全项目审计：103 个 JS 文件语法 0 错误；renderer↔preload / overlay↔api API 缺失 0；IPC 通道 handle↔invoke 无孤儿；事件 11 send/11 on 全对齐；DOM id 无悬空

### Notes
- 全量测试 361/361 通过

## [0.6.37] - 2026-10-14


### Added
- **侧边栏活动栏图标网格 + 拖拽排序**：图标支持 1/2/3 列显示，拖动图标自定义顺序（持久化）
- **活动栏图标小名称标签**（图标下方中文小字，VSCode 风格）
- **底部齿轮设置弹窗**（SVG 图标），内含列数选择 + 拖拽提示
- **悬浮元素可开关**：悬浮球/覆盖层面板/计划悬浮卡可在设置里显示或隐藏

### Fixed
- **侧边栏「任务计划」面板不显示 + 不同步进度**：
  - 根因 1：`resolveSessionId` 用侧边栏（壳窗口）的 sender 解析不出 sessionId → 改为始终用 AI 视图 URL
  - 根因 2：`lingya-todos-updated` 广播只发 AI 视图，壳窗口收不到 → 广播同时发给壳窗口
- **计划长文本撑破卡片**：文字加 min-width:0 + 换行，卡片加 overflow 约束
- **设置弹窗双栏时被活动栏盖住**：left 改 calc(var(--sh-ab-w)+10px) 动态跟随
- **活动栏图标不居中**：emoji 包固定容器 + line-height:1
- **活动栏与面板无缝贴一起**：加实色分隔线 + 投影
- **shell-preload 漏暴露飞书 6 个 API + saveSkill**（群列表静默不加载、技能保存失败）

### Notes
- 全量测试 359/359 通过

## [0.6.36] - 2026-10-14


### Added
- **侧边栏多面板系统（12 面板，功能对等覆盖层）**：
  - 活动栏图标：项目文件 / 任务计划 / 长期记忆 / 技能库 / 安全增强 / 定时任务 / 飞书同步 / 会话列表 / 执行日志 / MCP 工具 / 窗口管理 / 设置
  - 记忆：类型筛选 · 搜索 · 新建/编辑/删除 · 插入/全部插入到聊天 · 导入/导出
  - 技能：搜索 · 新建/编辑/删除 · 启停 · 插入 · 本地导入
  - 安全：全部字段（CTF注入/AI改写/自动续写/停滞监督等）+ 重置 + 立即注入
  - 定时：列表 · 立即执行 · 编辑 · 启停 · 删除 · 新建（每天/每周/cron 三模式）
  - 飞书：连接状态 · 配置 · 5 推送选项 · 群绑定 · 重连/断开/刷新
  - 会话/MCP/窗口：列表 · 跳转 · 启用禁用 · JSON 配置 · 打开/改名/删除
  - 设置：Agent 模式 · 自动压缩 · 生成文档 · 压缩上下文 · 导出对话 · 沉浸式 · 手动解析 · 停止 · 自动注入 · 发送延迟 · 悬浮元素开关
- **5 个跨上下文通道**（侧边栏 ↔ AI 视图）：insert-to-chat / new-chat / run-action / set-setting / report-history
- **活动栏图标 1/2/3 列网格 + 拖拽排序**（自定义列数 + 顺序，持久化）
- **活动栏图标小名称标签**（图标下方中文小字）
- **底部齿轮设置弹窗**（SVG 图标，含列数选择）
- **悬浮元素可开关**：悬浮球/覆盖层面板/计划悬浮卡可在设置里显示或隐藏

### Fixed
- 修复 shell-preload 漏暴露飞书 6 个 API + saveSkill（导致群列表静默不加载、技能保存失败）
- 修复设置弹窗双栏时被活动栏盖住（left 改 calc 动态跟随）
- 修复活动栏图标不居中（emoji 包固定容器 + line-height: 1）
- 侧边栏活动栏加实色分隔线 + 投影（原无缝贴一起）

### Changed
- 侧边栏右缘渐变发光边（与 AI 网页区分）

### Notes
- 全量测试 359/359 通过

## [0.6.35] - 2026-10-14


### Added
- **多实例支持（多开）**：同一个 LingYa.exe 可同时运行多个独立实例
  - 默认允许多开：第二个及后续实例自动使用隔离数据目录 `<数据目录>/instances/auto-<pid>`，互不干扰
  - 具名实例：设环境变量 `LINGYA_INSTANCE=<名>` → 使用固定目录 `<数据目录>/instances/<名>`，配置可持久、可复现
  - 恢复单实例：设环境变量 `LINGYA_SINGLE=1` → 第二次启动直接退出（回到旧行为）
  - `src/main/data-dir.js` 新增 `sanitizeInstanceName()` / `resolveInstanceDir()`（含路径穿越防护）
  - `src/main/index.js`：单实例锁重构 —— 先 setPath 基础目录（锁基于真实数据目录）→ 请求锁 → 未拿到锁则切隔离目录
  - 新增单测 `test/main/data-dir-instance.test.js`（5 用例）
- 全量测试 359/359 通过

## [0.6.34] - 2026-10-14


### Reverted
- **回滚 v0.6.33 的界面视觉重设计**：移除 144 行 CSS 覆盖层（360px 面板、毛玻璃、渐变标题、下划线页签、卡片化区块等），界面恢复 0.6.32 的墨鸦原风格
- 保留 v0.6.32 的功能性改动：工具调用卡片、计划卡片进度条
- 全量测试 354/354 通过

## [0.6.33] - 2026-10-14


### Changed
- **界面整体视觉重设计（仿 DeepSeek Harness 视觉语言）**：
  - 面板加宽 300px → **360px**，最大高度 60vh → 74vh
  - 大圆角（16px）+ 深阴影 + **毛玻璃背景**（backdrop-filter blur + saturate）
  - 标题 **渐变文字**（青碧渐变，background-clip: text）
  - 页签从"块状"改为 **下划线指示器风**（dsh 风格）
  - 所有区块 **卡片化**（每个 section 变独立卡片，圆角 + 边框 + 内边距）
  - 主按钮 **渐变填充**（135deg 青碧渐变），次级按钮 hover 变主色边框
  - 快捷操作网格 hover **上浮 2px** + 主色边框
  - 输入框/选择器统一圆角，focus 时主色边框
  - 滚动条美化（hover 变主色）
  - 全部通过 CSS 覆盖层实现，**不改 HTML 结构、不改元素 id**，零回归风险
- 全量测试 354/354 通过

## [0.6.32] - 2026-10-14


### Added
- **架构决策笔记体系（Agent Note，借鉴 DeepSeek Harness）**：
  - 新建 `.lingyaCode/notes/{proposed,implemented,rejected}/{feature,bug-fix,simplification,architecture,process,testing}/` 三态目录结构
  - `notes/README.md` 规范说明 + `_template.{proposed,implemented,rejected}.md` 三态模板
  - `scripts/check-notes.js` 校验器（纯 Node 零依赖）：校验生命周期/状态一致、类别封闭、`## Problem` 开头、`## Alternatives considered` 必需、文件名格式、implemented 禁提案用语
  - `npm run check:notes` 一键校验
  - 强制「改代码前先想清楚为什么」：非平凡改动必须留下决策笔记（Problem → Decision → Alternatives → Consequences）
- **工具调用卡片（仿 dsh ui-tool）**：
  - `src/preload/overlay/tool-card.js`：`renderToolCard()` + `TOOL_CARD_CSS` + `injectToolCardCSS()`
  - 工具执行结果从纯文本升级为卡片：工具名 + 参数摘要 + 状态徽标（成功/失败/执行中）+ 可折叠输出
  - 接入 `tool-executor.js` 渲染流程，结果区新增 `#lingya-tool-cards` 容器
  - 防 XSS 转义，最多保留 20 张卡片
- **计划卡片进度条**：`plan-panel.js` 加 `progressHtml()`，页签面板和悬浮卡显示完成进度条

### Changed
- `.lingyaCode/LINGYA.md` 新增第十章「协作规范（移植自 DeepSeek Harness）」：改动原则、验证闭环、分层纪律
- `docs/UI-REDESIGN-PLAN.md`：仿 dsh UI 布局改造方案

### Notes
- 借鉴对象：DeepSeek Harness（dsh，TypeScript + React 独立 Web 应用）。dsh 无法直接移植到 LingYa（CommonJS 注入式浮层），仅借鉴其设计语言与工程规范。
- 全量测试 354/354 通过。

## [0.6.30] - 2026-10-12


### Added
- **文件树完整编辑能力**：
  - **新建文件 / 新建文件夹**：目录右键 → 弹输入框 → 创建（名称合法性校验，防路径穿越）
  - **重命名**：文件/目录右键 → 弹框预填原名 → 重命名
  - **编辑文件内容**：预览区新增编辑按钮 → textarea 编辑 → 保存（Ctrl+S）/ 取消（Esc）
    - 首次保存自动生成 `.lingya-bak` 备份
    - 保存后同步更新预览区
- **文件树显示完整项目**：`IGNORE_DIRS` 从 30+ 项收缩到 5 项（仅 `node_modules`/`.git`/`.svn`/`.hg`/`__pycache__`/`venv` 等必然卡死的），`dist`/`build`/`out`/`.vscode` 等现在都显示
  - 实测：项目顶层 457 节点，`dist` 可见，`node_modules` 仍隐藏

### Security
- 所有写操作走统一 `_resolveInProject()`：`realpathSync` 校验目标必须在项目目录内（防越权）
- 文件名校验：拒绝 `.`/`..`/`/`/\\/`:`/`*`/`?`/`"`/`<`/`>`/`|`

## [0.6.29] - 2026-10-12

### Added
- **文件树右键菜单**：右键文件/目录可
  - **复制绝对路径** —— 一键复制完整路径到剪贴板（配合 AI 的 read/edit 工具使用）
  - **移到回收站** —— 删除文件（可恢复，默认）
  - **永久删除** —— 不可恢复（红色警示）
  - 目录只提供「复制绝对路径」（不支持删目录）
  - 主进程侧安全：`realpathSync` 校验必须在项目目录内、禁止删目录根、弹原生确认框（防 renderer 伪造）
  - 新增 IPC `shell-delete-file`（用 Electron `shell.trashItem` 移回收站）/ `shell-copy-text`（`clipboard.writeText`）

## [0.6.28] - 2026-10-12

### Added
- **架构改造：壳窗口 + WebContentsView 双视图**（侧栏与 AI 网页原生分离，对齐 cuckoo-code）
  - `BrowserWindow`（壳）承载左侧栏，`WebContentsView`（AI 网页）独立渲染 —— 两者是**不同的 webContents**，互不干扰
  - 展开侧栏：窗口 +280px + AI view 右移 280px → **AI 可用宽度完全不变**（Electron 实测 1186px 恒定）
  - 新增 `src/ui/shell.html` + `src/preload/shell-preload.js` + `src/preload/shell-renderer.js`
  - `windowState` 新增 `view` 字段 + `getViewWebContents()`；`getContextByWebContents` 同时匹配壳窗口与 AI view
  - 兼容层：`ctx.win` 用 Proxy 代理，`.webContents`/`loadURL`/`loadFile` 自动转发到 AI view，85 处旧调用无需改动
  - 新增 IPC `shell-sidebar-toggle`（按 event.sender 路由，支持多窗口）
- **项目文件树（只读）**：左侧栏浏览当前项目目录并预览文件内容
  - **推挤布局 + 窗口加宽**：展开时窗口宽 +280px，同时给 `body` 加 `padding-left: 280px` —— 侧栏占用**新增空间**，**AI 对话区净宽不变**（1200 → 1480 窗口 / 净宽仍 1200）
  - 新增 IPC `sidebar-resize-window`：主进程负责窗口加宽/收窄，含屏幕工作区边界与最大化保护
  - 交互：点屏幕左边缘的 📁 竖条按钮展开/收起；或按 `Esc`、点侧栏右上角 ×
  - 状态持久化到 `localStorage['lingya-sidebar-open']`，下次打开保持
- **深色 / 浅色主题切换**：主页「快捷操作」新增「主题」按钮（🌙/☀️）
  - 浅色主题用 `html.lingya-theme-light` 覆盖全套 CSS 变量（背景/文字/边框/主色/code 底色等 16 项）
  - 状态持久化到 `localStorage['lingya-theme']`
  - 批量颜色替换为 CSS 变量（40+ 处硬编码色 → `var(--ck-*)`），使主题可整体切换
  - `src/main/file-tree.js`（新增）：递归构建目录树，忽略 `node_modules`/`.git`/`dist`/`venv`/`__pycache__` 等 30+ 目录；节点上限 5000、深度上限 12，超限标记 `truncated`
  - `src/main/ipc.js`：新增 `get-file-tree`（从 `sessionStore.state.selectedProjectDir` 取根目录）与 `read-file-preview`（**路径越权防护**：`realpathSync` 解析后校验必须在项目目录内；限 512KB）
  - `src/preload/overlay/file-tree-panel.js`（新增）：渲染 + 搜索过滤（保留匹配节点及祖先）+ 目录折叠 + 文件预览；40+ 扩展名映射配色（VSCode 风格）
  - `src/preload/overlay/template.js`：新增「文件」页签 + 面板 HTML + 18 条 CSS
  - `src/preload/api.js` / `overlay/events.js`：暴露 API 与事件绑定
  - 只读设计：不支持编辑/新建/删除（改文件仍由 AI 的 `write`/`edit` 工具完成）
  - 未引入 monaco-editor（预览用 `<pre>` 纯文本，避免 +60MB 依赖）

### Removed
- **限流防护整体移除**（0.6.26 引入，按用户要求删除）：悬浮球的「限流冷却中 mm:ss」倒计时不再显示
  - 删除 `src/preload/dom/rate-limiter.js` 及其测试
  - `src/providers/deepseek.js`：删 `dispatchRateLimit()` / `RL_WORDS` / `looksRateLimitedText()` / fetch+XHR 的 429 检测
  - `src/preload/dom/chat-input.js`：删 `rateLimiter` 依赖、`waitMs`/`totalDelay` 叠加、`markSent()`
  - `src/preload/overlay/ui.js`：删 `updateRateLimitUI()` 与冷却状态守卫
  - `src/preload/overlay/template.js`：删 `.lingya-state-cooling` 样式
  - `src/preload/index.js`：删限流防护启动块
  - `src/preload/dom/supervisor.js`：删冷却期跳过判断
  - 对话导出功能不受影响（`dispatchUserMessage` 与 `lingya-user-message` 事件保留）

### Fixed
- **对话导出跨来源重复记录**：同一条用户消息可能同时来自 `onUserMessageSent`（LingYa 发送）与 `lingya-user-message`（hook 从请求体提取），导致导出重复
  - `src/preload/dom/conversation-log.js` 新增 5 秒窗口 + 单向包含去重
  - 关键：只判定「新消息是旧消息的包装版本」（如 旧=`你好`、新=`用户消息：你好`），**不做双向包含** —— 否则「帮我看看代码」与「帮我看看代码里的 bug」会被误判为重复而丢失
  - 新增 5 个测试用例（跨来源去重 / 不同消息不误删 / 短文本不误杀 / 延伸内容不误判）

### Added
- **todo 单项即时同步**：要求 AI 每完成一项就立刻单独调用一次 `todoWrite`，禁止攒批（此前会做完 2-3 项才一起更新，导致计划面板长时间停在同一项）
  - `tools/TodoWriteTool.js` `getPromptSection()` 新增「强制规则二 · 单项即时同步」+ 错误示范 + 正确节奏示例
  - 工具 `description`、`tools/lingya-tools.d.ts`、4 个提示词模板同步强化措辞

## [0.6.26] - 2026-10-12

### Added
- **技能渐进式披露**：修复技能注入的顺序截断问题 —— 原实现按数组顺序拼「name + description + instructions 全文」，超 4000 token 预算即 break，导致装了 119 个技能时 AI 实际只看得见排最前的 2 个（117 个被静默丢弃）
  - `src/main/skill-store.js` `buildSkillSection()` 改为渐进式披露：有本地 SKILL.md 的技能只注入「name + 首句描述 + 路径」，AI 任务相关时用 read 读取全文；无本地文件的内联全文
  - 新增 `firstSentence()`：中文按 。！？ 断句，英文只在 ". " 或行尾断句（避免 e.g./v1.0 被误截）
  - 4 个提示词模板（deepseek/default/chatgpt/claude）「## 技能」章节后加规则：任务相关时**必须先用 read 读 SKILL.md 全文**再执行
  - 实测效果：可见技能 **2 → 119**（全覆盖），注入体积 2716 → 5024 tokens（对比全文注入 248425 tokens 省约 50 倍）
  - 对照测试 10/10 通过
- **导出对话为 Markdown**：会话面板新增「导出对话 (.md)」按钮，把本窗口累积的对话写成 Markdown 文件
  - 背景：LingYa 不持久化对话内容（session-store 只存「会话ID→项目目录」），网页 IndexedDB 也只有 message_id/role 元数据（实测无正文），故只能在运行时累积
  - 新增 `src/preload/dom/conversation-log.js`：三来源累积 —— ① AI 回复（onInterceptedResponse）② LingYa 发送的用户消息（onUserMessageSent，过滤系统消息）③ 用户手动发送（主世界 hook 从请求体提取后派发 `lingya-user-message`）
  - 导出内容含元信息（导出时间/平台/会话链接/会话 ID/项目目录/消息数），AI 回复默认剥离 lingya/js 工具代码块
  - 自动过滤系统消息（自动续写、监督续跑、压缩摘要、工具回传等 20+ 种 tag）
  - 新增 IPC `conversation-export-md`（弹保存框写盘）+ `window.electronAPI.conversationExportMd`
  - 新增 `test/preload/conversation-log.test.js`（12 用例，纯 Node）
- **限流防护（三层）**：恢复丢失的 DeepSeek 限流防护，避免 Agent 循环高频回传触发账号级限流（页面提示「消息发送过于频繁」，冷却约 10 分钟，任务直接卡死）
  - **A 预防**：新增 `src/preload/dom/rate-limiter.js` —— `getWaitMs()` 统一计算需等待时长（冷却剩余 与 自适应最小间隔 取最大值），`sendToChat` 发送前叠加该等待
  - **B 检测**：`src/providers/deepseek.js` 主世界 hook 新增 `dispatchRateLimit()` —— 识别 HTTP 429（fetch/XHR）、4xx 响应体限流关键词，派发 `lingya-ai-ratelimited` 事件；rate-limiter 另用 MutationObserver 监听页面短提示文本兜底（仅发送后 15s 窗口内、文本 ≤120 字符，避免误判 AI 回复正文）
  - **C 恢复**：命中后进入冷却（默认 10 分钟），冷却期内发送自动排队等待，结束自动续跑；最小间隔每次命中 +3s，上限 30s
  - 悬浮球新增 `cooling` 状态 + 每秒倒计时「限流冷却中 mm:ss」
  - 新增 `test/preload/rate-limiter.test.js`（7 用例，纯 Node 不依赖 electron）
  - 限流初始化独立于 `init()` 主 try 块 —— 避免别处抛异常导致限流静默失效
  - 测试：全量 330 通过；Electron 环境实测（事件→冷却→UI 倒计时）通过

## [0.6.25] - 2026-10-12

### Fixed
- **新建窗口源码文本泄漏（"乱码"）**：portable 版运行时解压到 `%TEMP%` 时若 `resources.pak` 加载失败，Chromium UA 样式表丢失，导致 `<style>`/`<script>` 源码被当作可见文本渲染
  - `src/preload/overlay/template.js`：`OVERLAY_CSS` 顶部加 `style, script { display: none !important; }` 作者级兜底
  - `src/ui/platform-select.html`：同步加同规则
  - 已用「隐藏 resources.pak」对照实验验证：无防御时 script 计算样式为 `inline`（文本可见），加防御后为 `none`（正常隐藏）

## [0.6.11] - 2026-10-05

### Added
- **计划（Plan）页签**：新增独立页签，实时渲染 AI 通过 `todoWrite` 维护的任务计划
  - 每项显示序号 + 状态图标（○ 待办 / ◐ 进行中 / ✔ 已完成），已完成项自动置灰加删除线
  - 页签标题带进度角标（如 "3/5"），不展开也能看到当前进度
  - `todoEvents` 变更事件通过 IPC 推送（`lingya-todos-updated`），面板订阅后实时刷新，无需手动刷新
  - 新增 `src/preload/overlay/plan-panel.js`（渲染 + 订阅）与单测 `test/preload/plan-panel.test.js`
  - 新增 API：`window.electronAPI.getTodos()` / `onTodosUpdated(cb)`

### Changed
- `tools/TodoWriteTool.js` 导出 `todoEvents` 与 `getTodos(profileId)`，按 profile 隔离待办列表
- `src/main/ipc.js` 新增 `get-todos` 处理与 `lingya-todos-updated` 广播

## [0.6.10] - 2026-10-04

### Fixed
- **记忆检索看不到"有哪些记忆"**：注入块只给被选中的记忆正文，未选中条目仅以"另有 N 条"抽象数字提示，模型无法联想到具体条目（如"GitHub Token 也在记忆里"）。
  - `buildMemorySection` 现在**始终附带全部记忆索引**（仅 id/类型/名称，不含正文），让模型明确知道有哪些记忆可用
  - 追加判断标准句，绑定到凭证/token/路径/配置等具体场景，提示"先调用 memoryList() 取全文再动手"
  - `MemoryListTool` 检索场景补充"需要凭证/token/密钥/路径/配置/端口/账号时"
  - 4 个提示词模板同步强化措辞

## [0.6.9] - 2026-10-04

### Added
- **便携数据目录**：新增 `src/main/data-dir.js`，便携版（electron-builder 便携版 / exe 旁放 `portable.txt`）数据写入 `<exe目录>/LingYa-Data`，记忆、技能、安全配置、Agent、MCP、profile、登录态全部随程序目录走，换电脑整体拷贝即可
  - 首次便携运行自动从旧 AppData 迁移一次（`LINGYA_NO_MIGRATE` 可禁用）；便携目录已有数据时不覆盖
  - `LINGYA_USER_DATA_DIR` 环境变量可显式指定数据目录
- **`viewImage` 多模态看图**：读取本地图片（png/jpg/jpeg/gif/webp/bmp，≤5MB）并作为附件发送给多模态模型查看
- **后台任务工具** `bashBackground` / `bashOutput` / `bashKill`：长任务（编译、起服务、爬虫、fuzz）后台运行，不阻塞脚本；支持等待完成、查询输出、终止进程树
- **`webFetch` 支持 POST/自定义请求头/请求体**：`webFetch(url, { method, headers, body })`，覆盖 API 调试、认证请求场景
- **`webSearch` 接入 Exa AI**：结构化搜索结果（标题/URL/发布时间/正文高亮片段），无需 API key；Exa 不可用时自动降级 Bing 抓取

### Changed
- **记忆主动检索**：提示词明确"注入的记忆只是子集，不完整"，新增记忆检索规则；`MemoryListTool` 补充 promptSection；`buildMemorySection` 截断时提示"另有 N 条未显示，请主动 memoryList()"

### Fixed
- 修复换电脑/重装后记忆与配置丢失的问题（数据目录跟随程序）

## [0.6.8] - 2026-10-01

### Added
- **飞书 `/say <ID>` 切换会话**：手机可直接切回历史会话继续对话
  - `/list` 现在显示会话 ID 并提示用 `/say` 切换
  - `/say` 支持**完整 ID 或唯一前缀**（手机输入前几位即可）
  - 前缀不唯一时提示候选；找不到时提示用 `/list` 查看
  - 复用 provider 的 `sessionUrlBase` 拼会话 URL 并导航
  - 别名：`/switch`、`/to`


## [0.6.7] - 2026-09-30

### Fixed
- **飞书私聊无响应**：原逻辑用「chat_id 是否为空」区分群/单聊，但飞书**单聊也有 chat_id**，导致私聊消息被当成"未绑定的群消息"丢弃，只能在群里 @ 机器人
  - 改用 `message.chat_type` 区分：`p2p`（单聊）→ 回退最近活跃窗口；`group`（群聊）→ 按 chatId 精确路由到绑定窗口
  - `client.js` 新增 `extractChatType`，事件回调透传 chatType
- **私聊的 AI 回复串到群里**：AI 回复上报时只按"窗口绑定的群"推送，忽略消息来源，导致私聊提问的回复被发到群里
  - 新增来源记录 `lastFeishuSource`（per-profile）：记住最近一条飞书消息的来源（chatId + chatType）
  - `feishu-report` 推送目标改为 `resolveReportTarget`：**优先回来源**（私聊→私聊、群→群），无来源时才回退绑定群

## [0.6.4] - 2026-09-30

### Added
- **`/new` 自动建项目并注入能力**：手机发 `/new` 现在会
  1. 在**桌面新建项目文件夹**（默认名 `LingYa项目_时间戳`，可自定义：`/new 我的项目`）
  2. 导航到平台首页开新会话
  3. 自动注入完整初始化提示词（工具能力 + 项目目录上下文），让新对话**立即具备访问电脑的能力**（读写文件/执行命令/搜索等）

### Fixed
- **飞书斜杠命令在群里失效**：群里 @ 机器人时消息文本含 `@_user_1` 前缀（如 `@_user_1 /new`），导致 `startsWith('/')` 判断失败、命令被当普通文本转发给 AI
  - `extractText` 剥离 `@_user_N` 占位符与 `@机器人名`（依据 `msg.mentions`）
  - `handleFeishuCommand` 增加兜底：剥离行首残留 `@xxx`
  - 接收消息增加内容日志，便于排查

## [0.6.3] - 2026-09-30

### Added
- **飞书斜杠命令**：手机在飞书里可直接控制对话
  - `/new` — 开新对话（导航到当前平台首页，下一条消息进入新会话）
  - `/list` — 列出当前窗口的历史会话（含绑定的项目目录，标记当前会话）
  - `/stop` — 停止当前任务（中断 AI 生成 + kill 工具子进程 + 置停止标志，复用面板「停止」按钮同一逻辑）
  - `/help` — 显示可用指令
  - 命令在 `forwardUserMessage` 转发前拦截，不进入 AI 对话；未识别的 `/xxx` 回提示
  - 实现方式：走 provider 的 `homeUrl` 导航（跨平台通用，不依赖各平台"新对话按钮"选择器）

## [0.6.2] - 2026-09-30

### Added
- **飞书同步（手机收发对话）**：把手机变成 AI 的远程遥控器
  - 推送方向（LingYa → 飞书）：用户经 LingYa 发送的消息、AI 文本回复、工具调用状态（仅"调用中/完成"两条，默认不带工具名/参数/结果）
  - 接收方向（飞书 → LingYa）：手机发文本 → 转发到绑定的窗口 → 发给 AI（等同本机输入）
  - 连接方式：飞书官方 SDK 长连接（无需公网 IP、无需回调地址）
  - 覆盖层新增「📱 飞书」面板：App ID/Secret、启用开关、连接状态、群绑定下拉、推送选项
  - 多窗口路由：每个窗口 profile 可绑定一个飞书群，消息按群精确路由；未绑定的窗口不推送
  - 依赖：`@larksuiteoapi/node-sdk` ^1.74.0

### Changed
- `src/preload/dom/intercept-observer.js` 新增并导出 `onToolCall` / `emitToolCall`（工具调用 start/end 事件）
- `src/preload/dom/chat-input.js` 新增并导出 `onUserMessageSent`（用户消息发出回调）
- `profile-manager.js` profile 结构新增 `feishuChatId` / `feishuChatName` 字段

### Notes
- 飞书功能默认关闭，需在面板配置凭证并绑定群后启用
- 配置存储：`<userData>/feishu.json`

## [0.6.1] - 2026-09-27

### Added
- **自动续写**：DeepSeek 生成中途被中断（“对话已停止”）时，本地自动检测并发送“继续”，无需手动恢复
  - hook 层检测：SSE 流结束/断开时若未收到 FINISHED 状态，或收到 INTERRUPTED/BROKEN/FAILED 状态帧，即判定中断
  - preload 层处理：读安全配置后自动回传续写指令；中断内容不可信，其中的工具调用一律丢弃
  - 防无限循环：连续中断最多自动续写 5 次（2 分钟窗口），用户主动停止时不触发
  - 安全增强面板新增开关「自动续写」+ 可自定义续写指令文本

### Changed
- **发送延迟上限放宽**：`10000ms` → `600000ms`（10 分钟），支持设置 12000-15000ms 等更大间隔
  - template.js 的延迟输入框 max 属性、events.js 的保存校验同步放宽

### Tests
- 新增 test/main/security-store.test.js（6 用例）：自动续写配置默认值、更新、持久化、重置

## [0.6.0] - 2026-09-25

### Added
- **Agent 系统 + Plan/Build 双模式**（移植自 opencode）
  - 内置 build / plan 两个 agent，各有独立权限集与系统提示词 section
  - Home 页新增 Plan/Build 切换按钮，状态按窗口 profile 独立持久化（lingya-agents.json）
  - 系统提示词注入 {{AGENT_SECTION}}，并按当前 agent 过滤工具清单与使用指导
    （plan 模式下 write / edit / deleteFile 不再出现）
- **Plan 模式只读守卫（方案 B）**：拦截 shell 通道的写操作
  - 检测并拒绝：输出重定向（> / >>）、文件增删改（rm/cp/mv/mkdir/del/copy/move...）、
    PowerShell 写 cmdlet（Set-Content/Out-File/Remove-Item...）、git 写操作
    （add/commit/push...）、包安装（npm/pip install）、交互式编辑器等
  - 放行纯只读命令：ls/cat/dir/type/grep/find/git status/log/diff 等
  - 忽略 fd 合并（>&2）、null 设备（>nul）与 cmd 转义（^>）
- 执行层三重防线：工具调用（JsRunner / execute-tool）+ shell（BashTool / PwshTool）
  均按 agent 权限硬拒绝

### Changed
- ToolRegistry.getFormattedJsApiForPrompt / getFormattedPromptSections 支持按排除集过滤
- JsRunner.run 新增 options.deniedTools 与 options.readonlyShell
- 4 个平台提示词模板（deepseek/default/claude/chatgpt）加入 {{AGENT_SECTION}} 占位符

### Tests
- 新增 test/tools/agent.test.js（11 用例）：agent 定义、工具过滤、agent-store 持久化、
  执行层拒绝、只读守卫判定

## [0.5.1] - 2026-09-15

### Fixed
- 修复打包后系统提示词中 ts 代码围栏为空的问题：electron-builder 默认排除
  `*.d.ts` 不进 asar，导致 `tools/lingya-tools.d.ts` 缺失、`{{TOOL_API_TYPES}}`
  被替换为空。改用 `extraResources` 复制到 `resources/tools/`，运行时优先从
  `process.resourcesPath` 读取并回退到源码路径

## [0.5.0] - 2026-09-15

### Fixed
- 修复系统提示词中工具类型定义（lingya-tools.d.ts）注释里的 ``` 反引号破坏 ts 代码围栏的问题

## [0.4.0] - 2026-09-15

### Added
- **上下文压缩（手动 + 自动）**：当对话 token 过大时，生成摘要并只保留最近
  20% 对话，通过 DeepSeek 分享功能在新会话继续
  - 纯 API 实现：读 IndexedDB 全量消息，直接调用分享接口，不依赖 DOM 点击
  - 面板「压缩」按钮手动触发；「自动压缩」可配置阈值（默认 80 万 token）
  - 压缩后自动跳转新会话并初始化项目，末尾追加「请继续你之前的工作」

## [0.3.10] - 2026-09-14

### Fixed
- 修复选择平台时闪退：切换平台会先销毁旧窗口再重建，
  window-all-closed 期间窗口数短暂为 0 导致应用误退出
- 修复 userData 目录不存在时启动崩溃：app.setPath('userData') 前兜底创建目录

## [0.3.9] - 2026-09-14

### Added
- 面板显示 DeepSeek 服务端对话 token（读取 SSE 流的 accumulated_token_usage，
  过万自动简写为 x.xx万）

### Changed
- 彻底移除 DOM 抓取 AI 回复路径，仅保留网络请求拦截
  - 删除 observer / ai-response / detector 等 DOM 抓取模块
  - 抽出工具执行逻辑到 tool-executor，拦截与 DOM 共用
  - 手动解析改为复用拦截缓存文本，不再依赖 DOM
- 注释 provider 中已废弃的 DOM 抓取方法（isResponseComplete / getMessageCandidates /
  getMessageMarkdown / isUserMessage / getCodeBlockLanguage）
- 移除 token 本地估算，仅保留服务端权威数据

## [0.3.8] - 2026-09-11

### Changed
- **DeepSeek / Claude / ChatGPT 三个平台的 AI 回复获取，从 DOM 抓取改为网络请求拦截**
  - 在页面主世界（main world）注入拦截器，被动观察平台自身的 completion SSE 流，
    直接解析回复文本，不再依赖 MutationObserver + DOM 稳定性轮询
  - 仅旁路读取（response.clone / responseText 快照），不修改请求与响应
  - 正文提取区分并排除 THINK / reasoning 片段
  - DeepSeek：解析 response/fragments 的 THINK / RESPONSE 分片
  - Claude：解析 content_block_delta 的 text_delta（忽略 thinking_delta）
  - ChatGPT：解析 /backend-api/f/conversation 的裸 v 追加、patch 批量操作、
    message 快照（仅采纳 assistant）与 message/status 结束信号
  - 工具执行结果回传仍沿用原有模拟输入框发送方式

## [0.3.6] - 2026-09-08

### Fixed
- 添加标准编辑菜单，修复 macOS 无法在 DeepSeek 输入框复制/粘贴的问题

## [0.3.5] - 2026-09-08

### Fixed
- glob/grep 工具打包后 ripgrep ENOENT，通过 asarUnpack 解包二进制并修正运行路径
- 恢复 README 中 Codecov 覆盖率徽章

## [0.3.4] - 2026-09-07

### Fixed
- pwsh 工具改用 execFile，避免管道符被 cmd 预解析导致命令残缺
- 主窗口 UA 改为 Chrome 130 普通标识，避免 DeepSeek 提示隐私风险
- openBrowserWindow 工具窗口同步设置 Chrome 130 UA，不再暴露 Electron 标识
- XML invoke 检测不再要求必须位于文本开头，并避免提示语自触发循环
- 渲染进程可通过 --lingya-user-data 参数加载自定义 Provider

### Added
- Provider 发送扩展接口（provider.triggerSend），支持站点原生发送
- 流式稳定性双通道校验（mutation 快照 + interval 兜底）
- 完成检测兜底轮询（每 2s 主动复查），覆盖后台/最小化漏触发场景
- MCP 工具调用识别（await mcpXxx / log(await xxx））
- 无 pre 的 .md-code 代码容器兜底

### Changed
- 会话 ID 提取与跳转 URL 改为 Provider 方法，不再硬编码 DeepSeek 格式

## [0.3.0] - 2026-09-07

### Added
- 多平台 Provider 框架：支持 DeepSeek 与 Claude，按平台区分输入框/发送按钮/用户信息/消息解析
- 平台选择页：新窗口未指定平台时展示卡片式选择页（含官方品牌 logo）
- 提示词模板化：每平台独立模板，支持 `{{PLATFORM_INFO}}` `{{TOOL_API_TYPES}}` `{{TOOLS_LIST}}` `{{TOOL_SECTIONS}}` `{{PROJECT_DIR}}` `{{PROJECT_INTRO_SECTION}}` `{{MCP_SECTION}}` 占位符
- 自定义 Provider 功能：用户可通过平台选择页导入 JS 文件，支持复制到 userData、重名替换、删除前窗口占用检查
- 自定义 Provider 类型声明与模板：`src/providers/custom/provider.d.ts` + `provider.template.js`
- Provider 方法化：平台差异全部下沉到 Provider 方法（findInput/findSendButton/isResponseComplete/getMessageCandidates 等）
- Claude 自动解析：基于停止按钮边沿触发完成检测，跳过空消息，避免重复触发
- 按平台分文件记录渲染日志到 `wyp/log/{providerId}.log`
- 新增 Provider 单元测试

### Changed
- 系统提示词由单文件改为多平台模板，运行时按 providerId 选择并替换占位符
- 工具 API 类型定义从 `tools/lingya-tools.d.ts` 动态读取，避免多处维护
- 平台 logo 从首字母占位改为官方 SVG

### Fixed
- Claude 自动解析重复触发/漏触发问题
- 多个 `{{PROJECT_DIR}}` 占位符只替换第一个的问题
- 导入自定义 Provider 后源文件被删导致失效的问题

---

## [0.2.5-beta.1] - 2026-09-02

### Added
- 新增 MCP（Model Context Protocol）按需查询能力
  - mcpListServers() 查看已配置的 MCP server（名称/类型/状态/工具数/工具名）
  - mcpGetTools(serverName) 查看指定 server 的工具详情（描述+参数）
  - mcpCall(server, tool, args) 调用 MCP 工具
- MCP 启动时自动连接已启用的 server，初始化项目时等待连接（8 秒超时）
- MCP 配置保存前完整 JSON 结构校验（错误时明确提示且不覆盖输入）
- MCP 配置保存后弹确认框，由用户决定是否通知 AI（避免打断 AI 操作）
- showConfirmDialog 扩展支持确认/取消双按钮 + Promise 返回（向后兼容）
- 新增 McpCallTool、McpQueryTools 单元测试

### Changed
- MCP 提示词改为按需查看模式，不再全量注入工具列表（节省 token）
- MCP 保存后的自动通知改为简短格式，引导 AI 按需查询
- 移除 .lingyaCode/LINGYA.md 作为全局项目介绍（避免干扰其他项目场景）

### Fixed
- 修复 connectEnabledServers 从未被调用导致 MCP 启动后未连接的问题
- 修复 initProject 同步逻辑中 MCP 连接时序竞态（改为 async + 等待）

---

## [0.2.0] - 2026-08-27

### Breaking Changes
- 主进程重构：main.js 拆分为 src/main/ 模块（应用生命周期、IPC、项目上下文、会话存储分离）
- preload 重构：preload.js 拆分为 src/preload/ 模块（DOM 监测、overlay UI、工具解析分离）
- 移除 MySQLTool.js（已无维护，提示词中不再暴露）
- 移除旧版工具桥接实现（ToolBridge.js、UnifiedToolManager.js、WebContentCapturer.js）
- bash/pwsh 不再强制要求 description 参数（改为可选）

### Added
- 新增 5 个对标 dsh 的工具实现：
  - read（offset/limit 分段读取，替代 readFile）
  - write（全量覆盖，替代 writeFile）
  - edit（精确替换，替代 editFile）
  - glob（ripgrep 引擎，替代旧 GlobTool）
  - grep（ripgrep JSON 输出，替代旧 GrepTool）
- 新增 todoWrite 工具（全量任务列表，对标 dsh todo_write）
- 新增 pwsh 工具（PowerShell 执行，对标 dsh tool-pwsh）
- 新增 webFetch 工具（HTML 转 Markdown，对标 dsh web_fetch）
- 新增 openBrowserWindow / injectJS 工具（打开调试窗口并注入 JS）
- 工具系统支持 section 机制（对标 dsh systemPrompt.section），每个工具有独立的 prompt section
- 系统提示词全面改版：中文 dsh 风格 + 动态平台检测（Windows/macOS/Linux）
- 发送延迟可配置（UI 设置 + localStorage 持久化）
- UI 全面改版：悬浮球模式（48px 右下角 FAB + 小面板），不再占用全高侧边栏
- 跨平台启动脚本 start.js（Windows/macOS/Linux 通用）
- 完整单元测试覆盖（tools / main / preload）

### Changed
- package.json start 脚本改为 node start.js（修复 macOS chcp: command not found）
- start.js 自动根据平台选择 UTF-8 编码设置
- 工具返回格式统一为 dsh 风格（纯文本 envelope / marker）
- 错误提示统一为英文 dsh 风格
- package.json 增加 allowScripts 配置（npm 新版本 electron postinstall 被阻止问题）

### Fixed
- edit 工具 CRLF 适配（LF 的 old_string 能匹配 CRLF 文件）
- bash/pwsh 非零退出不再报错，改用 [exit code: N] 标记
- glob 路径去掉 ./ 前缀
- Windows 平台信息动态生成（不再硬编码）
- Electron postinstall 被 npm allowScripts 阻止导致二进制缺失的问题
- JS 脚本无输出时提示使用 log()

### Security
- bash/pwsh 危险命令黑名单保留（Windows + PowerShell 特有命令）
- 命令执行超时限制保持 30 秒
- 输出缓冲 1MB 限制保持

### Dependencies
- 新增 @vscode/ripgrep（glob/grep 底层引擎）
- 新增 turndown + @joplin/turndown-plugin-gfm（webFetch HTML 转 Markdown）

---

## [1.0.0] - 2026-08-11

### Added
- 初始版本发布
- Electron 桌面应用，嵌入 DeepSeek 网页版
- 自动检测 AI 回复中的 cmd/powershell 代码块，弹窗确认后执行
- 工具调用系统：支持 file_write、file_read、file_edit、file_glob、file_grep、bash、file_delete 等工具
- 会话级项目目录绑定，工具操作以项目目录为基础
- 侧边覆盖层面板，显示命令预览、执行结果和历史记录
- Ctrl+Shift+C 快捷键切换覆盖层
- 项目初始化功能，自动生成目录树并注入系统提示词
- 支持危险命令检测与额外警告
- 会话持久化（cookies/localStorage 保存到 %APPDATA%/lingya-session）

### Security
- 命令执行前必须用户确认
- 危险命令（rm -rf /、format、shutdown 等）触发额外警告
- 30 秒命令执行超时限制
- 1MB 命令输出缓冲区限制

