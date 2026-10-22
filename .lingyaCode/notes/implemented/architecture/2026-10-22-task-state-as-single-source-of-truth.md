# Agent Note: 任务状态机是 UI 的唯一真相源

Status: implemented

## Problem

LingYa 的「任务进行中」提示由多处手动开关拼成：`tool-executor` 在执行前后调 `setTaskStatus(true/false)`，`intercept-observer` 在生成开始/结束时调 `setFabState('generating'/'idle')`，`supervisor` 在判定卡死时强制复位，生成超时定时器到点又静默打回 idle。

这套「各自开关」的写法有三个结构性缺陷：

1. **漏调即失明**。任何一条路径忘记调用，或调用顺序错乱，UI 就停在上一个状态。用户看到的是「AI 说了要调工具，界面上什么都没有」，从而误判工具没执行。
2. **后台任务无归属**。`bashBackground` 起的服务在 AI 一轮对话结束后仍在运行，但状态机已回 IDLE，界面上没有任何地方能表达「还有个 npm run dev 在跑」。
3. **无法回答「等了多久」**。没有统一的时间基准，无法给用户展示「已执行 3m24s」，长时间等待时用户只能靠猜。

状态机 `task-state.js` 早已存在（SENT/AWAITING/RESPONDED/EXECUTING/IDLE），但它只是被动被写入，没有任何订阅者——是个「有记录没人读」的账本。

## Decision

把 `task-state.js` 提升为**任务状态的唯一真相源**，UI 降级为它的订阅者：

- `task-state` 新增 `onChange(cb)` 订阅机制，`transition/touch/reset` 内部统一 `notify()`。新订阅者立即收到当前快照，避免 UI 空白。
- 新增 `startTicker()` 秒级心跳（有订阅者才推），使「已用时」持续走动。**心跳不判断 IDLE**——状态机可能空闲但后台任务仍在跑。
- 新增 `describe()` / `isBusy()` / `elapsedMs()`，把状态语义收敛到状态机，UI 不再自己拼文案。
- UI 侧新增 `#lingya-taskbar` 常驻状态条，只做一件事：订阅状态机并渲染。状态条**不持有任何业务判断**。
- 后台任务单独登记（`ui.js` 的 `backgroundTasks` Map）：`bashBackground` 成功时按返回文本里的 `任务 ID: bg_xxx` 登记，`bashOutput` 显示完成 / `bashKill` / 用户点停止时注销。**只要登记表非空，即使状态机 IDLE，状态条也保持可见**。
- 用户点停止时调 `clearBackgroundTasks()`，避免状态条挂着不消失。

## Alternatives considered

**继续在每处调用点补 `setTaskStatus`** —— 落选原因：这正是问题的成因。补一处还会有下一处漏；且新增检测机制（如 DOM 兜底、未来的新兜底路径）必须记得同步 UI，属于「靠自觉」的约定。LingYa 历史上的反复返工都源于此。

**让 supervisor 定时轮询状态机并刷新 UI** —— 落选原因：supervisor 的检查间隔是 30 秒，用它做 UI 刷新意味着用户最多 30 秒看不到状态变化，反馈严重滞后。且 supervisor 的职责是「兜底催促」，混入 UI 渲染会破坏单一职责。

**把后台任务也建成状态机的一个状态（如 BACKGROUND）** —— 落选原因：后台任务与 Agent 循环是**并行**关系而非先后关系。AI 可能同时在生成回复且后台有服务在跑。塞进同一个状态枚举会导致两者互斥，语义错误。改为独立登记表叠加显示。

**状态条固定在页面顶部（而非面板底部 sticky）** —— 落选原因：LingYa 的覆盖层面板本身是可滚动容器，顶部会被页签栏占据；底部 sticky 在滚动时始终可见，且靠近「停止」按钮，符合「看着进度、随时能停」的使用动线。

## Consequences

**收益**：
- 任何检测机制只要走状态机，UI 必然同步，不存在「某条路径忘了通知 UI」的失明场景
- 后台任务有了可见载体，长跑服务不再静默
- 有统一时间基准，可以展示精确的已用时
- UI 侧代码从「多处分散调用」收敛为「一个订阅 + 一个渲染函数」，删掉任一处业务逻辑都不会影响显示

**代价**：
- `task-state.js` 从纯记账模块变成了带副作用的发布者。订阅者抛异常必须被捕获（已在 `notify()` 内 try/catch），否则会污染状态切换本身
- 秒级心跳增加极少量开销（仅在有订阅者时推送，单次回调只做 DOM 文本更新）
- 后台任务登记依赖解析 `bashBackground` 的返回文本格式，格式若变更需同步调整

## 备注

- 状态条渲染入口：`src/preload/overlay/ui.js` 的 `renderTaskbar()`
- 订阅启动点：`src/preload/index.js` 的 `ui.startTaskbar()`（紧随 `injectOverlay()` 之后）
- 后台任务登记点：`src/preload/dom/tool-executor.js` 的 `handleToolCall()` 成功分支
