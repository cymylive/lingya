# 监督催促统一闸门改造

**Goal:** 把「要不要催」的决策从三条独立路径收敛成一个纯函数闸门。

**Architecture:** 新增 `src/preload/dom/nudge-policy.js` 导出 `decide(ctx)` → `{ action, reason }`。三条路径（supervisor 定时、回复后即时续跑、中断兜底）都调它，只在 action === 'nudge' 时才发催促；'correct' 时发格式纠错。

**Tech Stack:** CommonJS / node:test

## Global Constraints

- 用户选择：中断兜底保留无条件触发（只加格式检测），弱等待改为永久不催
- 现有 799 测试必须全绿
- 不改数据结构，只改判断逻辑

## 闸门（按顺序，命中即返回）

1. `stopped` → skip
2. `awaitingNextInitialChunk` → skip
3. 会话未激活（`!sessionId || !activatedSessions.has(sessionId)`）→ skip
4. `awaitingUserInput`（强/弱一视同仁，2B）→ skip
5. `xmlDetected` → **correct**（不是 skip，发格式纠错）
6. `taskDeclaredDone` → skip
7. `enabled === false` → skip
8. `count >= max` → skip（降频由调用方处理）

## 任务

### Task 1: nudge-policy 纯函数 + 测试
新建 `src/preload/dom/nudge-policy.js` 与 `test/preload/nudge-policy.test.js`。
TDD：先写覆盖 8 道闸门 + 优先级顺序的测试，再实现。

### Task 2: supervisor.js 接入
`supervisor.js` 的定时检查改为先调 `decide()`，action 非 'nudge' 时跳过。
保留原有的 idleMs 时间窗判断（在 decide 之前）。

### Task 3: continueIfPlanUnfinished 接闸门
`intercept-observer.js:439` 的 continueIfPlanUnfinished 改为先调 decide()。
返回 action === 'correct' 时走格式纠错路径。

### Task 4: 中断分支补检测链
`intercept-observer.js:594-603` 的中断分支，在 continueIfPlanUnfinished 之前先跑 XML 检测和 judgeUserWait。

### Task 5: continueOnInterruptFallback 只加格式检测
按 1A：保留无条件触发，但 xmlDetected 时改发纠错。

### Task 6: 弱等待永久不催
`supervisor.js:250-267` 去掉 3 分钟超时逻辑，awaitingUserInput 一律 return。
`state.js:113` 注释更新。

### Task 7: 全量测试 + mutation 验证
