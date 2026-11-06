# Tasks: 手机远程控制（Remote Mobile Control）

> **目标**：把灵鸦现有 remote 从"最小可运行"补齐到与 Cuckoo Code **功能对等**。
> **基准**：Cuckoo `src/remote/`（TS）+ `pwa/`（JS）
> **现有**：灵鸦 `src/main/remote/` 骨架 + `remote-ipc.js` + pwa 最小版
> **范围**：只做 PWA（手机浏览器 / 添加到主屏）；APK 独立 spec
> **协议**：整体对齐 Cuckoo（`ai-stream` + `reset` 语义 / `ai-start` / `ai-stop` / `history` / `profiles`）

---

## 差异矩阵（开工前盘点，已确认）

| 模块 | 灵鸦现状 | Cuckoo | 处理 |
|---|---|---|---|
| `remote/config.js` | 136 行 | 142 行 | **保留**，微调 |
| `remote/server.js` | 384 行，`stream` 协议 | 384 行，`ai-stream` 协议 | **改协议** |
| `remote/tunnel.js` | 391 行，额外 DNS/edge | 339 行 | **保留**（灵鸦更完善） |
| `remote/manager.js` | 190 行 | ~500 行 | **整体重写** |
| `remote-ipc.js` | 167 行 | 无独立文件 | **补齐** |
| `pwa/index.html` | 35 行 | ~200 行 | **重写** |
| `pwa/app.js` | 268 行 | ~1000 行 | **重写** |
| `pwa/style.css` | 28 行 | ~1500 行 | **重写** |
| `pwa/mobile-pet.js` | 77 行 | ~200 行 | **重写** |
| `pwa/mobile-pet.css` | 15 行 | ~200 行 | **重写** |

---

## 协议规范（实现前锚定，所有模块以此为准）

### 电脑 → 手机
| type | 字段 | 说明 |
|---|---|---|
| `profiles` | `{ profiles: [{id,name,busy}], currentProfileId }` | 窗口列表 |
| `history` | `{ profileId, history: [{t,text}] }` | 最近 40 条 user/assistant/system |
| `ai-start` | `{ profileId }` | 新一轮流式开始 |
| `ai-stream` | `{ profileId, thinkDelta, textDelta, reset }` | 流式增量；reset=true 时手机清空重来 |
| `tool` | `{ profileId, name, at, ended? }` | 工具开始/结束 |
| `ai-reply` | `{ profileId, text }` | 完整回复 |
| `ai-stop` | `{ profileId, reason: 'user'\|'watchdog' }` | 停止 |
| `ai-error` | `{ profileId, text }` | 错误 |
| `sys` | `{ profileId?, text, keepBusy? }` | 系统提示 |

### 手机 → 电脑
| type | 字段 |
|---|---|
| `auth` | `{ clientId }`（token 走 subprotocol / header） |
| `ping` | `{}` |
| `user-message` | `{ text }` |
| `stop` | `{}` |
| `select-profile` | `{ profileId }` |
| `clear` | `{}` |

---

## T1: server.js 广播协议对齐

**Files:** `src/main/remote/server.js`
**Test:** `test/main/remote-server.test.js`

- [ ] Step 1: 把内部 `broadcast` 的 type 白名单改为上表 9 种（`stream` 删除，`ai-stream` 加入）
- [ ] Step 2: 心跳 pong 逻辑确认（30s）
- [ ] Step 3: 单条消息 >2MB、文本 >10 万字符拒绝（现有，确认）
- [ ] Step 4: 路径穿越 `/../` 返回 403（现有，确认）
- [ ] Step 5: `Sec-WebSocket-Protocol: cuckoo.<token>` 兼容保留（现有），新增 `lingya.<token>` 也识别
- [ ] Step 6: 跑 `npm test`

**验证**：单测覆盖上述 6 点；`curl -H "Authorization: Bearer <token>" http://127.0.0.1:7799/api/ping` 返回 200。

---

## T2: manager.js 整体重写（对齐 Cuckoo manager.ts）

**Files:** `src/main/remote/manager.js`（整体重写，约 500 行）
**Test:** `test/main/remote-manager.test.js`

**依赖的灵鸦现有导出**（读而不改）：
- `window.js`：`getAllContexts` / `getMainContext` / `getWindowByProfileId` / `getContextByWebContents` / `isGenerating(pid)`
- `generation-state.js`：`get(wcId)` → `{ generating }`
- `profile-manager.js`：`getProfileById(pid)`
- `subagent.js`：`hasRunningSubagent(pid)`（若无此导出，用等价判断替代，在 step 1 补一个最小封装）
- `app/ipc/harness.js`：`stopGeneration(ctx)`（若无，用 `lingya-stop-task` IPC 兜底）
- `app/ipc/window-groups.js`：`requestHarnessExport(winId, timeoutMs)`（若无，step 1 补一个最小封装，超时回空 history）

**Steps:**

- [ ] **Step 1: 依赖映射** —— 逐项确认上述 6 个依赖是否存在；缺失的写最小适配封装（不新建大模块，放在 manager.js 内部或就近小工具里）
- [ ] **Step 2: 写失败测试** —— 覆盖：
  - `getTargetContext()` 在 profileId 失效时回退最近活跃
  - `markBusy` TTL 10s 过期
  - 子代理运行中拒收消息
  - 流式节流 30ms（连续 push 只广播一次）
  - 前缀不匹配触发 `reset: true` 且两个字段都发全量
  - profileId 隔离（A 的消息不广播给 B 的订阅者）
  - busyWatchdog：网页 `isGenerating=false` + 静默 >8s → 主动 `ai-stop(watchdog)`
  - `pushHistoryToNewClient` 先于 `pushActiveStreams` 执行
- [ ] **Step 3: 实现 manager.js** —— 结构照 Cuckoo `manager.ts`：
  - `streamStates: Map<profileId, StreamState>`（`text/sent/think/thinkSent/timer/active/toolCount/lastAt/toolLastAt`）
  - `busyProfiles: Map<profileId, ts>`（TTL 10s）+ `windowState.isGenerating` 双保险
  - `onPhoneMessage`：目标窗口失效 → 广播 `sys`；子代理运行 → 拒绝；忙态 → 拒绝；否则 `markBusy` + `view.webContents.send('remote-user-message', { text })`
  - `onPhoneStop`：调 `stopGeneration(ctx)`，成功后 `onAiStop(pid)`
  - `onAiStream(text, think, profileId)`：全量快照覆盖 + 30ms 节流
  - `flushStream(profileId)`：前缀校验决定 `reset`
  - `onAiReply` / `onAiStop` / `onAiError`：先 flush 尾帧再清空
  - `busyWatchdogTick`：3s 间隔，8s stale / 300s tool stale
  - `pushHistoryToNewClient(ws)`：`requestHarnessExport(winId, 300)`，过滤 user/assistant/system，取最近 40
  - `pushActiveStreamsToNewClient(ws)`：补活跃流，标记 sent=text
  - `listProfilesForRemote()` / `selectProfile()` / `cleanupStreamState()`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 关键适配校验** —— 必须用 `view.webContents.id` 作为生成态 key（灵鸦的 `generation-state` 语义）
- [ ] **Step 6: 手工验证** —— 电脑 AI 生成一段长回复，手机登录后能看到流式 + reset 正常（工具块剔除后不重复）

**验证**：单测全绿；手工流式不重复、不乱序。

---

## T3: remote-ipc.js 补齐

**Files:** `src/main/remote-ipc.js`
**Test:** `test/main/remote-ipc.test.js`

- [ ] Step 1: 确认现有 8 个 IPC 通道齐全：`remote-status` / `remote-set-enabled` / `remote-set-config` / `remote-reset-token` / `remote-start-tunnel` / `remote-stop-tunnel` / `remote-list-clients` / `remote-kick-all`
- [ ] Step 2: 新增 `remote-ai-event`（preload → 主进程，用于 AI 页面事件上报，见 T4）
- [ ] Step 3: 确认 `initRemoteOnBoot()` 在 `enabled=true` 时自动启动，`tunnelEnabled` 时自动拉隧道
- [ ] Step 4: 确认 `app.on('will-quit')` 或 `before-quit` 调 `stopRemote()` + `stopTunnel()`
- [ ] Step 5: 跑测试

---

## T4: preload 侧 AI 事件上报补全

**Files:** 确认现有 AI 页面 bridge 是否已上报 stream/tool/stop/error
- 若无：新增 `src/preload/dom/remote-bridge.js`（**不新建大模块，最小挂载**）
- 若有（如 `feishu-bridge.js` 已在报流式）：复用，改成同时喂 remote

- [ ] Step 1: 盘点现有上报链路（`feishu-bridge.js` / `qq` / `weixin` 三通道已上报什么事件）
- [ ] Step 2: 决定是"复用现有上报"还是"新增 remote-bridge"
- [ ] Step 3: 确保 AI 页面收到 `remote-user-message` 后：填输入框 → 触发发送 → 开始流式上报
- [ ] Step 4: 确保 AI 页面收到 `lingya-stop-task` 后正确停止
- [ ] Step 5: 手工验证：手机发消息 → 电脑 AI 收到 → 流式回到手机

**注意**：现有 manager.js 用 `qq-user-message` 通道，T2 重写后改为专用 `remote-user-message`，需要 AI 页面端同步加监听。

---

## T5: PWA index.html 重写

**Files:** `src/main/remote/pwa/index.html`
**基准：** Cuckoo `src/remote/pwa/index.html`

- [ ] Step 1: 完整登录层（logo + 地址输入 + Token 输入 + 粘贴按钮 + 连接按钮）
- [ ] Step 2: 完整对话层（顶部栏：连接状态 + 窗口选择器 + 主题切换 + 断开；消息区：空态 + 流式气泡 + 工具卡片；底部：输入框 + 发送/停止 + 回到底部 + 新消息徽章）
- [ ] Step 3: SVG 图标精灵（单线图标，灵鸦主题）
- [ ] Step 4: manifest 引用 + PWA meta（standalone / apple-mobile-web-app-capable / theme-color=#2dd4bf）
- [ ] Step 5: 手工浏览器打开验收

---

## T6: PWA style.css 重写

**Files:** `src/main/remote/pwa/style.css`
**基准：** Cuckoo `src/remote/pwa/style.css`

- [ ] Step 1: 灵鸦主题变量（`--bg` / `--text` / `--accent: #2dd4bf` / `--dim` / `--border` 等，深浅两套）
- [ ] Step 2: 登录页样式
- [ ] Step 3: 对话页样式（顶部栏 / 消息气泡 user/assistant/system/tool / 流式光标 / 代码块 / 表格 / 引用块 / 输入区 / 断线横幅 / 连接徽章）
- [ ] Step 4: 响应式（安全区 `env(safe-area-inset-bottom)` / 横竖屏）
- [ ] Step 5: 手工验收

---

## T7: PWA app.js 重写（最核心）

**Files:** `src/main/remote/pwa/app.js`
**基准：** Cuckoo `src/remote/pwa/app.js`（~1000 行）

- [ ] Step 1: 状态与存储（`lingya-remote-token` / `lingya-remote-addr` / `lingya-remote-draft` / `lingya-client-id`）
- [ ] Step 2: 地址规范化（补 http://、去尾斜杠、去误粘的 `/#/ws`）+ Capacitor 原生检测
- [ ] Step 3: 连接管理（`/api/ping` 验证 → `ws://.../ws`，`Sec-WebSocket-Protocol: lingya.<token>`，指数退避，3s 防抖，8s 启动看门狗，心跳 pong，切前台探活）
- [ ] Step 4: 消息收（`profiles` / `history` / `ai-start` / `ai-stream` / `tool` / `ai-reply` / `ai-stop` / `ai-error` / `sys`）
- [ ] Step 5: 消息发（`auth` / `ping` / `user-message` / `stop` / `select-profile` / `clear`）+ 离线队列（上限 50）
- [ ] Step 6: 流式渲染（增量 + reset 语义；正文气泡 + 思考折叠；Markdown 用 `marked`，代码块高亮 + 复制按钮；XSS 消毒）
- [ ] Step 7: 工具计时器（`lastTickAt` + `visibilitychange` 冻结补偿）
- [ ] Step 8: 多窗口选择器（渲染 `profiles`，切换发 `select-profile`，切换后清屏 + 等 `history`）
- [ ] Step 9: 停止按钮（生成中显示「停止」，点后发 `stop`，收到 `ai-stop` 恢复）
- [ ] Step 10: 界面细节（回到底部、新消息徽章、草稿持久化、深浅主题切换、连接状态徽章、断线横幅、空态）
- [ ] Step 11: 桌宠接线（`window.LingyaPet.setState` + 状态映射 thinking/working/waiting/idle/done/error）
- [ ] Step 12: 手工验收（见 T12）

**约束**：`marked` 从 `/vendor/marked.umd.js` 加载（构建时拷到 PWA 目录，或内联）。如无此依赖，用 `renderMarkdown` 最小实现（粗体/代码/链接/换行）。

---

## T8: mobile-pet 重写

**Files:** `src/main/remote/pwa/mobile-pet.js` / `mobile-pet.css`

- [ ] Step 1: 状态映射（thinking/working/waiting/idle/done/error）
- [ ] Step 2: 64px 固定尺寸 + `clampXForHost` + `onMove` 持久化位置（`lingya-pet-x`）
- [ ] Step 3: 样式覆盖（`touch-action: pan-y` 手势、`width: max-content` 气泡换行）
- [ ] Step 4: 防腐（引擎加载失败静默降级，不影响对话）
- [ ] Step 5: 手工验收（状态切换 + 横向拖动记忆 + 竖向滑动页面正常滚动）

---

## T9: 桌面设置面板确认

**Files:** `src/preload/toolbar-renderer.js`（现有已有 remote 面板，确认完整度）

- [ ] Step 1: 对照 spec FR-049~052 逐条核对
  - 开关 / 端口 / 令牌展示 + 复制 + 重置 / 公网地址（可复制） / 隧道开关 + 状态 + 错误 / 已连接设备列表 + 断开全部
- [ ] Step 2: 补齐缺失项（如"局域网地址显示"）
- [ ] Step 3: 非 Windows 平台置灰
- [ ] Step 4: 手工验收

**约束**：不改任何现有元素 id，新增元素 id 一律 `remote-` 前缀。

---

## T10: package.json extraResources 确认

**Files:** `package.json`

- [ ] Step 1: 确认 `{ from: 'resources/cloudflared', to: 'cloudflared' }` 存在
- [ ] Step 2: 确认 `{ from: 'src/main/remote/pwa', to: 'remote-pwa' }` 存在（若无则加）
- [ ] Step 3: 确认 `resources/cloudflared/cloudflared.exe` 存在（若无，提示用户下载）
- [ ] Step 4: 确认 `tunnel.js` 打包后能通过 `process.resourcesPath` 找到 cloudflared

---

## T11: 全量回归

- [ ] Step 1: `npm test` 全绿（基准 1110 用例不回归）
- [ ] Step 2: 未启用 remote 时桌面行为与改动前完全一致（不常驻定时器、不预留端口）
- [ ] Step 3: `netstat -ano | findstr :7799` 应用退出后无残留
- [ ] Step 4: `tasklist | findstr cloudflared` 应用退出后无残留

---

## T12: 手工验收清单（用户执行）

**桌面端**
- [ ] 打开「设置 → 手机远程」，开关可切换
- [ ] 令牌可复制/重置
- [ ] 局域网地址显示可复制
- [ ] 打开「公网访问」，拿到 `https://xxx.trycloudflare.com`
- [ ] 已连接设备列表显示 IP/UA

**手机端（浏览器）**
- [ ] 打开隧道 URL 能看到登录页，无令牌时看不到任何对话
- [ ] 输入错误令牌提示错误，停留登录页
- [ ] 输入正确令牌进入对话页，看到历史消息
- [ ] 电脑 AI 生成中，手机流式文字逐段出现，**不重复、不乱序**
- [ ] 工具执行时顶部胶囊显示工具名 + 秒数递增
- [ ] 手机发消息 → 电脑 AI 收到 → 回复流到手机
- [ ] AI 生成中点「停止」→ 电脑 2s 内停止
- [ ] 多窗口切换：只看到目标窗口内容，不串台
- [ ] 断网 → 出现断线横幅 → 恢复 → 3s 内重连不闪「已离线」
- [ ] 断线期间发的消息重连后补发
- [ ] 刷新页面草稿还在
- [ ] 深色/浅色主题切换
- [ ] 桌宠随状态切换、横向拖动记忆位置、竖向滑动页面正常滚动
- [ ] 添加到主屏后图标正确、独立启动

**安全**
- [ ] 无令牌 / 错误令牌请求全被拒
- [ ] 路径穿越 `/../config.js` 返回 403
- [ ] 令牌不出现在 URL、日志、错误堆栈

---

## 依赖顺序

```
T1 (server 协议)
  ↓
T2 (manager 重写) → T3 (ipc) → T4 (preload 上报)
                              ↓
T5 (html) → T6 (css) → T7 (app.js) → T8 (pet)
                              ↓
T9 (桌面面板) → T10 (打包) → T11 (回归) → T12 (手工)
```

T5-T8 可并行（同一份 PWA 资源，建议按 HTML→CSS→JS→pet 顺序，便于样式调试）。
T9/T10 独立于 PWA 主链，可并行。
