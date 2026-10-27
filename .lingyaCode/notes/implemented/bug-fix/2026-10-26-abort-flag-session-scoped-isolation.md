# Agent Note: 停止标志必须按「窗口 + 会话」复合键隔离

Status: implemented

## Problem

用户报告：在 A 会话点「停止任务」后，切到 B 会话，B 会话里任何工具调用都直接失败，报「任务已被用户停止」。除非在同一会话里再发一条消息触发清除，否则 B 会话一直处于「被停止」状态。

根因是**隔离键粒度过粗**。停止链路与执行链路原本全部使用 `profileId`（窗口级标识）：

- `src/main/ipc.js` 的 `abort-execution` → `activeProcesses.markAborted(profileId)`
- `src/main/ipc.js` 的 `clear-abort` → `activeProcesses.clearAborted(profileId)`
- `tools/JsRunner.js` 的脚本入口与 `hostBridge` → `activeProcesses.isAborted(profileId)`
- 子进程归属（`BashTool` / `PwshTool` / `BackgroundTaskTool` / `JsRunner.runBash`）→ `register(child, profileId)`

同一窗口内的 A、B 两个会话共享同一个 `profileId`，因此 A 会话的停止标记会被 B 会话的 `isAborted(profileId)` 命中，形成跨会话串扰。`active-processes` 自身的多窗口隔离单测测的是**不同 profileId**，覆盖不到「同窗口跨会话」这个场景，所以这个缺陷长期未被测试发现。

## Decision

**停止状态的最小隔离单位是「窗口 + 会话」，而非「窗口」。**

- `tools/active-processes.js` 新增并导出 `abortKey(profileId, sessionId)`，返回 `(profileId || 'p') + '::' + (sessionId || 's')` 的复合键。该拼接格式与项目里既有的会话键惯例一致（`JsRunner` 的 `tlSessionKey`、`ipc.js` 的 `sessionKey` 都是这个形状），不引入新的键格式。
- 停止侧：`abort-execution` 与 `clear-abort` 都改为 `abortKey(profileId, resolveSessionId(ctx, event.sender))`。**必须用 `resolveSessionId()` 而不是直接读 URL**——侧边栏（壳窗口）调用时 `event.sender` 是 shell.html，解析不出会话 ID，`resolveSessionId` 会回退到 `sessionStore.state.currentSessionId`，从而保证停止侧与执行侧算出同一个键。
- 执行侧：`JsRunner.run` 与 `hostBridge` 的 `isAborted` 改用复合键；复合键通过 `options.abortKey` 与工具参数 `params.abortKey` 下传，供 `BashTool` / `PwshTool` / `BackgroundTaskTool` 的 `register(child, key)` 与 `waitForDone(abortKey)` 使用。
- 兼容保留：不传 key 的旧调用点仍退化为 `GLOBAL_KEY` 全局语义，`killAll()` / `clearAborted()` 无参行为不变。

## Alternatives considered

**改 `isAborted(key)` 的语义，让它只匹配精确 key、不再认全局标记** —— 落选原因：全局标记是有意保留的逃生通道（`markAborted()` 无参 = 停全部），`active-processes` 的单测明确覆盖了这条语义。在判断函数里砍掉它，等于把「停止全部」这个能力废掉，属于为了解决一个问题而引入另一个功能缺失。

**在 UI 侧规避：切会话时自动调一次 `clear-abort`** —— 落选原因：这是典型的症状修复。它只处理「用户手动切会话」这一条路径，而同一窗口内多标签页、定时任务触发、监督者自动催促等场景都不经过切会话动作，标记依然会残留。根因（键粒度）不修，泄漏面永远堵不全。

**把停止做成纯全局（所有会话一起停）** —— 落选原因：用户明确要求「独立隔离」。全局停止在单会话场景下看似更简单，但会让用户在 A 会话的误操作波及 B 会话正在跑的长任务（例如 B 的构建），这是更严重的破坏。

**给 `abortedKeys` 换成 `Map<profileId, Set<sessionId>>` 两层结构** —— 落选原因：复合键字符串已经能满足隔离需求，且与项目既有的 `profileId::sessionId` 键格式统一。引入嵌套 Map 会让 `markAborted` / `clearAborted` / `isAborted` 三个函数的参数形态变得不一致（一个收两个参数、一个收一个），反而增加调用方出错的概率。

**仍然只用 profileId，但把「会话切换」也当作一次停止域切换（切会话时杀掉旧会话进程）** —— 落选原因：这会让用户在 A 会话启动的后台任务在切到 B 时被静默杀掉，后台任务的语义被破坏。后台任务本身就允许跨会话存活，停止必须由用户显式触发。

## Consequences

**收益**：

- A 会话点停止不再污染 B 会话，符合「每个会话独立」的直觉
- 停止、清除、执行三方用同一粒度的键，消除了「标记写下但清不掉」的整类问题
- `killAll(key)` 的进程归属同步改为复合键，停止时不会误杀同窗口其他会话的子进程
- 新增 3 个回归测试覆盖同窗口跨会话场景，补上了原有单测的盲区

**代价**：

- 隔离键从单值变成复合串，所有涉及停止状态的调用点都必须一致地传 `abortKey`；任何一处漏传（例如新写的工具直接 `register(child, profileId)`）都会重新引入串扰。为降低风险，`BashTool` / `PwshTool` 保留了 `params.abortKey || params.profileId` 的降级写法，但降级路径本身仍是窗口级的，属于兜底而非正确路径。
- 会话 ID 在新建会话时可能从 `null` 变为真实值，若停止恰好发生在切换瞬间，键会漂移。这一点与项目里 `resolveSessionId` 注释已描述的既有风险同源，本次未额外处理。
- `BackgroundTaskTool.waitForDone` 的参数名从 `profileId` 改为 `abortKey`，语义变窄：它现在只接受复合键，传入裸 profileId 会被当作一个独立的（永不会被标记的）键，从而永远不返回中止状态——这是有意的严格化，但阅读旧代码的人容易误判。

## 备注

- 复合键构造：`tools/active-processes.js` 的 `abortKey()`
- 停止 / 清除：`src/main/ipc.js` 的 `abort-execution` / `clear-abort`
- 执行侧判断：`tools/JsRunner.js` 的 `run()` 与 `hostBridge`
- 进程归属：`tools/BashTool.js`、`tools/PwshTool.js`、`tools/BackgroundTaskTool.js`、`JsRunner.runBash()`
- 回归测试：`test/tools/JsRunner.test.js` 的「同窗口跨会话隔离」三条
