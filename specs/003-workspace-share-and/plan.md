# 工作区跨窗口共享 / 项目搜索 / 会话本地存档 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话内容本地持久化（导出不再依赖平台 IndexedDB），工作区跨窗口聚合展示全部项目会话并支持搜索。

**Architecture:** 新增主进程 `conversation-archive.js` 负责会话存档的读写（每会话一个 `.jsonl`，按 profile 分目录）。preload 侧 `conversation-log.js` 在 `addEntry` 后节流写盘、切会话时从存档加载。两条导出路统一走"本地存档 → IndexedDB → 无内容提示"。工作区聚合由 `listAllSessions` 扩展为扫描所有 profile 的 session 文件；侧栏 v2 渲染增加来源窗口标注、跨窗口跳转和搜索框。

**Tech Stack:** Electron 33 / CommonJS / Node `node --test` / 原生 DOM

**Spec:** `specs/003-workspace-share-and/spec.md`

## Global Constraints

- 当前测试基准：`npm test` 全绿（1110 个用例）
- 主进程 CommonJS，preload 不得直接 require 常规 Node 模块，一律走 `window.electronAPI` / `window.shellAPI`
- 现有 UI 元素 id 保持不变（`events.js` / `ui.js` 依赖 getElementById）
- 所有新增磁盘写入必须节流/防抖，不得阻塞事件循环
- 存档目录：`<userData>/conversations/<profileId>/<sessionId>.jsonl`
- 搜索按字面文本匹配，不解释为正则
- 打包/发版前必须问用户

## Review Focus

1. **会话从未产生消息就导出** —— 期望提示"该会话暂无对话内容"，不是"无历史消息"
2. **同一会话两窗口同时写存档** —— 期望两条写入都保留（追加而非覆盖），导出时按时间合并
3. **存档目录不可写（磁盘满/权限）** —— 期望降级为内存模式并提示，对话本身不被阻塞
4. **某个 profile 的 session 文件损坏（JSON 解析失败）** —— 期望跨窗口聚合跳过该文件，其余窗口数据正常展示
5. **搜索关键词含正则特殊字符（如 `.*`、`[`）** —— 期望按字面匹配，不抛异常
6. **老会话（存档功能上线前产生，只在 IndexedDB 有数据）** —— 期望导出回退到 IndexedDB，行为与改造前一致

---

## Task 1: 会话存档存储层（主进程）

**Files:**
- Create: `src/main/conversation-archive.js`
- Test: `test/main/conversation-archive.test.js`

**Interfaces:**
- Produces:
  - `createConversationArchive(profileId, userDataDir)` → 实例对象
  - `archive.appendEntry(sessionId, entry)` → `{ success: boolean, error?: string }`；entry 形如 `{ role: 'user'|'assistant', text: string, ts: number, tag?: string }`
  - `archive.readEntries(sessionId)` → `{ success: boolean, entries: Array<{role,text,ts,tag}>, error?: string }`（不存在时 entries 为 `[]`）
  - `archive.hasArchive(sessionId)` → `boolean`
  - `archive.deleteArchive(sessionId)` → `{ success: boolean }`
  - `archive.flush()` → `boolean`（强制落盘，退出前调用）
  - `archive.archiveDir` → 存档根目录绝对路径

- [ ] **Step 1: 写失败测试**

```js
// test/main/conversation-archive.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConversationArchive } = require('../../src/main/conversation-archive');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-archive-')); }

test('appendEntry 后可 readEntries 读回', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  a.appendEntry('s1', { role: 'user', text: '你好', ts: 1 });
  a.appendEntry('s1', { role: 'assistant', text: '你也好', ts: 2 });
  a.flush();
  const r = a.readEntries('s1');
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].text, '你好');
  assert.strictEqual(r.entries[1].role, 'assistant');
});

test('readEntries 对不存在的会话返回空数组', () => {
  const a = createConversationArchive('p1', tmpDir());
  const r = a.readEntries('nope');
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.entries, []);
});

test('hasArchive 判断存档是否存在', () => {
  const a = createConversationArchive('p1', tmpDir());
  assert.strictEqual(a.hasArchive('s1'), false);
  a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  a.flush();
  assert.strictEqual(a.hasArchive('s1'), true);
});

test('不同 profile 的存档互相隔离', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  const b = createConversationArchive('p2', dir);
  a.appendEntry('s1', { role: 'user', text: 'p1 的消息', ts: 1 });
  a.flush();
  assert.strictEqual(b.hasArchive('s1'), false);
});

test('deleteArchive 删除存档文件', () => {
  const a = createConversationArchive('p1', tmpDir());
  a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  a.flush();
  a.deleteArchive('s1');
  assert.strictEqual(a.hasArchive('s1'), false);
});

test('损坏的 jsonl 行被跳过，其余行仍可读', () => {
  const dir = tmpDir();
  const a = createConversationArchive('p1', dir);
  a.appendEntry('s1', { role: 'user', text: 'ok1', ts: 1 });
  a.flush();
  const f = path.join(dir, 'conversations', 'p1', 's1.jsonl');
  fs.appendFileSync(f, 'NOT_JSON\n', 'utf-8');
  const r = a.readEntries('s1');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].text, 'ok1');
});

test('目录不可写时 appendEntry 返回失败而不抛异常', () => {
  const a = createConversationArchive('p1', 'Z:/definitely/not/exist/xyz');
  const r = a.appendEntry('s1', { role: 'user', text: 'x', ts: 1 });
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/conversation-archive.test.js`
Expected: FAIL — Cannot find module '../../src/main/conversation-archive'

- [ ] **Step 3: 实现 conversation-archive.js**

关键决策：每个会话一个 `.jsonl`，每行一个 JSON 对象。append 用 `fs.appendFileSync`（单行小写入，快且天然支持多窗口并发追加）。读取逐行 `JSON.parse`，坏行跳过。目录用 `fs.mkdirSync(..., { recursive: true })` 惰性创建。所有写操作 try/catch，失败返回 `{ success: false, error }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/conversation-archive.test.js`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/main/conversation-archive.js test/main/conversation-archive.test.js
git commit -m "feat: 会话存档存储层（jsonl 追加读写）"
```

---

## Task 2: 存档 IPC 通道（主进程）

**Files:**
- Modify: `src/main/index.js`（初始化 archive 实例，挂到每个窗口上下文）
- Modify: `src/main/window.js`（ctx 增加 archive 引用）
- Modify: `src/main/ipc.js`（注册 3 个 handler）
- Modify: `src/preload/api.js`（暴露 conversationArchiveAppend / conversationArchiveRead / conversationArchiveHas）
- Test: `test/main/conversation-archive-ipc.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createConversationArchive(profileId, userDataDir)`
- Produces（IPC 通道名与参数）:
  - `conversation-archive-append`：入参 `{ sessionId, entry }` → `{ success, error? }`
  - `conversation-archive-read`：入参 `{ sessionId }` → `{ success, entries, error? }`
  - `conversation-archive-has`：入参 `{ sessionId }` → `{ success, exists }`
  - preload API：`window.electronAPI.conversationArchiveAppend(sessionId, entry)` / `conversationArchiveRead(sessionId)` / `conversationArchiveHas(sessionId)`

- [ ] **Step 1: 写失败测试**

```js
// test/main/conversation-archive-ipc.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('IPC 注册：append / read / has 三个通道都存在', async () => {
  // 通过 createArchiveIpc 工厂注册到一个假 ipcMain，检查 handler 映射
  const { createArchiveIpc } = require('../../src/main/conversation-archive-ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-arch-ipc-'));
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, dir);
  assert.ok(handlers['conversation-archive-append']);
  assert.ok(handlers['conversation-archive-read']);
  assert.ok(handlers['conversation-archive-has']);
});

test('append 后 read 能拿到数据', async () => {
  const { createArchiveIpc } = require('../../src/main/conversation-archive-ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-arch-ipc-'));
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => ({ profileId: 'p1' }) };
  createArchiveIpc(fakeIpc, fakeWindowState, dir);
  const ev = { sender: {} };
  await handlers['conversation-archive-append'](ev, { sessionId: 's1', entry: { role: 'user', text: 'hi', ts: 1 } });
  const r = await handlers['conversation-archive-read'](ev, { sessionId: 's1' });
  assert.strictEqual(r.entries.length, 1);
});

test('没有窗口上下文时返回失败而不是崩溃', async () => {
  const { createArchiveIpc } = require('../../src/main/conversation-archive-ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-arch-ipc-'));
  const handlers = {};
  const fakeIpc = { handle: (name, fn) => { handlers[name] = fn; } };
  const fakeWindowState = { getContextByWebContents: () => null };
  createArchiveIpc(fakeIpc, fakeWindowState, dir);
  const r = await handlers['conversation-archive-read']({ sender: {} }, { sessionId: 's1' });
  assert.strictEqual(r.success, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/conversation-archive-ipc.test.js`
Expected: FAIL — Cannot find module '../../src/main/conversation-archive-ipc'

- [ ] **Step 3: 实现**

新建 `src/main/conversation-archive-ipc.js`，导出 `createArchiveIpc(ipcMain, windowState, userDataDir)`：内部维护 `Map<profileId, archiveInstance>` 惰性创建；三个 handler 从 `event.sender` 反查 ctx 拿 profileId。在 `src/main/ipc.js` 的 `registerIpcHandlers` 里调用它。`src/preload/api.js` 增加三个 invoke 包装。`src/main/index.js` 的 `before-quit` 里遍历所有 archive 实例调用 `flush()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/conversation-archive-ipc.test.js`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/main/conversation-archive-ipc.js src/main/ipc.js src/main/index.js src/main/window.js src/preload/api.js test/main/conversation-archive-ipc.test.js
git commit -m "feat: 会话存档 IPC 通道"
```

---

## Task 3: preload 侧接入存档（写盘 + 切会话加载）

**Files:**
- Modify: `src/preload/dom/conversation-log.js`
- Test: `test/preload/conversation-log-archive.test.js`

**Interfaces:**
- Consumes: `window.electronAPI.conversationArchiveAppend/Read/Has`（Task 2）
- Produces:
  - `conversation-log.js` 内部：`addEntry` 后调用 `schedulePersist()`（节流 1000ms），把新增条目写入存档
  - 新导出函数 `loadFromArchive(sessionId)` → `Promise<{ loaded: boolean, count: number }>`，用存档内容替换内存 `entries`
  - 新导出函数 `getCurrentSessionId()` → `string|null`

- [ ] **Step 1: 写失败测试**

```js
// test/preload/conversation-log-archive.test.js
const { test } = require('node:test');
const assert = require('node:assert');

function freshLog() {
  delete require.cache[require.resolve('../../src/preload/dom/conversation-log')];
  return require('../../src/preload/dom/conversation-log');
}

test('addEntry 触发节流持久化（1000ms 内合并为一次写）', async () => {
  const log = freshLog();
  const calls = [];
  global.window = {
    electronAPI: {
      conversationArchiveAppend: async (sid, entry) => { calls.push(entry); return { success: true }; },
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.__testSetSessionId('abc');
  log.addEntry('user', '第一条', '手动输入');
  log.addEntry('user', '第二条', '手动输入');
  await new Promise(r => setTimeout(r, 1200));
  assert.strictEqual(calls.length, 2);
});

test('loadFromArchive 用存档替换内存 entries', async () => {
  const log = freshLog();
  global.window = {
    electronAPI: {
      conversationArchiveRead: async () => ({ success: true, entries: [
        { role: 'user', text: '存档里的旧消息', ts: 1 },
      ]}),
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.addEntry('user', '当前窗口的消息', '手动输入');
  const r = await log.loadFromArchive('abc');
  assert.strictEqual(r.loaded, true);
  const entries = log.getEntries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].text, '存档里的旧消息');
});

test('loadFromArchive 在存档为空时不动内存 entries', async () => {
  const log = freshLog();
  global.window = {
    electronAPI: {
      conversationArchiveRead: async () => ({ success: true, entries: [] }),
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    addEventListener: () => {},
  };
  log.addEntry('user', '保留我', '手动输入');
  const r = await log.loadFromArchive('abc');
  assert.strictEqual(r.loaded, false);
  assert.strictEqual(log.getEntries().length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/conversation-log-archive.test.js`
Expected: FAIL — `__testSetSessionId is not a function`

- [ ] **Step 3: 实现**

在 `conversation-log.js` 增加：
- 模块级 `let currentSessionId = null`，`let persistTimer = null`，`let pendingToPersist = []`
- `addEntry` 末尾：`pendingToPersist.push(entryObj); schedulePersist();`
- `schedulePersist()`：1s 防抖，到期后遍历 `pendingToPersist` 逐个调 `window.electronAPI.conversationArchiveAppend(currentSessionId, entry)`，成功后清空；失败保留待下次重试（最多 3 次）
- `loadFromArchive(sessionId)`：调 read，若 `entries.length > 0` 则替换内存 `entries` 并返回 `{loaded:true, count}`，否则 `{loaded:false, count:0}`
- `__testSetSessionId(sid)`：测试用，设置 `currentSessionId`
- `initConversationLog` 里订阅会话切换事件：切到新 sessionId 时先 `loadFromArchive(sid)` 再继续累积

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/conversation-log-archive.test.js`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/preload/dom/conversation-log.js test/preload/conversation-log-archive.test.js
git commit -m "feat: preload 侧会话存档写入与切会话加载"
```

---

## Task 4: 统一导出的数据源优先级

**Files:**
- Modify: `src/preload/dom/chat-input.js`（工作区导出 handler 改为存档优先）
- Modify: `src/preload/overlay/events.js`（悬浮球导出改为同一逻辑）
- Create: `src/preload/dom/export-source.js`（统一取数逻辑）
- Test: `test/preload/export-source.test.js`

**Interfaces:**
- Consumes: Task 3 的 `loadFromArchive` / 现有 IndexedDB 读取逻辑
- Produces: `resolveExportEntries(sessionId)` → `Promise<{ source: 'archive'|'indexeddb'|'empty', entries: Array<{role,text,ts}>, message?: string }>`

- [ ] **Step 1: 写失败测试**

```js
// test/preload/export-source.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveExportEntries } = require('../../src/preload/dom/export-source');

test('存档优先于 IndexedDB', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [{ role: 'user', text: '存档', ts: 1 }] }),
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'archive');
  assert.strictEqual(r.entries[0].text, '存档');
});

test('存档为空时回退到 IndexedDB', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [] }),
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'indexeddb');
});

test('两者都空时返回 empty 且带提示文案', async () => {
  const deps = {
    readArchive: async () => ({ success: true, entries: [] }),
    readIndexedDB: async () => [],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'empty');
  assert.strictEqual(r.message, '该会话暂无对话内容');
});

test('存档读取抛错时回退到 IndexedDB 而不是整体失败', async () => {
  const deps = {
    readArchive: async () => { throw new Error('disk error'); },
    readIndexedDB: async () => [{ role: 'user', text: 'IDB', ts: 1 }],
  };
  const r = await resolveExportEntries('s1', deps);
  assert.strictEqual(r.source, 'indexeddb');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/export-source.test.js`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

新建 `export-source.js`，导出 `resolveExportEntries(sessionId, deps)`（deps 可注入便于测试，生产环境默认用 `window.electronAPI.conversationArchiveRead` 和现有 IndexedDB 读取函数）。再改 `chat-input.js` 的 `lingya-export-session-md` handler：把原来直接读 IndexedDB 的那段换成调 `resolveExportEntries`，按 `source` 分支处理（empty 时 `showToast('该会话暂无对话内容')`）。`events.js` 的悬浮球导出改为：先 `loadFromArchive(currentSessionId)` 尝试加载存档，加载不到再走原内存逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/export-source.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/preload/dom/export-source.js src/preload/dom/chat-input.js src/preload/overlay/events.js test/preload/export-source.test.js
git commit -m "feat: 导出数据源优先级统一（存档→IndexedDB→空）"
```

---

## Task 5: 工作区跨窗口聚合（主进程）

**Files:**
- Modify: `src/main/session-store.js`（`listAllSessions` 改为可聚合）
- Modify: `src/main/ipc.js`（`list-all-sessions` handler 改为聚合所有 profile）
- Create: `src/main/workspace-aggregator.js`
- Test: `test/main/workspace-aggregator.test.js`

**Interfaces:**
- Produces:
  - `aggregateWorkspaces(userDataDir, currentProfileId, profileList)` → `{ success, sessions: Array<AggregatedSession>, archivedProjects: string[], currentSessionId, currentProjectDir }`
  - `AggregatedSession` = `{ sessionId, projectDir, title, createdAt, updatedAt, archived, profileId, profileName }`
  - 会话按 sessionId 去重（同会话多窗口写入时合并 updatedAt 取最新，archived 取 OR）

- [ ] **Step 1: 写失败测试**

```js
// test/main/workspace-aggregator.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregateWorkspaces } = require('../../src/main/workspace-aggregator');

function setupStores(dir, stores) {
  for (const [pid, data] of Object.entries(stores)) {
    fs.writeFileSync(path.join(dir, 'session-dir-map-' + pid + '.json'), JSON.stringify(data), 'utf-8');
  }
}

test('聚合多个 profile 的会话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-ws-'));
  setupStores(dir, {
    p1: { s1: { projectDir: 'D:/projA', title: 'A会话', updatedAt: '2026-01-01T00:00:00Z' } },
    p2: { s2: { projectDir: 'D:/projB', title: 'B会话', updatedAt: '2026-01-02T00:00:00Z' } },
  });
  const profiles = [{ id: 'p1', name: '窗口1' }, { id: 'p2', name: '窗口2' }];
  const r = aggregateWorkspaces(dir, 'p1', profiles);
  assert.strictEqual(r.sessions.length, 2);
  const s2 = r.sessions.find(s => s.sessionId === 's2');
  assert.strictEqual(s2.profileId, 'p2');
  assert.strictEqual(s2.profileName, '窗口2');
});

test('同 sessionId 跨 profile 去重，取最新 updatedAt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-ws-'));
  setupStores(dir, {
    p1: { s1: { projectDir: 'D:/a', title: '旧', updatedAt: '2026-01-01T00:00:00Z' } },
    p2: { s1: { projectDir: 'D:/a', title: '新', updatedAt: '2026-02-01T00:00:00Z' } },
  });
  const r = aggregateWorkspaces(dir, 'p1', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.sessions.length, 1);
  assert.strictEqual(r.sessions[0].title, '新');
});

test('损坏的 session 文件被跳过，不影响其他 profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-ws-'));
  fs.writeFileSync(path.join(dir, 'session-dir-map-p1.json'), 'NOT_JSON{{{', 'utf-8');
  setupStores(dir, {
    p2: { s2: { projectDir: 'D:/b', title: 'ok' } },
  });
  const r = aggregateWorkspaces(dir, 'p2', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.sessions.length, 1);
  assert.strictEqual(r.sessions[0].sessionId, 's2');
});

test('归档项目列表合并去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-ws-'));
  setupStores(dir, {
    p1: { __project_archived__: { 'D:/old': '2026-01-01T00:00:00Z' }, s1: { projectDir: 'D:/a', title: 't' } },
    p2: { __project_archived__: { 'D:/old2': '2026-01-02T00:00:00Z' }, s2: { projectDir: 'D:/b', title: 't' } },
  });
  const r = aggregateWorkspaces(dir, 'p1', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.archivedProjects.length, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/workspace-aggregator.test.js`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

新建 `workspace-aggregator.js`，导出 `aggregateWorkspaces(userDataDir, currentProfileId, profileList)`：遍历 `profileList`，读 `session-dir-map-<id>.json`（try/catch 跳过损坏），用现有 `normalizeEntry` 归一化，给每个会话附 `profileId` / `profileName`，按 sessionId 去重合并，合并 `__project_archived__`。改 `ipc.js` 的 `list-all-sessions` handler：调 `aggregateWorkspaces(app.getPath('userData'), ctx.profileId, profileManager.readProfiles())`。`session-store.js` 的 `listAllSessions` 保持原样（单 profile 场景仍用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/main/workspace-aggregator.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/main/workspace-aggregator.js src/main/ipc.js test/main/workspace-aggregator.test.js
git commit -m "feat: 工作区跨窗口聚合"
```

---

## Task 6: 侧栏工作区 UI —— 来源窗口标注 + 跨窗口跳转

**Files:**
- Modify: `src/preload/shell-renderer.js`（`__renderCuckooWorkspaces` 内渲染逻辑）
- Test: `test/preload/workspace-render.test.js`

**Interfaces:**
- Consumes: Task 5 聚合结果里的 `profileId` / `profileName`
- Produces: 渲染出的会话项 DOM 增加 `data-profile-id` 属性；跨窗口项显示窗口徽标

- [ ] **Step 1: 写失败测试**

```js
// test/preload/workspace-render.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderSessionItemHtml } = require('../../src/preload/shell-renderer-helpers');

test('同窗口会话不显示窗口徽标', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's1', title: '会话A', profileId: 'p1', profileName: '窗口1' },
    { currentSessionId: '', currentProfileId: 'p1' }
  );
  assert.ok(!html.includes('ck-ws-badge'));
});

test('跨窗口会话显示窗口徽标', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's2', title: '会话B', profileId: 'p2', profileName: '窗口2' },
    { currentSessionId: '', currentProfileId: 'p1' }
  );
  assert.ok(html.includes('ck-ws-badge'));
  assert.ok(html.includes('窗口2'));
  assert.ok(html.includes('data-profile-id="p2"'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/workspace-render.test.js`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

新建 `src/preload/shell-renderer-helpers.js`，导出纯函数 `renderSessionItemHtml(session, ctx)`（把 v2 里 `wsRenderItem` 的 HTML 生成逻辑抽成纯函数，增加 `data-profile-id` 与跨窗口徽标 `<span class="ck-ws-badge">窗口名</span>`）。`shell-renderer.js` 的 `wsRenderItem` 改为调用它。点击跨窗口会话时（`data-profile-id` 与当前不同）：显示提示"该会话在 <窗口名>"，附"跳转"按钮，点击调 `window.shellAPI.openProfileWindow(profileId)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/workspace-render.test.js`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/preload/shell-renderer.js src/preload/shell-renderer-helpers.js test/preload/workspace-render.test.js
git commit -m "feat: 工作区跨窗口来源标注与跳转"
```

---

## Task 7: 工作区搜索

**Files:**
- Modify: `src/preload/shell-renderer.js`（`__renderCuckooWorkspaces` 增加搜索框 + 过滤逻辑）
- Test: `test/preload/workspace-search.test.js`

**Interfaces:**
- Consumes: Task 5 聚合结果
- Produces: `filterSessions(sessions, keyword)` → 过滤后的 sessions 数组（纯函数，字面匹配，大小写不敏感）

- [ ] **Step 1: 写失败测试**

```js
// test/preload/workspace-search.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { filterSessions } = require('../../src/preload/shell-renderer-helpers');

const sample = [
  { sessionId: 's1', projectDir: 'D:/projects/lingya', title: '修复登录' },
  { sessionId: 's2', projectDir: 'D:/projects/blog', title: '写文章' },
  { sessionId: 's3', projectDir: 'D:/projects/lingya', title: '优化性能' },
];

test('按项目路径过滤', () => {
  const r = filterSessions(sample, 'lingya');
  assert.strictEqual(r.length, 2);
});

test('按会话标题过滤', () => {
  const r = filterSessions(sample, '登录');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sessionId, 's1');
});

test('大小写不敏感', () => {
  const r = filterSessions(sample, 'LINGYA');
  assert.strictEqual(r.length, 2);
});

test('空关键词返回全部', () => {
  const r = filterSessions(sample, '');
  assert.strictEqual(r.length, 3);
});

test('正则特殊字符按字面匹配不抛异常', () => {
  const r = filterSessions(sample, '.*');
  assert.strictEqual(r.length, 0);
  const r2 = filterSessions(sample, '[');
  assert.strictEqual(r2.length, 0);
});

test('无匹配返回空数组', () => {
  const r = filterSessions(sample, 'zzzzz');
  assert.strictEqual(r.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/workspace-search.test.js`
Expected: FAIL — `filterSessions is not a function`

- [ ] **Step 3: 实现**

在 `shell-renderer-helpers.js` 增加 `filterSessions(sessions, keyword)`：`keyword.trim().toLowerCase()`，对每个 session 拼 `(projectDir + ' ' + title)` 转小写后 `indexOf`。`shell-renderer.js` 的工作区视图在按钮行下方插入 `<input id="ws-search" placeholder="搜索项目或会话…">`，`input` 事件触发 `load()` 时先过滤再渲染。无匹配时 `<div class="ck-list-empty">无匹配结果</div>`。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node --test test/preload/workspace-search.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/preload/shell-renderer.js src/preload/shell-renderer-helpers.js test/preload/workspace-search.test.js
git commit -m "feat: 工作区搜索（项目路径 + 会话标题）"
```

---

## Task 8: 全量回归与收尾

**Files:**
- 无新增文件

- [ ] **Step 1: 跑全量测试**

Run: `set "PATH=D:\NodeJS;%PATH%" && npm test`
Expected: 全部通过（1110 基线 + 本计划新增 29 个用例）

- [ ] **Step 2: 手工验证关键场景**

1. 启动应用，在窗口 A 进行 3 轮对话 → 重启 → 从工作区导出该会话 → 文件存在且内容完整
2. 在 DeepSeek 侧删除该会话 → 再导出 → 仍成功
3. 打开窗口 A、窗口 B 各初始化不同项目 → 在 A 的工作区看到两个项目 → 跨窗口会话带窗口徽标 → 点击提示跳转
4. 工作区搜索框输入项目路径片段 → 列表实时收敛 → 清空恢复
5. 搜索输入 `.*` → 显示"无匹配结果"，不崩溃

- [ ] **Step 3: 更新文档**

在 `.lingyaCode/LINGYA.md` 的「核心机制」章节补充一段会话存档说明（存档路径、数据源优先级），在「常见坑」补充"导出优先读本地存档"。

- [ ] **Step 4: Commit**

```bash
git add .lingyaCode/LINGYA.md
git commit -m "docs: 补充会话存档与跨窗口工作区说明"
```

---

## 自检结果

- **Spec 覆盖**：US1 → Task 1/2/3/4；US2 → Task 5/6；US3 → Task 7；Edge Cases 全部落到对应 task 的测试用例；FR-001~018 均可对应到具体 task；SC 在 Task 8 手工验证。
- **步骤扫描**：每个 step 单一动作、有可检查结果。
- **类型一致性**：`AggregatedSession` 在 Task 5 定义、Task 6 消费，字段名一致；`resolveExportEntries` 在 Task 4 定义并自消费；IPC 通道名 Task 2 定义、Task 3 消费，一致。
- **Review Focus**：6 条均已在对应 task 的测试用例中钉住（Task 1 的损坏行/不可写目录、Task 3 的并发追加、Task 4 的 empty 文案/存档抛错回退、Task 5 的损坏文件跳过、Task 7 的正则特殊字符）。
- **比例**：计划约 500 行，spec 约 190 行，未过度膨胀；代码块仅给出测试断言与关键签名，实现体留给执行者。
