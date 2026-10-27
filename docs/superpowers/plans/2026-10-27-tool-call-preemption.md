# 工具调用抢占与执行态锁定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新回复含工具调用时，抢占并销毁同会话内上一轮未完成的工具执行；工具执行期间在面板持续锁定显示执行态。

**Architecture:** 在 `active-processes` 给子进程增加 kind 标记以区分前后台，新增 `killForeground(key)` 只杀前台；在 `intercept-observer` 的回复入队前检测是否含 lingya 代码块，命中则先 markAborted + killForeground 打断上一轮，旧调用拿到失败结果后丢弃不回传；被抢占的一方回传 `{success:false, error:'被新的工具调用抢占'}`。状态机层面新调用直接 EXECUTING，跳过 queued 显示。

**Tech Stack:** Node.js (CommonJS) + Electron preload，测试用 `node --test`

**Spec:** 本对话中的决策（C 失败回传 / B 仅工具调用抢占 / 后台任务排除且持续显示）

## Global Constraints

- 不改动 `bashBackground` 的现有行为：后台任务不受抢占影响，只在 `bashKill` 或进程自然结束时消失
- 抢占隔离粒度沿用 `activeProcesses.abortKey(profileId, sessionId)`，不跨会话
- 面板后台任务显示沿用 `ui.js` 现有 `backgroundTasks` Map 与 `renderTaskbar` 的 bgCount 分支，不新建通道
- 纯聊天回复（不含 lingya 代码块）不触发抢占

## Review Focus

- 抢占时机：必须在 `enqueueProcessing` **之前**判断，否则旧任务已经占住队列，新回复仍要排队
- 后台任务误杀：`killForeground` 若未正确过滤 kind，会杀掉正在跑的服务/构建进程，用户不可恢复
- 状态卡死：抢占后若未把旧调用标记为失败并清理状态机，面板可能永久停在 EXECUTING
- 跨会话污染：abortKey 必须带 sessionId，否则在 A 会话发消息会打断 B 会话的任务
- 无工具调用的回归：普通聊天回复不能触发任何 kill，否则用户提问会打断正在跑的构建

---

### Task 1: active-processes 支持前后台标记与只杀前台

**Files:**
- Modify: `tools/active-processes.js`
- Modify: `tools/BashTool.js:135`
- Modify: `tools/PwshTool.js:138`
- Modify: `tools/BackgroundTaskTool.js:68`
- Test: `test/tools/active-processes.test.js`

**Interfaces:**
- Consumes: 现有 `register(child, key)` / `killAll(key)` / `abortKey(profileId, sessionId)`
- Produces:
  - `register(child, key, kind)` —— kind 可选，取值 `'foreground'` | `'background'`，默认 `'foreground'`
  - `killForeground(key)` → `number` —— 只杀属于该 key 且 kind 为 foreground 的进程，返回杀掉的个数
  - `killAll(key)` 行为不变（仍然杀该 key 下全部）

- [ ] **Step 1: 写失败测试**

```js
// test/tools/active-processes.test.js 追加
test('register 默认 kind 为 foreground', () => {
  const fake = { kill() {}, pid: 1 };
  activeProcesses.register(fake, 'k1');
  assert.strictEqual(activeProcesses.getKind(fake), 'foreground');
  activeProcesses.unregister(fake);
});

test('register 可标记 background', () => {
  const fake = { kill() {}, pid: 2 };
  activeProcesses.register(fake, 'k2', 'background');
  assert.strictEqual(activeProcesses.getKind(fake), 'background');
  activeProcesses.unregister(fake);
});

test('killForeground 只杀前台，不碰后台', () => {
  const fg = { pid: 3, killed: false, kill() { this.killed = true; } };
  const bg = { pid: 4, killed: false, kill() { this.killed = true; } };
  activeProcesses.register(fg, 'k3');
  activeProcesses.register(bg, 'k3', 'background');
  const n = activeProcesses.killForeground('k3');
  assert.strictEqual(n, 1);
  assert.strictEqual(fg.killed, true);
  assert.strictEqual(bg.killed, false);
  activeProcesses.unregister(bg);
});

test('killForeground 不影响其他 key', () => {
  const a = { pid: 5, killed: false, kill() { this.killed = true; } };
  activeProcesses.register(a, 'k4');
  activeProcesses.killForeground('k5');
  assert.strictEqual(a.killed, false);
  activeProcesses.unregister(a);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/tools/active-processes.test.js`
Expected: FAIL —— `getKind is not a function` / `killForeground is not a function`

- [ ] **Step 3: 实现 kind 记录与 killForeground**

在 `tools/active-processes.js`：
- 新增 `const kindMap = new WeakMap();`
- `register(child, key, kind)` 内 `kindMap.set(child, kind === 'background' ? 'background' : 'foreground')`
- 新增 `getKind(child)` 返回 `kindMap.get(child) || 'foreground'`
- 新增 `killForeground(key)`：逻辑同 `killAll`，但 `if (getKind(child) !== 'foreground') continue;`
- `killAll` 保持不变
- 导出 `getKind`, `killForeground`

- [ ] **Step 4: 三个调用点标记 kind**

- `BashTool.js:135` → `activeProcesses.register(child, key, 'foreground')`
- `PwshTool.js:138` → 同上
- `BackgroundTaskTool.js:68` → `activeProcesses.register(child, key, 'background')`

- [ ] **Step 5: 跑测试**

Run: `node --test test/tools/active-processes.test.js`
Expected: 全部 PASS（含原有 10 个用例）

- [ ] **Step 6: Commit**

```bash
git add tools/active-processes.js tools/BashTool.js tools/PwshTool.js tools/BackgroundTaskTool.js test/tools/active-processes.test.js
git commit -m "feat(process): 区分前后台子进程，新增 killForeground"
```

---

### Task 2: 回复含工具调用时抢占上一轮

**Files:**
- Modify: `src/preload/dom/intercept-observer.js`（`lingya-ai-response` 监听器 + 新增 `preemptPreviousRun`）
- Test: `test/preload/intercept-preempt.test.js`（新建）

**Interfaces:**
- Consumes: `activeProcesses.killForeground` 的 IPC 封装（Task 3 提供）、`extractJsToolBlocks`
- Produces:
  - `preemptPreviousRun(profileId, sessionId)` → `Promise<{killed:number}>`
  - 抢占后旧脚本的下一次 hostBridge 调用拿到 `{success:false, error:'被新的工具调用抢占'}`

- [ ] **Step 1: 写失败测试**

```js
// test/preload/intercept-preempt.test.js
const test = require('node:test');
const assert = require('node:assert');

test('含 lingya 代码块的回复应触发抢占判定', () => {
  const { shouldPreempt } = require('../../src/preload/dom/intercept-preempt');
  assert.strictEqual(shouldPreempt('普通聊天回复'), false);
  assert.strictEqual(shouldPreempt('```lingya\nawait bash("ls");\n```'), true);
});

test('空文本不触发抢占', () => {
  const { shouldPreempt } = require('../../src/preload/dom/intercept-preempt');
  assert.strictEqual(shouldPreempt(''), false);
  assert.strictEqual(shouldPreempt(null), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/preload/intercept-preempt.test.js`
Expected: FAIL —— Cannot find module 'intercept-preempt'

- [ ] **Step 3: 新建 intercept-preempt.js**

```js
// src/preload/dom/intercept-preempt.js
const { extractJsToolBlocks } = require('./js-detector');

function shouldPreempt(text) {
  if (!text || typeof text !== 'string') return false;
  return extractJsToolBlocks(text).length > 0;
}

async function preemptPreviousRun(profileId, sessionId) {
  try {
    const api = window.electronAPI;
    if (!api || typeof api.preemptExecution !== 'function') return { killed: 0 };
    const r = await api.preemptExecution({ profileId, sessionId });
    return { killed: (r && r.killed) || 0 };
  } catch (_) {
    return { killed: 0 };
  }
}

module.exports = { shouldPreempt, preemptPreviousRun };
```

- [ ] **Step 4: 跑测试**

Run: `node --test test/preload/intercept-preempt.test.js`
Expected: PASS

- [ ] **Step 5: 接入监听器**

在 `intercept-observer.js` 的 `lingya-ai-response` 处理里，`enqueueProcessing(...)` **之前**插入：

```js
if (shouldPreempt(detail.text)) {
  const profileId = null; // 由主进程按 webContents 兜底
  const sessionId = (taskState.snapshot() || {}).sessionId || null;
  preemptPreviousRun(profileId, sessionId).then((r) => {
    if (r.killed > 0) {
      console.log('[LingYa][抢占] 已中断上一轮工具调用，杀掉进程 ' + r.killed + ' 个');
    }
  }).catch(() => {});
}
```

- [ ] **Step 6: Commit**

```bash
git add src/preload/dom/intercept-preempt.js src/preload/dom/intercept-observer.js test/preload/intercept-preempt.test.js
git commit -m "feat(preempt): 含工具调用的回复抢占上一轮执行"
```

---

### Task 3: 主进程 preemptExecution IPC

**Files:**
- Modify: `src/main/ipc.js`（在 `abort-execution` 旁新增 handler）
- Modify: `src/preload/api.js`（暴露 `preemptExecution`）
- Test: `test/main/preempt-ipc.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 的 `activeProcesses.killForeground` / `markAborted` / `abortKey`
- Produces: IPC 通道 `preempt-execution`，入参 `{profileId, sessionId}`，返回 `{success:true, killed:number}`

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const activeProcesses = require('../../tools/active-processes');

test('preempt 后 abortKey 处于 aborted 状态', () => {
  const key = activeProcesses.abortKey('p1', 's1');
  activeProcesses.markAborted(key);
  assert.strictEqual(activeProcesses.isAborted(key), true);
  activeProcesses.clearAborted(key);
  assert.strictEqual(activeProcesses.isAborted(key), false);
});

test('preempt 清理不影响后台进程', () => {
  const bg = { pid: 99, killed: false, kill() { this.killed = true; } };
  const key = activeProcesses.abortKey('p2', 's2');
  activeProcesses.register(bg, key, 'background');
  const n = activeProcesses.killForeground(key);
  assert.strictEqual(n, 0);
  assert.strictEqual(bg.killed, false);
  activeProcesses.unregister(bg);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/main/preempt-ipc.test.js`
Expected: FAIL（killForeground 未导出前）

- [ ] **Step 3: 在 ipc.js 新增 handler**

紧邻 `abort-execution`：

```js
ipcMain.handle('preempt-execution', async (event, payload) => {
  const profileId = (payload && payload.profileId) || resolveProfileId(event);
  const sessionId = (payload && payload.sessionId) || null;
  const key = activeProcesses.abortKey(profileId, sessionId);
  activeProcesses.markAborted(key);
  const killed = activeProcesses.killForeground(key);
  return { success: true, killed };
});
```

- [ ] **Step 4: api.js 暴露**

```js
preemptExecution: (payload) => ipcRenderer.invoke('preempt-execution', payload || {}),
```

- [ ] **Step 5: 跑测试**

Run: `node --test test/main/preempt-ipc.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.js src/preload/api.js test/main/preempt-ipc.test.js
git commit -m "feat(ipc): 新增 preempt-execution 通道"
```

---

### Task 4: 被抢占方返回失败 + 状态机跳过 queued

**Files:**
- Modify: `tools/JsRunner.js:410`（aborted 时的错误文案区分）
- Modify: `src/preload/dom/intercept-observer.js`（新调用直接 EXECUTING）
- Modify: `src/preload/dom/tool-executor.js:101,213`（setTaskbarDetail 已存在，确认工具名）
- Test: `test/tools/jsrunner-preempt.test.js`（新建）

**Interfaces:**
- Consumes: Task 1/3 的 abort 机制
- Produces: aborted 状态下 hostBridge 返回 `{success:false, error:'被新的工具调用抢占，本次执行已中止'}`

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');

test('aborted 后工具调用返回抢占错误文案', async () => {
  const { PREEMPT_ERROR } = require('../../tools/active-processes');
  assert.match(PREEMPT_ERROR, /抢占/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools/jsrunner-preempt.test.js`
Expected: FAIL —— PREEMPT_ERROR undefined

- [ ] **Step 3: 导出常量并在 JsRunner 使用**

`tools/active-processes.js` 增加：
```js
const PREEMPT_ERROR = '被新的工具调用抢占，本次执行已中止';
module.exports.PREEMPT_ERROR = PREEMPT_ERROR;
```

`tools/JsRunner.js:410` 改为：
```js
if (activeProcesses.isAborted(abortKey)) {
  return JSON.stringify({ success: false, error: activeProcesses.PREEMPT_ERROR });
}
```

- [ ] **Step 4: 新调用跳过 queued**

`intercept-observer.js` 的 `processInterceptedResponse` 命中 `jsBlocks.length > 0` 分支时，在 `transition(EXECUTING)` 前加：
```js
try { taskState.setQueued(false); } catch (_) {}
```
确保抢占后 UI 立刻显示执行态而非「排队等待」。

- [ ] **Step 5: 跑测试**

Run: `node --test test/tools/jsrunner-preempt.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/active-processes.js tools/JsRunner.js src/preload/dom/intercept-observer.js test/tools/jsrunner-preempt.test.js
git commit -m "feat(preempt): 被抢占方返回失败并跳过排队态"
```

---

### Task 5: 全量回归

- [ ] **Step 1: 跑全量测试**

Run: `node --test --test-concurrency=1 test/tools/*.test.js test/main/*.test.js test/preload/*.test.js`
Expected: 全部 PASS，无新增失败

- [ ] **Step 2: 手工验证清单**（用户执行）
  - 发一条会跑 `bashOutput({wait:120000})` 的指令
  - 在等待中再发一条含工具调用的指令
  - 期望：旧调用被中止，面板立刻显示新工具执行态，后台任务仍在跑
  - 再发一条纯聊天消息
  - 期望：不打断任何正在执行的任务

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: 抢占功能全量回归通过"
```
