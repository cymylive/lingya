# 跨窗口 Token 轮转 · 设计文档

- 日期：2026-10-31
- 版本基线：lingya 0.6.88
- 状态：待实施

## 一、为什么做

LingYa 目前已有「单窗口内 token 达阈值 → 删原对话 → 新对话承接任务」的完整链路。
问题是：所有承接都落在同一个窗口（同一 partition / 同一账号），高频使用同一账号时上下文压力集中，且一旦该窗口异常，任务链断裂。

目标：把承接的目标从「当前窗口」扩展到「窗口池」，达阈值后切换到下一个指定窗口新建会话，依次轮转。阈值可自定义，参与轮转的窗口可指定。**根本目的是分散单账号的调用密度。**

## 二、目标 / 非目标

### 目标
- G1 token 达到可配置阈值时，自动把任务交接给窗口池中的下一个窗口
- G2 阈值、窗口池、轮转策略均可配置并持久化
- G3 承接失败时任务链不断裂：旧会话不删，原窗口继续
- G4 原地迁移（现有链路）完整保留为 fallback
- G5 各窗口可绑定不同账号标识，支持按账号分散

### 非目标
- N1 不做自动登录 / 自动养号
- N2 不改 token 统计口径（沿用 SSE 真实 usage）
- N3 不做窗口自动创建（池中窗口由用户预先打开）
- N4 不改 DeepSeek 平台侧行为

### 反目标（即使技术成功也算失败）
- A1 承接失败导致旧会话被删、任务上下文丢失
- A2 轮转在用户正在输入时把窗口强行切走
- A3 出现无限轮转死循环

## 三、约束

| 约束 | 说明 |
|---|---|
| C1 partition 隔离 | 每个 profile 是独立 partition（`persist:<providerId>:<id>`），localStorage / IndexedDB / cookie 全不共享 |
| C2 迁移数据必须走主进程中转 | 因为 C1，源窗口的 localStorage 无法被目标窗口读到 |
| C3 删会话必须在源窗口执行 | `deleteSessionSilent` 依赖源窗口的 auth headers 与 IndexedDB |
| C4 IPC 载荷体积 | 全量历史 Markdown 可达数百 KB ~ 数 MB，需设上限 |
| C5 目标窗口可能不在首页 | 需先导航到 `provider.homeUrl` 再注入 |
| C6 渲染进程不 require Node | preload 只能通过 `window.electronAPI` 调主进程 |

## 四、用户已拍板的决策

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 账号维度 | **B —— 各窗口登不同账号，真正分散账号风险**。配置中每个窗口可标注所属账号 |
| D2 | 触发时当前任务如何收尾 | **C —— 先发「请收尾并输出交接摘要」指令，等回复完再切** |
| D3 | 配置面板位置 | **B —— 单独的「轮转」页签** |

## 五、架构

```
A窗口（源）
  events.js checkAutoCompact 达阈值
    → 判定轮转是否启用
    → 发送收尾指令，等待回复完成（D2）
    → 打包 migrationData（history / projectDir / oldSessionId / accountTag）
    → IPC rotation-submit ────────────────┐
                                          │
                                          ▼
                              ┌────────────────────────────┐
                              │ 主进程 token-rotation.js    │
                              │  · config（阈值/池/策略）    │
                              │  · 轮转指针 cursor           │
                              │  · 迁移中继 pending          │
                              │  · 超时看门狗                │
                              └───────────┬────────────────┘
                                          │ 选目标窗口（跳过忙、跳过同账号优先）
                                          ▼
                              B窗口 AI视图 WebContents
                                · 若不在首页 → loadURL(homeUrl)
                                · wc.send('lingya-received-migration', data)
                                          │
                              B窗口 preload 收到
                                · 写入自身 localStorage['lingya-pending-migration']
                                · 现有 auto-inject 状态机接管（init→wait→发历史→sent）
                                · 发完历史后 IPC rotation-ack {ok:true}
                                          │
                                          ▼
                              主进程收到 ack
                                · 清 pending
                                · 推指针 cursor → next
                                · 通知 A 窗口 'lingya-rotation-result' {ok, targetProfileId}
                                          │
                                          ▼
                              A窗口收到 ok
                                · 执行 deleteSessionSilent(oldSessionId)
                                · 清空本地对话记录
```

**时序关键点**：删旧会话在 ack 之后。承接失败 → ack 为 false 或超时 → A 窗口不删，走原地迁移或继续原任务。

## 六、数据结构

### 配置（`userData/token-rotation.json`）

```json
{
  "enabled": false,
  "thresholdWan": 10,
  "pool": [
    { "profileId": "p1", "accountTag": "acc-A", "enabled": true },
    { "profileId": "p2", "accountTag": "acc-B", "enabled": true }
  ],
  "cursor": 0,
  "maxRotations": 5,
  "maxSessionHours": 4,
  "preferDifferentAccount": true,
  "targetBusyWaitMs": 60000,
  "historyMaxBytes": 2097152
}
```

### 迁移包（IPC 中继，仅内存）

```js
{
  requestId: string,
  sourceProfileId: string,
  sourceAccountTag: string,
  history: string,
  projectDir: string|null,
  oldSessionId: string|null,
  timestamp: number
}
```

## 七、模块设计

### 7.1 `src/main/token-rotation.js`（新增）

职责：
- `readConfig()` / `writeConfig(patch)` —— 持久化，写入用原子写（临时文件 + rename）
- `pickTarget(sourceProfileId, sourceAccountTag)` —— 从 pool 中按 cursor 顺序找下一个 `enabled` 且窗口存在的；`preferDifferentAccount` 为真时优先跳过同 accountTag；池耗尽则回到 0
- `submit(sourceCtx, data)` —— 选目标 → 若目标不在首页先导航 → `wc.send` 派发 → 登记 pending + 启动超时定时器 → 返回 `{ok, targetProfileId, requestId}`
- `ack(requestId, ok)` —— 清 pending、成功则推进 cursor、回告源窗口
- 超时（默认 90s）未 ack → 清理 pending，回告源窗口 `{ok:false, reason:'timeout'}`
- 连续轮转计数 / 会话时长统计，触顶返回 `{ok:false, reason:'limit'}`

**不能做的事**：不直接操作目标窗口的 localStorage，不直接删任何会话。

### 7.2 主进程 IPC（在 `src/main/index.js` 注册）

| 通道 | 入参 | 返回 |
|---|---|---|
| `rotation-get-config` | — | `{success, config}` |
| `rotation-set-config` | `{patch}` | `{success, config}` |
| `rotation-list-candidates` | — | `{success, windows:[{profileId,name,accountTag,exists,busy}]}` |
| `rotation-submit` | `{data}` | `{success, targetProfileId?, requestId?, reason?}` |
| `rotation-ack` | `{requestId, ok, error?}` | `{success}` |
| `rotation-reset` | — | `{success}`（重置 cursor 与计数器，面板上「重置轮转状态」用） |

新增通道需同步加进 `src/main/ipc-guard.js` 白名单。

### 7.3 `src/preload/api.js`

新增 `rotationGetConfig` / `rotationSetConfig` / `rotationListCandidates` / `rotationSubmit` / `rotationAck` / `rotationReset`，以及事件监听 `onRotationResult(cb)`（监听 `lingya-rotation-result`）。

### 7.4 `src/preload/overlay/events.js`

`checkAutoCompact()` 内分流：

```
读 rotation-enabled（主进程配置，启动时同步到 localStorage 缓存）
若未启用 → 走现有原地迁移（原逻辑一行不改）
若启用 → runRotationMigration()
```

`runRotationMigration()` 步骤：
1. `state.isMigrating = true`（复用防爆锁）
2. 发送收尾指令（D2）：「请把当前工作收尾，并输出一份交接摘要：已完成什么、未完成什么、下一步该做什么。直接输出摘要。」
3. `waitForResponse` 等待（上限 120s，超时则降级为直接打包全量历史）
4. 打包 history（`conversation-log.buildMarkdown`，含工具块）+ projectDir + oldSessionId
5. 体积超 `historyMaxBytes` → 截断尾部并附提示
6. `await window.electronAPI.rotationSubmit(data)`
7. `ok === false` → 记日志，回落原地迁移（调用现有 migration 逻辑），Toast 说明
8. `ok === true` → 注册一次性 `onRotationResult` 监听，等待结果
9. 收到 `{ok:true}` → `deleteSessionSilent(oldSessionId)`，清 conversation-log，Toast「已切换到窗口 X」
10. 收到 `{ok:false}` → 不删，Toast「切换失败：<reason>，本窗口继续」，`isMigrating = false`

### 7.5 `src/preload/dom/auto-inject.js`

新增监听（在文件顶部注册一次）：

```js
window.electronAPI.onReceivedMigration((data) => {
  localStorage.setItem('lingya-pending-migration', JSON.stringify({
    history: data.history,
    projectDir: data.projectDir,
    oldSessionId: null,          // 删旧会话由源窗口负责，目标窗口不删
    rotationRequestId: data.requestId,
    stage: 'init',
    timestamp: Date.now()
  }));
});
```

现有 `stage === 'sent'` 分支末尾增加：

```js
if (data.rotationRequestId) {
  window.electronAPI.rotationAck({ requestId: data.rotationRequestId, ok: true });
}
```

**注意**：目标窗口 `oldSessionId` 设为 null，避免现有逻辑在目标窗口里误删无关会话。

### 7.6 UI（新「轮转」页签）

位置：`src/preload/overlay/template.js` 加页签按钮 + 面板容器；`events.js` 加 `bindRotationEvents`。

面板内容：
- 开关：启用跨窗口轮转
- 阈值输入：`万 token`（默认 10）
- 窗口池列表：每行 = 窗口名 + profileId + 账号标识输入框 + 启用勾选 + 上移/下移
- 「刷新窗口列表」按钮 → `rotationListCandidates`
- 高级：最大轮转次数、会话时长上限、优先不同账号（勾选）、目标等待时长
- 「重置轮转状态」按钮

所有元素 id 前缀 `lingya-rot-`，避免与现有 id 冲突。

## 八、失败矩阵

| 场景 | 行为 |
|---|---|
| 目标窗口不存在 / 已关闭 | 跳过，取池中下一个 |
| 目标窗口忙（running/stuck） | 等待至多 `targetBusyWaitMs`，超时跳下一个 |
| 目标窗口不在首页 | 主进程先 `loadURL(homeUrl)`，等 `did-finish-load` 再派发 |
| 全池都不可用 | 返回 `{ok:false, reason:'no-target'}` → 源窗口回落原地迁移 |
| 目标窗口收到但初始化失败 | auto-inject 状态机内部清理 + 发 `rotationAck(ok:false)` |
| 目标窗口 90s 未 ack | 主进程看门狗回告 `{ok:false, reason:'timeout'}` |
| 历史超过 2MB | 截断尾部 + 提示，继续派发 |
| 收尾指令超时（120s） | 降级：直接用现有全量历史打包 |
| 轮转次数 / 时长触顶 | `{ok:false, reason:'limit'}` → 回落原地迁移，Toast 提示 |
| 源窗口在等待期间被关闭 | 主进程 pending 超时自动清理，目标窗口照常承接（历史已在目标侧） |

## 九、保留的现有链路

`checkAutoCompact` 中原地迁移代码块**不删除、不改动**，仅在外层加一个 if 分流。轮转关闭时行为与今天完全一致。

## 十、测试计划

`test/main/token-rotation.test.js`：
1. 配置读写与原子落盘
2. `pickTarget`：顺序推进、跳过 disabled、跳过不存在、池耗尽回环
3. `preferDifferentAccount`：同账号跳过、全同账号时不过度跳过
4. `submit` → `ack(ok)` 推进 cursor
5. `submit` → `ack(false)` 不推进 cursor
6. 超时看门狗触发并回调失败
7. `maxRotations` 触顶
8. 载荷超限截断

preload 侧（`test/preload/`）：
9. `onReceivedMigration` 写入 localStorage 结构正确、`oldSessionId` 为 null
10. `stage==='sent'` 时调用 `rotationAck`

## 十一、实施顺序（供 writing-plans 展开）

1. `token-rotation.js` 纯逻辑 + 单测（不接 IPC，先测通选窗口/指针/超时）
2. IPC 注册 + ipc-guard 白名单
3. preload api.js 暴露 + 事件通道
4. auto-inject.js 接收端改造
5. events.js 源端分流 + 收尾指令 + ack 处理
6. UI 轮转页签
7. 端到端手测：两窗口、阈值设 0.1 万，验证切换与删除时机
8. `npm test` 全绿

## 十二、实施结论（2026-10-31）

### 已完成

| Task | 内容 | 状态 |
|---|---|---|
| 1 | 配置存储层 `src/main/token-rotation.js` | 完成，5 用例 |
| 2 | 目标窗口选择纯函数 `selectNextIndex` | 完成，5 用例 |
| 3 | 迁移中继与超时看门狗 `submit`/`ack` | 完成，6 用例 |
| 4 | 主进程 IPC 注册与候选列表 `buildCandidates` | 完成，3 用例 |
| 5 | preload API 暴露（6 方法 + 2 监听） | 完成，8 用例 |
| 6 | 目标窗口接收端（auto-inject） | 完成，4 用例 |
| 7 | 源窗口触发端（events.js 分流） | 完成，7 用例 |
| 8 | 轮转配置页签 UI | 完成 |
| 9 | 端到端手测 | 待人工执行（需两个真实账号窗口） |

全量测试：**1127 用例全绿**（基线 1089 + 新增 38）。

### 实施中的裁定（Ruling）

1. **ipc-guard.js 不加 rotation-* 通道**
   SENSITIVE_CHANNELS 的语义是「禁止 http(s) 网页调用，只允许 file://」；
   而轮转通道恰恰由 AI 视图 preload（来源 https://chat.deepseek.com）调用。
   加进去会导致所有轮转 IPC 被拒。代价：网页脚本可改轮转配置，但影响面仅限轮转行为，不涉及凭证。

2. **阈值双轨**
   轮转启用时用 thresholdWan（默认 10 万）判定；未启用时完全走原有
   lingya-auto-compact-threshold（默认 80 万）。两套口径互不干扰。

3. **测试基线是 1089 而非 732**
   交接文档写的 732 已过时，项目近期已扩测。本次交付要求不低于 1089 且新增用例全绿。

### 待人工验证（Task 9）

需真实环境执行，因为需要两个不同账号的窗口：

1. 起窗口 1 与窗口 2，各登不同账号，都初始化项目
2. 轮转页签：阈值填 0.1（1000 token 便于触发），池中勾选两个窗口，账号标识填 A / B，保存
3. 窗口 1 发一条消耗 >1000 token 的请求
4. 观察：窗口 1 先发收尾指令 → 窗口 2 导航到首页 → 出现「正在承接上一个会话的历史...」Toast → 窗口 1 旧会话在窗口 2 收到历史之后才消失
5. 失败路径：关掉窗口 2 再触发，应回落原地迁移，旧会话仍在

### 关键文件清单

新增：
- src/main/token-rotation.js
- test/main/token-rotation.test.js
- test/main/token-rotation-ipc.test.js
- test/preload/rotation-api.test.js
- test/preload/rotation-receive.test.js
- test/preload/rotation-trigger.test.js

修改：
- src/main/index.js（初始化 + 6 个 IPC 通道）
- src/preload/api.js（6 方法 + 2 监听）
- src/preload/dom/auto-inject.js（接收端 + ack）
- src/preload/overlay/events.js（分流 + runRotationMigration + bindRotationEvents）
- src/preload/overlay/template.js（轮转页签）

