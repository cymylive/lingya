# 手机远程控制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use `- [ ]` checkbox syntax for tracking.

**Goal:** 为灵鸦实现手机远程控制——桌面端起 HTTP+WS 服务（只绑 127.0.0.1）+ 托管 cloudflared 隧道 + 托管手机端 PWA；手机经公网域名访问，能选窗口、看流式回复与工具状态、发消息、点停止、断线重连、离线暂存，并带桌宠。

**Architecture:** 三层解耦，与 Cuckoo Code `src/remote/` 一一对应：
- **config**（纯 node）—— 读写 `~/.lingya/remote.json`，原子写
- **server**（纯 node + `ws`）—— HTTP 静态托管 + WebSocket，不 require electron，靠注入回调与主进程交互
- **manager**（粘合层）—— 对接 `window.js` / `generation-state.js` / `profile-manager.js`，把手机消息路由到目标窗口，把 AI 事件广播给手机
- **tunnel**（纯 node + `child_process`）—— cloudflared 子进程托管、自愈、代际号防僵尸

**Tech Stack:** Electron 33 / CommonJS / 原生 DOM / `node --test` / `ws` 8.22.0（已在依赖）/ cloudflared 二进制（extraResources）

**Spec:** `specs/005-remote-mobile-control/spec.md`

---

## Constitution Check

> 逐条对照 `.specify/memory/constitution.md` v1.0.0

### I. 外科手术式修改 ✅

- **新增为主**：全部新代码落在 `src/main/remote/` 新目录，现有文件只做三处最小挂载：
  - `src/main/entry.js`：加 2 行（require + register）、加 1 行退出清理
  - `src/ui/边栏.html`：设置面板新增一个「手机远程」分区（**不改任何现有元素 id**）
  - `package.json`：`extraResources` 加一条
- **不改动**：`window.js` / `profile-manager.js` / `generation-state.js` / `ipc.js` / 三个通道（飞书/微信/QQ）——全部只读调用它们的现有导出
- **禁止顺手改**：不加日志、不重构、不格式化无关行

### II. 先思考后编码 ✅

已完成 spec.md + 6 轮 clarify（公网隧道 / cloudflared 内置 / 只打 win x64 / 非 Windows 置灰 / 移植桌宠 / APK 拆 spec）。

### III. 验证闭环与测试驱动 ✅（NON-NEGOTIABLE）

- 当前测试基准：`npm test` **1110 用例全绿**（constitution 记载）
- 每个 task **先写失败测试 → 再实现**
- 新增测试文件放 `test/main/`，遵守现有 `node --test` 风格与 `test/helpers/mock-electron.js` 约定
- **打包命令不擅自执行**，发版前向用户申请

### IV. 架构分层与沙箱安全 ✅

- **preload 不直接 require node 模块**：手机远程的全部逻辑在主进程；preload 只通过 `electronAPI` 走 IPC
- **server 不依赖 electron**：用 `ServerDeps` 接口注入 `onUserMessage` / `onListProfiles` / `onStop` 等回调，便于单测（与 Cuckoo 同构）
- **只监听 127.0.0.1**，不暴露局域网
- **令牌常量时间比较**，不进 URL、不进日志
- **静态资源路径穿越校验**
- **不改沙箱执行链**（jsRunner 完全不碰）

### V. 零 Token 与扩展性 ✅

- **不引入任何新 npm 依赖**（`ws` 已在 `dependencies`）
- cloudflared 是**二进制资源**，不是 npm 包，不膨胀 node_modules
- 不调用任何需要 API Token 的模型接口

---

## Global Constraints

- **测试基准**：`npm test` 1110 用例全绿；本功能完成后不得回归
- **UI 元素 id 不变**：现有 HTML 元素 id 一律不动，新元素用新 id（前缀 `remote-`）
- **代码规范**：CommonJS（`require` / `module.exports`），前端原生 DOM
- **平台范围**：cloudflared 只打 Windows x64；非 Windows 平台设置页分区置灰
- **配置目录**：复用 `data-dir.js` 的 `resolveDataDir()`，配置存 `<dataDir>/remote.json`
- **事件名**：灵鸦用 `lingya-ai-response` / `lingya-report-task-state`（**不是** Cuckoo 的 `cuckoo-*`）
- **窗口定位**：必须用 `getContextByWebContents()` 或 `view.webContents.id`，**不能**按 profileId 直接假设（灵鸦有 tab/split/窗口合并，view 会被搬运）

---

## Review Focus

> plan 阶段识别的高风险点，实现时必须逐条自测。

1. **窗口合并后串台** —— 把窗口 A 的视图合并进窗口 B 后，手机选 A 时消息必须进 A 的会话，不能进 B
2. **tab 切换后流式串扰** —— 一个窗口有多个 tab 时，流式事件必须按当前 active tab 的 webContents 分发
3. **生成态误判** —— `generation-state` 是上报式 + 30s 过期；AI 崩溃后手机端不得永久卡「生成中」
4. **令牌泄露** —— 检查所有 `console.log` / 错误堆栈 / URL 构造，令牌不得出现
5. **隧道僵尸进程** —— 快速连点开关 5 次，系统中不得残留 cloudflared 进程
6. **退出清理** —— 应用退出后 `netstat` 不得有残留监听端口
7. **PWA 缓存穿透** —— 发版后手机端刷新必须拿到新 `app.js`（版本号注入生效）
8. **单窗口回归** —— 没开远程服务时，桌面端行为与改动前完全一致

---

## Task 1: 配置模块（纯 node，可单测）

**Files:**
- Create: `src/main/remote/config.js`
- Test: `test/main/remote-config.test.js`

**Interfaces:**
- `readConfig()` → `{ enabled, port, token, publicUrl, tunnelEnabled, tunnelToken }`
- `writeConfig(patch)` → boolean
- `getConfigPath()` → string（供测试注入临时目录）
- `genToken()` → 32 位 hex

**Steps:**
- [ ] **Step 1: 写失败测试** —— 覆盖：首次读取自动生成 token 并落盘；损坏 JSON 自动修复；端口越界回退默认；令牌为空时补生成；原子写（模拟写临时文件后 rename）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 config.js** —— 复用 `data-dir.js` 的 `resolveDataDir()` 定位；`CUCKOO_HOME` 改名 `LINGYA_HOME` 用于测试隔离；原子写用 `fs.writeFileSync(tmp) + fs.renameSync`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**（若 git 可用）

---

## Task 2: HTTP + WebSocket 服务（纯 node，可单测）

**Files:**
- Create: `src/main/remote/server.js`
- Test: `test/main/remote-server.test.js`

**Interfaces:**
- `startServer({ port, token, deps })` → `Promise<{ ok, port?, error? }>`
- `stopServer()` → void
- `isRunning()` → boolean
- `broadcast(msg)` → void
- `ServerDeps`: `{ onUserMessage, onStop?, onListProfiles?, onGetCurrentProfile?, onSelectProfile?, onNewClient? }`

**Steps:**
- [ ] **Step 1: 写失败测试** —— 覆盖：无令牌请求返回 401；正确令牌 `/api/ping` 返回 200；错误令牌返回 401；`Sec-WebSocket-Protocol` 鉴权成功；URL query 令牌（过渡）可鉴权；路径穿越 `/../config.js` 返回 403；超大消息（>2MB）被拒；文本超长（>10 万字符）被拒；OPTIONS 预检在鉴权前放行
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 server.js** —— 照 Cuckoo 结构，去掉未用的部分（不搬 `pets` 回退、不搬 CORS 之外的复杂逻辑）；鉴权用 `crypto.timingSafeEqual`；静态托管 async 读盘；ETag + 版本号注入
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 补充测试** —— 客户端 clientId 去重、心跳 pong 响应、`/api/ping` 返回 JSON

---

## Task 3: 隧道模块（cloudflared 子进程托管）

**Files:**
- Create: `src/main/remote/tunnel.js`
- Test: `test/main/remote-tunnel.test.js`

**Interfaces:**
- `startTunnel({ port, tunnelToken?, customPath?, onUrlDetected?, onError? })` → `Promise<{ ok, url?, error? }>`
- `stopTunnel()` → void
- `getTunnelStatus()` → `{ running, mode, url, pid, error }`
- `findCloudflaredBinary(customPath?)` → string | null（导出供测试）
- `buildCloudflaredCandidates(platform, env)` → string[]（纯函数，导出供测试）

**Steps:**
- [ ] **Step 1: 写失败测试** —— 覆盖：`buildCloudflaredCandidates('win32', env)` 的路径顺序与内容；`findCloudflaredBinary` 在 customPath 存在时优先返回它；不存在时回退；代际号逻辑（mock 子进程，模拟旧代 exit 不污染新代）；退避上限 5 次后放弃；fatal error（ENOENT）不触发自动重启
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 tunnel.js** —— 照 Cuckoo，但查找顺序增加 `process.resourcesPath`（打包后内置位置）；固定令牌模式与快速模式；代际号 + 退避 + `taskkill /T`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 补充测试** —— stop 后 `getTunnelStatus().running === false`；连续 start 不会产生两个进程

---

## Task 4: 粘合层（对接灵鸦的窗口/生成态/Profile）

**Files:**
- Create: `src/main/remote/manager.js`
- Test: `test/main/remote-manager.test.js`

**Interfaces:**
- `initRemote()` → Promise
- `stopRemote()` → void
- `broadcastAiEvent(webContentsId, kind, data)` → 供 preload 调用（经 IPC）
- `listProfilesForRemote()` → 手机端窗口列表（含 id、标题、忙态）

**Steps:**
- [ ] **Step 1: 写失败测试** —— 覆盖：`getTargetContext()` 在 profileId 失效时回退最近活跃；`markBusy` TTL 10s 过期；子代理运行中拒收消息；流式节流 30ms（连续 push 只广播一次）；`profileId` 隔离（A 的消息不广播给 B 的订阅者）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 manager.js** —— 依赖 `window.js`（`getWindowByProfileId`、`getMainContext`、`getAllContexts`、`getContextByWebContents`）、`generation-state.js`（`get(webContentsId)`）、`profile-manager.js`（`readProfiles`）、`subagent.js`（`hasRunningSubagent`，若无此导出则用等价判断）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 关键适配** —— **必须**用 `view.webContents.id` 作为生成态的 key（灵鸦的 `generation-state` 就是这个语义）；窗口合并场景通过 `getContextByWebContents()` 反查

---

## Task 5: IPC 注册 + 主进程挂载

**Files:**
- Create: `src/main/remote-ipc.js`
- Modify: `src/main/entry.js`（加 3 行）
- Test: `test/main/remote-ipc.test.js`

**Interfaces:**
- `registerRemoteIpc()` → void
- IPC 通道：`remote-status` / `remote-set-enabled` / `remote-set-config` / `remote-reset-token` / `remote-start-tunnel` / `remote-stop-tunnel` / `remote-list-clients` / `remote-kick-all` / `remote-ai-event`（preload → 主进程上报）

**Steps:**
- [ ] **Step 1: 写失败测试** —— 覆盖：IPC 通道注册（mock ipcMain）；`remote-set-enabled(true)` 启动服务；`remote-set-enabled(false)` 停止服务并清空客户端；`remote-reset-token` 后旧令牌失效
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 remote-ipc.js** —— 全部 IPC 走 `ipc-guard` 的既有保护（不绕过）
- [ ] **Step 4: 挂载到 entry.js** —— 在现有 `registerIpcHandlers()` 之后加 `require('./remote-ipc').registerRemoteIpc()`；在 `before-quit` 或 `will-quit` 中调 `stopRemote()`（需先确认 entry.js 现有退出钩子的位置）
- [ ] **Step 5: 跑测试确认通过 + `npm test` 全绿**

---

## Task 6: 手机端 PWA（静态资源）

**Files:**
- Create: `src/main/remote/pwa/index.html`
- Create: `src/main/remote/pwa/app.js`
- Create: `src/main/remote/pwa/style.css`
- Create: `src/main/remote/pwa/manifest.webmanifest`
- Create: `src/main/remote/pwa/icon.svg`
- Test: 手工验证（浏览器打开）

**Steps:**
- [ ] **Step 1: 搭骨架** —— index.html（登录层 + 对话层 + 断线横幅 + SVG 图标精灵）；manifest（name=灵鸦远程，display=standalone）；icon.svg（灵鸦主题单线图标）
- [ ] **Step 2: 登录逻辑** —— 输入令牌 → `/api/ping` 验证 → 存 localStorage → 连 WS
- [ ] **Step 3: 消息协议** —— 收：`profiles` / `sys` / `stream` / `tool` / `ai-reply` / `error`；发：`auth` / `ping` / `user-message` / `stop` / `select-profile` / `clear`
- [ ] **Step 4: 流式渲染** —— 追加显示；`marked` 渲染 Markdown（复用 `src/ui/vendor/marked.umd.js`）；代码块复制按钮；XSS 消毒
- [ ] **Step 5: 计时器** —— 工具执行秒数；处理 `visibilitychange` 冻结补偿（Cuckoo 的 `lastTickAt` 方案）
- [ ] **Step 6: 断线重连** —— 指数退避 + 3 秒防抖 + 8 秒启动看门狗 + 心跳 pong + 切前台探活；离线队列（上限 50）
- [ ] **Step 7: 界面细节** —— 回到底部、新消息徽章、草稿持久化、深浅色主题、exec-status 胶囊
- [ ] **Step 8: 手工验收** —— 见"验收清单"

---

## Task 7: 手机端桌宠

**Files:**
- Create: `src/main/remote/pwa/mobile-pet.js`
- Create: `src/main/remote/pwa/mobile-pet.css`
- Copy: 从 `src/preload/overlay/pets/` 复制桌宠资源到 `src/main/remote/pwa/pets/`

**Steps:**
- [ ] **Step 1: 复制引擎** —— `pet.js` + `pet.css` + `pets.generated.js`（若灵鸦有）从 overlay/pets 复制；若无 `pets.generated.js`，按灵鸦现有结构适配
- [ ] **Step 2: 写适配层** —— 照 Cuckoo `mobile-pet.js`：状态映射（thinking/working/waiting/idle/done/error）、64px 固定尺寸、`clampXForHost`、`onMove` 持久化
- [ ] **Step 3: 写样式覆盖** —— 照 Cuckoo `mobile-pet.css`：`touch-action: pan-y`（手势）、`width: max-content`（气泡换行修复）
- [ ] **Step 4: 防腐** —— 引擎加载失败静默降级，不影响对话
- [ ] **Step 5: 手工验收** —— 桌宠随状态切换、横向拖动记忆、竖向滑动页面正常滚动

---

## Task 8: 桌面设置页

**Files:**
- Modify: `src/ui/边栏.html`（设置面板新增分区）
- Modify: `src/preload/边栏渲染`（新增渲染逻辑，**不新增文件**，因为它是单文件）
- Modify: `package.json`（extraResources 加 cloudflared + remote-pwa）
- Copy: cloudflared.exe 到 `resources/cloudflared/cloudflared.exe`（需用户提供二进制）

**Steps:**
- [ ] **Step 1: 设置页 HTML** —— 在 `.ly-settings-layout` 的 nav 加一项「手机远程」；右侧内容区加开关、端口、令牌（含复制/重置按钮）、公网地址、隧道开关与状态、已连设备列表；**元素 id 全部用 `remote-` 前缀**
- [ ] **Step 2: 渲染逻辑** —— 读 `remote-status` IPC；开关切换调 `remote-set-enabled`；令牌复制走 clipboard（灵鸦已有此能力吗？需确认，若无则用 `navigator.clipboard`）；错误信息展示
- [ ] **Step 3: 平台置灰** —— 非 Windows 时开关 disabled，旁边显示「当前仅支持 Windows」；通过 `process.platform`（IPC 传入）判断
- [ ] **Step 4: 打包配置** —— `extraResources` 加两条：`{ from: 'resources/cloudflared/cloudflared.exe', to: 'cloudflared/cloudflared.exe' }` 与 `{ from: 'src/main/remote/pwa', to: 'remote-pwa' }`
- [ ] **Step 5: 路径解析** —— 开发环境用源码路径，生产用 `process.resourcesPath`；在 `config.js` 或新建 `paths.js` 里统一

---

## Task 9: 边界收尾与全量回归

**Steps:**
- [ ] **Step 1: 回归测试** —— `npm test` 全绿，尤其确认：`window.js` / `generation-state.js` / `profile-manager.js` / 三通道的测试无变化
- [ ] **Step 2: 手工验收** —— 见下方清单
- [ ] **Step 3: 静态检查** —— 全局搜索令牌是否出现在日志/URL；确认所有 `console.log` 不打令牌
- [ ] **Step 4: 退出清理验证** —— 开服务 → 开隧道 → 退出应用 → `netstat -ano | findstr :7799` 无输出、任务管理器无 cloudflared
- [ ] **Step 5: 更新 spec.md 的 Review & Acceptance Checklist** —— 逐条打勾

---

## 依赖关系

```
Task 1 (config)  ──┐
Task 3 (tunnel)  ──┼──→ Task 5 (IPC + 挂载) ──→ Task 8 (设置页) ──→ Task 9 (收尾)
Task 2 (server)  ──┤
Task 4 (manager) ──┘
                          Task 6 (PWA) ──→ Task 7 (桌宠) ──↗
```

Task 1/2/3/4 可并行；Task 6/7 依赖 Task 2 的协议定型；Task 8 依赖 Task 5。

---

## 里程碑

- **M1（Task 1-5）**：服务、隧道、粘合、IPC 全部就绪，可通过 curl/脚本验证——**P1 交付**
- **M2（Task 6）**：手机浏览器可完整使用（登录、对话、发消息、断线重连）——**P1 交付**
- **M3（Task 7-8）**：桌宠 + 桌面设置页——**P2 交付**
- **M4（Task 9）**：边界处理 + 全量回归 + 退出清理验证——**P3 交付**

---

## 验收清单（手工，Task 9 用）

- [ ] 打开开关 → 显示令牌与公网地址 → 手机登录成功
- [ ] 手机发消息 → 电脑 AI 收到 → 流式回复回到手机
- [ ] 工具执行时手机显示「工具运行 Ns」且秒数递增
- [ ] 手机切后台 5 分钟回来，秒数连续不跳变
- [ ] 电脑开 3 个窗口 → 手机切换三次 → 内容不串台
- [ ] 电脑窗口合并后 → 手机仍能正确操控原窗口
- [ ] AI 生成中点「停止」→ 电脑上 AI 停下
- [ ] 手机断网 → 横幅出现 → 恢复 → 自动重连且不丢消息
- [ ] 隧道手动 kill → 自动恢复（≤30 秒）
- [ ] 连点开关 5 次 → 无僵尸进程
- [ ] 退出应用 → 端口释放、cloudflared 回收
- [ ] 非 Windows 平台 → 分区置灰并提示
- [ ] 桌宠随 AI 状态切换、拖动记忆、竖向滑动不拦截
