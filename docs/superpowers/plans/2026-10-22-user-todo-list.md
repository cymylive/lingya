# 用户手动待办清单 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans 逐任务实现本计划。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 在计划面板中新增一份用户自管的待办清单（可增删改、可勾选完成、按会话隔离持久化），与 AI 的 todoWrite 计划并排显示、互不干扰。

**Architecture:** 新建独立存储模块 `tools/UserTodoStore.js`（纯 Node，无 Electron 依赖，可单测），持久化到 `<userData>/lingya-user-todos.json`，按 `sessionId` 分键。主进程暴露 4 个 IPC（list/add/update/delete）+ 1 个广播事件。渲染在覆盖层计划页签与侧边栏计划视图两处，均复用同一套数据契约。

**Tech Stack:** Node.js CommonJS、Electron IPC、原生 DOM（无框架）、node:test

**Spec:** 本次对话中的 brainstorming 结论（两份独立数据 / 带勾选 / 置于 AI 计划上方）

## Global Constraints

- 存储文件：`<userData>/lingya-user-todos.json`，与 `lingya-todos.json` 完全分离，互不读写
- 会话键：优先 `sessionId`；无则 `'pending:' + profileId`
- 数据项结构：`{ id: string, text: string, done: boolean, createdAt: number }`
- `id` 由主进程生成（`ut_` + Date.now() + 随机后缀），前端不生成
- 文本长度上限 500 字符，空文本拒绝
- 所有写操作必须落盘（写文件）后才广播
- 现有 `lingya-todos.json` 与 todoWrite 链路**零改动**
- 现有测试 491 个必须全绿

## Review Focus

1. **会话切换时的竞态**：快速切换会话 A→B→A，旧会话的广播不能渲染到新会话面板上（现有 plan-panel 用 `currentSessionId` 过滤，新面板必须同样处理）
2. **空列表 vs 未加载**：未拿到数据时应显示"加载中"，拿到空数组才显示"暂无待办"，两者不可混淆
3. **粘贴多行的解析边界**：`1. xxx` / `- xxx` / `• xxx` 应拆条；但纯文本多行（如一段话换行）不应被误拆——只在**每行都带列表标记**时才拆
4. **编辑时的焦点丢失**：双击进入编辑后，若广播到达触发重渲染，正在编辑的输入框会消失。编辑期间必须暂停该列表的自动重渲染
5. **超长文本与 XSS**：文本必须转义后插入 DOM，长度超限前端也截断显示

---

### Task 1: 存储层 UserTodoStore

**Files:**
- Create: `tools/UserTodoStore.js`
- Test: `test/tools/UserTodoStore.test.js`

**Interfaces:**
- Produces:
  - `init(storeDir: string): void`
  - `list(sessionId: string|null, profileId: string|null): Array<{id, text, done, createdAt}>`
  - `add(sessionId, profileId, text: string): {id, text, done, createdAt}`（抛错：空文本 / 超 500 字）
  - `update(sessionId, profileId, id: string, patch: {text?, done?}): boolean`（false = id 不存在）
  - `remove(sessionId, profileId, id: string): boolean`
  - `clear(sessionId, profileId): void`
  - `parseBulk(text: string): string[]`（多行粘贴拆条）

- [ ] **Step 1: 写失败测试**

```js
test('add 生成唯一 id 并持久化', () => {
  init(tmpDir);
  const a = add('s1', 'p1', '买牛奶');
  assert.match(a.id, /^ut_/);
  assert.strictEqual(a.done, false);
  assert.strictEqual(list('s1', 'p1').length, 1);
});

test('add 拒绝空文本与超长文本', () => {
  assert.throws(() => add('s1', 'p1', ''), /empty/);
  assert.throws(() => add('s1', 'p1', 'x'.repeat(501)), /too long/);
});

test('会话隔离：s1 的待办不出现在 s2', () => {
  add('s1', 'p1', 'A');
  add('s2', 'p1', 'B');
  assert.deepStrictEqual(list('s2', 'p1').map(t => t.text), ['B']);
});

test('无 sessionId 时用 pending:profileId 分键', () => {
  add(null, 'p9', 'X');
  assert.deepStrictEqual(list(null, 'p9').map(t => t.text), ['X']);
});

test('update 改文本与勾选状态', () => {
  const a = add('s1', 'p1', 'old');
  assert.strictEqual(update('s1', 'p1', a.id, { text: 'new', done: true }), true);
  const got = list('s1', 'p1')[0];
  assert.strictEqual(got.text, 'new');
  assert.strictEqual(got.done, true);
});

test('update/remove 对不存在的 id 返回 false', () => {
  assert.strictEqual(update('s1', 'p1', 'nope', { done: true }), false);
  assert.strictEqual(remove('s1', 'p1', 'nope'), false);
});

test('parseBulk 按列表标记拆条', () => {
  assert.deepStrictEqual(parseBulk('1. 买菜\n2. 做饭'), ['买菜', '做饭']);
  assert.deepStrictEqual(parseBulk('- a\n- b\n• c'), ['a', 'b', 'c']);
});

test('parseBulk 纯文本多行不拆', () => {
  assert.deepStrictEqual(parseBulk('这是\n一段话'), ['这是\n一段话']);
});

test('重启后数据仍在（重新 init 读回）', () => {
  add('s1', 'p1', '持久化');
  init(tmpDir); // 模拟重启
  assert.deepStrictEqual(list('s1', 'p1').map(t => t.text), ['持久化']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/tools/UserTodoStore.test.js`
Expected: FAIL，`Cannot find module '../../tools/UserTodoStore'`

- [ ] **Step 3: 实现 UserTodoStore**

参照 `tools/TodoWriteTool.js:18-51` 的 readStore/writeStore/keyFor 模式，但**独立文件、独立 store 变量**。`parseBulk` 判定规则：拆分后若**每行**都匹配 `/^\s*(\d+[.、)]|[-*•])\s+/` 才拆，否则原样返回单元素数组。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/tools/UserTodoStore.test.js`
Expected: PASS，9/9

---

### Task 2: 主进程 IPC 与广播

**Files:**
- Modify: `src/main/index.js`（init 处，参照 `line 159` 的 todoStore 初始化）
- Modify: `src/main/ipc.js`（新增 4 个 handler + 广播，参照 `line 53-86` 的 todo 模式）
- Test: `test/main/user-todo-ipc.test.js`

**Interfaces:**
- Consumes: Task 1 的 `list/add/update/remove`
- Produces: IPC 通道
  - `user-todos-list` → `{success, todos, sessionId}`
  - `user-todos-add` `{text}` → `{success, todo}`
  - `user-todos-update` `{id, patch}` → `{success}`
  - `user-todos-delete` `{id}` → `{success}`
  - 广播事件 `lingya-user-todos-updated` `{sessionId, todos}`

- [ ] **Step 1: 写失败测试**

对 `ipc.js` 做结构断言（照 `test/preload/preload-init-order.test.js` 的源码扫描模式）：
- 源码中存在 4 个 `ipcMain.handle('user-todos-*`
- 每个 handler 都通过 `windowState.getContextByWebContents(event.sender)` 定位 ctx（**不得用活跃窗口**，这是本轮已修过的同类 bug）
- 写操作后存在 `lingya-user-todos-updated` 广播

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/main/user-todo-ipc.test.js`
Expected: FAIL，找不到 `user-todos-list`

- [ ] **Step 3: 实现 IPC**

在 `ipc.js` 的 `registerIpcHandlers()` 内，紧跟现有 todo handler 之后添加。广播函数照 `line 54-68`：遍历 `windowState.getAllContexts()`，同时发给 `ctx.win.webContents`（覆盖层）与 `ctx.rawWin.webContents`（侧边栏）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/main/user-todo-ipc.test.js`
Expected: PASS

---

### Task 3: preload API 暴露

**Files:**
- Modify: `src/preload/api.js`（参照 `line 148-155` 的 getTodos/onTodosUpdated）
- Modify: `src/preload/shell-preload.js`（参照 `line 39-40`）
- Test: `test/preload/user-todo-api.test.js`

**Interfaces:**
- Produces: `window.electronAPI.userTodosList/add/update/delete/onUserTodosUpdated` 与 `window.shellAPI` 同名方法

- [ ] **Step 1: 写失败测试**：源码断言两个 preload 文件都暴露了 5 个方法，且事件名拼写为 `lingya-user-todos-updated`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**：纯转发，无逻辑
- [ ] **Step 4: 运行确认通过**

---

### Task 4: 覆盖层计划页签 UI

**Files:**
- Modify: `src/preload/overlay/template.js`（`line 93-100` 的 plan 页签内，在「任务计划」section **之前**插入新区块）
- Modify: `src/preload/overlay/plan-panel.js`
- Test: `test/preload/user-todo-panel.test.js`

**Interfaces:**
- Consumes: Task 3 的 `window.electronAPI.*`
- Produces: `bindUserTodoPanel()`，由 `bindPlanPanelEvents()` 调用

- [ ] **Step 1: 写失败测试**（源码结构断言 + 纯函数测试）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 HTML**

在 plan 页签内插入：
```html
<div class="lingya-section">
  <div class="lingya-plan-head">
    <span class="lingya-label">我的待办</span>
    <span id="lingya-utodo-count" class="lingya-plan-count">0/0</span>
  </div>
  <div id="lingya-utodo-list" class="lingya-plan-list"></div>
  <div class="lingya-utodo-add">
    <textarea id="lingya-utodo-input" placeholder="添加待办…（支持 1. xxx 多行粘贴）" rows="1"></textarea>
    <button id="lingya-utodo-add-btn" title="添加">+</button>
  </div>
</div>
```

- [ ] **Step 4: 实现 JS 逻辑**（`plan-panel.js`）

关键点（对应 Review Focus）：
- `editingId` 变量：编辑期间 `renderUserTodos` 直接 return（防焦点丢失）
- `currentSessionId` 复用现有变量，广播到达时做会话过滤
- 文本一律经 `escapeHtml`（该文件已有）
- 添加：`parseBulk` 在存储层，前端只传原始文本
- 勾选：click 事件 → `update(id, {done: !done})`
- 编辑：双击 → 替换为 input → 回车保存 / Esc 取消 / blur 保存
- 删除：右侧 `×`，hover 显示

- [ ] **Step 5: 运行确认通过**

---

### Task 5: 侧边栏计划视图同步

**Files:**
- Modify: `src/preload/shell-renderer.js`（`line 1021` 的 `renderPlanView`）
- Test: `test/preload/user-todo-sidebar.test.js`

**Interfaces:**
- Consumes: Task 3 的 `window.shellAPI.*`

- [ ] **Step 1: 写失败测试**：源码断言 `renderPlanView` 内含 `sh-utodo` 前缀的 DOM id 与 `userTodosList` 调用
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**：在「任务计划」区块**之前**渲染「我的待办」，交互与覆盖层一致但样式使用侧边栏的 `sh-` 类名体系
- [ ] **Step 4: 运行确认通过**

---

### Task 6: 全量回归与手工验证

- [ ] **Step 1: 跑全量测试**

Run: `node --test --test-concurrency=1 test/tools/*.test.js test/main/*.test.js test/preload/*.test.js`
Expected: 491 + 新增 ≈ 520 全绿，0 fail

- [ ] **Step 2: 手工验证清单**（打包后）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 会话 A 加 3 条待办 | 立即出现在列表，计数 0/3 |
| 2 | 点第 1 条勾选 | 划掉，计数 1/3 |
| 3 | 双击第 2 条改名 | 行内编辑，回车生效 |
| 4 | 删第 3 条 | 消失，计数 1/2 |
| 5 | 切到会话 B | 列表为空（不串会话） |
| 6 | B 加 1 条，切回 A | A 的 2 条还在 |
| 7 | 完全重启 LingYa，回会话 A | 2 条仍在 |
| 8 | 输入框粘贴 `1. a\n2. b` | 拆成 2 条 |
| 9 | AI 调 todoWrite | 「我的待办」完全不受影响 |
| 10 | 两个窗口同时操作 | 各改各的，互不串 |

- [ ] **Step 3: 更新 CHANGELOG**
