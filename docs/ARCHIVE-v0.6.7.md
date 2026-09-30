# LingYa v0.6.7 — 阶段归档

> 归档日期：2026-09-30
> 版本：**0.6.7**
> 仓库：https://github.com/cymylive/lingya
> 提交：`874ae45`
> Release：https://github.com/cymylive/lingya/releases/tag/v0.6.7

---

## 一、本批交付：飞书同步（手机收发对话）

让手机通过飞书远程指挥电脑上的 AI，无需公网 IP（官方 SDK 长连接）。

**核心链路**

```
【收】手机飞书发消息 → 长连接 → 主进程 forwardUserMessage → 绑定窗口 → sendToChat 发给 AI
【推】AI 回复/工具状态 → feishu-report → 按来源推回飞书
```

## 二、版本演进

| 版本 | 内容 |
|------|------|
| v0.6.2 | 飞书同步首次落地：推送用户消息/AI 回复/工具状态；接收手机消息 |
| v0.6.3 | 斜杠命令 `/new` `/list` `/help` |
| v0.6.7 | 修复私聊收发；`/new` 建项目+注入能力；`/stop`；群 @ 提及剥离 |

## 三、关键设计

### 1. 消息路由（群 / 单聊）

- 用 `message.chat_type` 区分：`group`（群聊）/ `p2p`（单聊）
- **群聊**：按 profile 绑定的 `feishuChatId` 精确路由到对应窗口
- **单聊**：回退最近活跃窗口（`getMainContext`）
- ⚠️ 坑：飞书**单聊也有 chat_id**，不能用 chat_id 是否为空区分群/单聊

### 2. 回复推送目标（回来源）

- `resolveReportTarget(ctx)`：优先回「最近一条飞书消息的来源」，无来源才回退绑定群
- 来源记录：`lastFeishuSource`（per-profile Map），在 `forwardUserMessage` 里写入
- 目的：避免私聊提问的回复被串到群里

### 3. @ 提及剥离

- 群里 @ 机器人时 `content.text` 含 `@_user_N` 前缀（如 `@_user_1 /new`）
- `extractText` 用 `stripMentions` 剥离；`handleFeishuCommand` 兜底剥离行首 @

### 4. 手机指令集

| 指令 | 作用 |
|------|------|
| `/new [项目名]` | 桌面新建项目文件夹 + 导航开新会话 + 注入完整提示词（AI 可访问电脑） |
| `/list` | 列出当前窗口历史会话（标记当前会话） |
| `/stop` | 停止当前任务（中断生成 + kill 工具子进程 + 置停止标志） |
| `/help` | 显示指令帮助 |

### 5. 推送内容与开关

- 推送：用户消息 / AI 回复 / 工具状态（tool-start、tool-end）
- 配置开关：`pushUserMessage` / `pushAiReply` / `pushToolStatus` / `pushToolName`
- 工具状态默认**不带工具名**（隐私）

## 四、已知限制

- **飞书文件消息单文件上限 30MB**：79MB 的 portable exe 无法作为文件发送，只能发下载链接
- 流式推送未实现（只推最终回复）
- 多窗口路由：群消息按 chatId 精确路由；单聊回退最近活跃窗口

## 五、文件清单

### 新增

| 文件 | 职责 |
|------|------|
| `src/feishu/config.js` | 配置读写 `<userData>/feishu.json` |
| `src/feishu/client.js` | SDK 封装：长连接 + 收发 + 群列表 + 状态机 |
| `src/main/feishu-ipc.js` | IPC + 消息路由 + 命令处理 + 推送 |
| `src/preload/dom/feishu-bridge.js` | 上报钩子 + 接收飞书消息 |
| `src/preload/overlay/feishu-panel.js` | 覆盖层「飞书」面板 UI |

### 改动

| 文件 | 改动 |
|------|------|
| `src/main/index.js` | 初始化飞书配置存储 + 启动时自动连接 |
| `src/main/ipc.js` | 注册飞书 IPC |
| `src/main/profile-manager.js` | profile 加 `feishuChatId`/`feishuChatName` + 两个函数 |
| `src/preload/api.js` | 暴露飞书 API + 事件监听器 |
| `src/preload/index.js` | 启动飞书 bridge |
| `src/preload/dom/intercept-observer.js` | 新增导出 `onToolCall` / `emitToolCall` |
| `src/preload/dom/chat-input.js` | 新增导出 `onUserMessageSent` |
| `src/preload/overlay/template.js` | 飞书按钮 + 面板 HTML + CSS |
| `src/preload/overlay/events.js` | 绑定飞书面板事件 |
| `package.json` | 依赖 `@larksuiteoapi/node-sdk` ^1.74.0 |

---

## 六、构建与发布

- 本地打包：`npm run build:win:portable:local` → `dist/lingya-win-v0.6.7-portable.exe`（约 75MB）
- 发布：Python + GitHub API 打 tag / 建 Release / 传附件（git push 推 tag 有 TLS 抖动）
- 源码归档：`lingya-src-v0.6.7.zip`（约 697KB，排除 node_modules/dist/.git）
