# LingYa v0.6.28 — 阶段归档

> 归档日期：2026-10-12
> 版本：**0.6.28**
> 仓库：https://github.com/cymylive/lingya
> 提交：工作区未提交（上一提交 c3c7c62 = v0.6.26）
> 产物：dist/lingya-win-v0.6.28-portable.exe（83.4 MB）

---

## 一、本批交付

自 fork 以来**最大的一次架构改造** —— 从「单 BrowserWindow + 注入覆盖层」升级为「壳窗口 + WebContentsView 双视图」，并在此基础上移植了 cuckoo-code 的完整文件树 UI。

### 1. 架构改造：壳窗口 + WebContentsView 双视图（C 方案）

将 AI 网页从「壳窗口的一部分」拆为**独立的 WebContentsView**：

    [ BrowserWindow（壳） ]
      ├── 左侧栏（activitybar + 文件树 + 预览）   ← shell.html
      └── [ WebContentsView（AI 网页） ]           ← 平台页面 + 注入覆盖层

- 两者是**不同的 webContents**（实测 id=1 vs id=3），互不干扰
- 展开侧栏：窗口宽 +侧栏宽，AI view 右移等量 → **AI 可用宽度恒定不变**
- 收起侧栏：保留 **46px activitybar**（不再是全消失）
- 侧栏宽度可拖拽（240~640px）

**核心文件**：src/ui/shell.html、src/preload/shell-preload.js、src/preload/shell-renderer.js

### 2. 左侧栏文件树（照搬 cuckoo-code）

移植 cuckoo files.ts + preview.ts 的完整实现：

| 功能 | 说明 |
|------|------|
| **语言角标** | TS/JS/PY/C+/C#/>_ 等圆角小方块（VSCode Seti 风） |
| **SVG 图标** | 文件夹 / caret / 文件 / 图片，全矢量 |
| **搜索高亮** | mark 标签高亮匹配词 + 显示完整路径（防抖 150ms） |
| **分栏预览** | 左树右预览，点文件看内容 + 文件大小 |
| **目录折叠** | caret 旋转 90°（VSCode 风） |
| **选择目录** | 头部按钮，调系统目录选择框 |
| **背景色自定义** | 取色器 + 10 预设色板 + 恢复默认 |

**主进程**：src/main/file-tree.js（递归构建，忽略 node_modules/.git/dist 等 30+ 目录，节点上限 5000、深度上限 12）+ IPC get-file-tree / read-file-preview（**路径越权防护**：realpathSync 后校验前缀；限 512KB）

### 3. 深色 / 浅色主题切换

- 主页「快捷操作」新增「主题」按钮（月亮/太阳）
- 浅色主题用 html.lingya-theme-light 覆盖全套 CSS 变量（16 项）
- 40+ 处硬编码颜色替换为 var(--ck-*)
- 侧栏（shell.html）与 AI 页面（覆盖层）共用 localStorage['lingya-theme']

### 4. 窗口 / 侧栏状态持久化

| 项 | 存储 |
|------|------|
| 窗口位置/大小 | profile-list.json → windowBounds（归一化为「收起态」宽） |
| 侧栏开合 | localStorage['lingya-sidebar-open'] |
| 侧栏宽度 | localStorage['lingya-sidebar-width'] |
| 侧栏背景色 | localStorage['lingya-sidebar-bg'] |
| 主题 | localStorage['lingya-theme'] |

### 5. 技能渐进式披露

修复技能注入的顺序截断：原先 119 个技能**只装得进 2 个**（超 4000 token 即 break），改为「索引（name + 首句描述 + 路径）+ 按需 read 全文」。

- 实测：可见技能 **2 → 119**（全覆盖）
- 注入体积 2716 → 5024 tokens（对比全文注入 248425 tokens 省约 50 倍）

### 6. 导出对话为 Markdown

会话面板新增「导出对话 (.md)」按钮。

- 背景：LingYa 不持久化对话内容，网页 IndexedDB 也只有 message_id 元数据
- 三来源累积：AI 回复 / LingYa 发送的用户消息 / 用户手动发送（hook 从请求体提取）
- 含元信息（时间/平台/会话链接/项目目录/消息数），默认剥离工具代码块

### 7. todo 单项即时同步

要求 AI 每完成一项就立刻单独调用一次 todoWrite，**禁止攒批**（此前会做完 2-3 项才更新，计划面板长时间停在同一项）。

### 8. 限流防护移除

0.6.26 引入的限流防护（rate-limiter / 429 检测 / 冷却倒计时 UI）**按用户要求整体删除**。对话导出功能不受影响。

---

## 二、版本演进（0.6.24 → 0.6.28）

| 版本 | 内容 | 发布 |
|------|------|------|
| v0.6.24 | 基线 | 已发 |
| v0.6.25 | 修复 portable 版乱码（resources.pak 缺失 → style,script{display:none} 兜底） | 已发 |
| v0.6.26 | 技能渐进式披露 + 限流防护三层 + 对话导出 | 已发 |
| v0.6.27 | （限流移除 + bug 修复，未发布） | — |
| v0.6.28 | **双视图架构 + 文件树 + 主题 + 持久化** | 待发 |

---

## 三、关键设计

### 1. Proxy 兼容层（85 处旧调用零改动）

ctx.win 用 Proxy 代理 BrowserWindow，.webContents/.loadURL/.loadFile 自动转发到 AI view：

    const winProxy = new Proxy(mainWindow, {
      get(target, prop) {
        if (prop === '__rawWindow') return target;          // 真实窗口（关键！）
        if (prop === 'webContents') return aiView.webContents;
        if (prop === 'loadURL') return (u,o) => aiView.webContents.loadURL(u,o);
        if (prop === 'loadFile') return (f,o) => aiView.webContents.loadFile(f,o);
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

⚠️ **必须保留 rawWin 入口** —— 见「踩坑」第 1 条。

### 2. 窗口宽 = AI 基准宽 + 侧栏宽

    __lingyaAiWidth           // AI 网页应有宽度（不含侧栏）
    当前侧栏宽 = open ? width : 46
    窗口宽 = __lingyaAiWidth + 当前侧栏宽

**数学自洽**：侧栏开合触发的 setBounds 也走 resize 同步 → aiW = (aiW+sw) - sw = aiW（不漂移）；用户手动调整 → aiW 跟随。

### 3. 保存时归一化为「收起态」宽

    const aiW = __lingyaAiWidth || (b.width - curSw);
    const normWidth = aiW + 46;   // 统一按收起态存

用 __lingyaAiWidth 而非 b.width - curSw：屏幕装不下时 setBounds 会被 clamp 污染基准。

---

## 四、踩坑与修复（本批 7 个 bug）

### 1. 【致命】壳页面 IPC 找不到上下文

**症状**：点文件树按钮无反应、文件树永远「尚未选择项目目录」、侧栏展开窗口不变宽。

**根因**：getContextByWebContents(event.sender) 返回 null。ctx.win 是 Proxy，其 .webContents 指向 **AI view**（id=3），而壳页面 IPC 的 event.sender 是**真实窗口**（id=1）→ 两边都匹配不上。

**修复**：addWindow 存 rawWin（Proxy 的 target），getContextByWebContents 优先匹配它：

    if (ctx.rawWin && ctx.rawWin.webContents === webContents) return ctx;

**验证**：CDP 直连实测 toggleSidebar 从 {"success":false,"error":"窗口不存在"} 变为 {"success":true,"windowWidth":1536}。

### 2. 【致命】窗口大小不保存（__lingyaAiWidth 从不更新）

**根因**：__lingyaAiWidth 只在首次 toggleSidebar 算一次，用户手动调窗口后仍用陈旧值 → 存回旧值。

**修复**：resize 事件同步更新基准宽。

### 3. AI view 从 x=0 开始 → 完全盖住 46px activitybar

WebContentsView 默认叠在壳之上。修复：AI view 永远从侧栏宽度之后开始。

### 4. 冷启动误缩窗口

renderer 初始化无条件调 toggleSidebar(false)，主进程回退成 cur.width-320。修复：applyState(notify)，初始化时不通知主进程。

### 5. 文件树按钮没绑事件

renderer 只绑了 sh-ab-collapse。修复：遍历 .sh-ab-item[data-tab] 绑点击。

### 6. :root 自引用（--ck-bg: var(--ck-bg)）

批量颜色替换时误伤定义块 → 所有主题变量失效。修复：排除定义块。

### 7. 对话导出跨来源重复

同一条消息来自 onUserMessageSent 和 lingya-user-message。修复：单向包含去重（**不做双向** —— 否则「帮我看看代码」与「…里的 bug」会被误判）。

---

## 五、已知限制

- 文件树**只读**（改文件仍由 AI 的 write/edit 工具完成）
- 未引入 monaco-editor（预览用 pre 纯文本，避免 +60MB 依赖）
- 大屏不足时窗口加宽会被屏幕工作区 clamp（AI 宽度会略缩）
- 0.6.28 尚未打 tag / 发布 Release

---

## 六、文件清单

### 新增（5）

| 文件 | 职责 |
|------|------|
| src/ui/shell.html | 壳页面：左侧栏 UI（activitybar + 文件树 + 预览 + 背景色面板） |
| src/preload/shell-preload.js | 壳 preload：contextBridge 暴露 shellAPI |
| src/preload/shell-renderer.js | 壳渲染：文件树 + 预览 + 拖拽 + 主题 + 目录选择 + 背景色 |
| src/main/file-tree.js | 递归构建目录树（忽略规则 + 节点/深度上限） |
| src/preload/overlay/file-tree-panel.js | 覆盖层侧栏（已弃用，保留 initThemeOnly） |

### 删除（2）

| 文件 | 原因 |
|------|------|
| src/preload/dom/rate-limiter.js | 限流防护整体移除 |
| test/preload/rate-limiter.test.js | 同上 |

### 改动（21）

| 文件 | 改动 |
|------|------|
| src/main/index.js | createWindow 重写（壳+view）、Proxy 兼容层、layout、侧栏 IPC、持久化归一化 |
| src/main/window.js | 加 view/rawWin 字段 + setWindowView/getView/getViewWebContents |
| src/main/ipc.js | 加 get-file-tree/read-file-preview/shell-choose-dir/shell-get-dir/conversation-export-md |
| src/preload/api.js | 加 getFileTree/readFilePreview/conversationExportMd/sidebarResizeWindow |
| src/preload/overlay/template.js | 主题变量 + 主题按钮；移除覆盖层内旧侧栏 |
| src/preload/overlay/ui.js | 主题状态；移除限流 UI |
| src/preload/overlay/events.js | 主题初始化；导出对话按钮绑定 |
| src/preload/dom/conversation-log.js | 跨来源去重 |
| src/preload/dom/chat-input.js | 移除限流等待 |
| src/preload/index.js | 对话记录初始化；移除限流接入 |
| src/providers/deepseek.js | 移除限流检测；加 dispatchUserMessage（对话导出） |
| src/prompt/*.md x4 | 技能「按需 read」规则 + todo 单项同步 |
| tools/TodoWriteTool.js | 单项即时同步规则 |
| tools/lingya-tools.d.ts | 同步声明 |
| test/preload/conversation-log.test.js | 加 5 个去重用例 |
| CHANGELOG.md / package.json / package-lock.json | 版本 0.6.28 |

---

## 七、构建与发布

    set "PATH=D:\NodeJS;%PATH%"
    cd /d "C:\Users\cymylive\Desktop\lingya-0.6.24"
    npm run build:win:local

产物：dist/lingya-win-v0.6.28.exe（NSIS）/ -portable.exe / -x64.zip

**发布前须**（参考 0.6.25/0.6.26 经验）：
1. git add -A && git commit
2. push main（TLS 高发失败，循环重试 5-10 次）
3. git tag v0.6.28 && git push（触发 CI）
4. CI 只建 **draft Release** → 需手动 PATCH draft:false

---

## 八、测试

- 全量单元测试：**340 / 340 通过**
- Electron 端到端：双视图 / 文件树 / 主题 / 持久化 / 目录选择 / 背景色（均已实测）
