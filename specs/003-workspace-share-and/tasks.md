# 任务清单：工作区跨窗口共享 / 搜索 / 会话本地存档

**Feature**: `003-workspace-share-and`
**Plan**: `specs/003-workspace-share-and/plan.md`
**Spec**: `specs/003-workspace-share-and/spec.md`

## 阶段一：会话本地存档（P1）

### T001 存档存储层
- **文件**: 新建 `src/main/conversation-archive.js`，测试 `test/main/conversation-archive.test.js`
- **接口**: `createConversationArchive(profileId, userDataDir)` → `{ appendEntry, readEntries, hasArchive, deleteArchive, flush, archiveDir }`
- **验证**: `node --test test/main/conversation-archive.test.js` 7 个用例全绿；损坏行跳过、不可写目录返回失败不抛异常
- **依赖**: 无

### T002 存档 IPC 通道
- **文件**: 新建 `src/main/conversation-archive-ipc.js`；改 `src/main/index.js`、`src/main/window.js`、`src/main/ipc.js`、`src/preload/api.js`；测试 `test/main/conversation-archive-ipc.test.js`
- **接口**: IPC 通道 `conversation-archive-append/read/has`；preload API `conversationArchiveAppend/Read/Has`
- **验证**: `node --test test/main/conversation-archive-ipc.test.js` 3 个用例全绿；before-quit 调用 flush
- **依赖**: T001

### T003 preload 写入与切会话加载
- **文件**: 改 `src/preload/dom/conversation-log.js`；测试 `test/preload/conversation-log-archive.test.js`
- **接口**: `addEntry` 后节流 1s 写盘；新增 `loadFromArchive(sessionId)`、`getCurrentSessionId()`、`__testSetSessionId(sid)`
- **验证**: `node --test test/preload/conversation-log-archive.test.js` 3 个用例全绿；会话切换时从存档恢复内存 entries
- **依赖**: T002

### T004 导出数据源优先级统一
- **文件**: 新建 `src/preload/dom/export-source.js`；改 `src/preload/dom/chat-input.js`、`src/preload/overlay/events.js`；测试 `test/preload/export-source.test.js`
- **接口**: `resolveExportEntries(sessionId, deps?)` → `{ source: 'archive'|'indexeddb'|'empty', entries, message? }`
- **验证**: `node --test test/preload/export-source.test.js` 4 个用例全绿；两条导出路结果一致；empty 文案为"该会话暂无对话内容"
- **依赖**: T003

## 阶段二：工作区跨窗口共享（P2）

### T005 跨窗口聚合
- **文件**: 新建 `src/main/workspace-aggregator.js`；改 `src/main/ipc.js`；测试 `test/main/workspace-aggregator.test.js`
- **接口**: `aggregateWorkspaces(userDataDir, currentProfileId, profileList)` → `{ success, sessions: AggregatedSession[], archivedProjects, ... }`；`AggregatedSession` 含 `profileId` / `profileName`
- **验证**: `node --test test/main/workspace-aggregator.test.js` 4 个用例全绿；损坏文件跳过；同 sessionId 去重取最新
- **依赖**: T001（复用 normalizeEntry 思路，无硬依赖）

### T006 工作区 UI 来源标注与跳转
- **文件**: 新建 `src/preload/shell-renderer-helpers.js`；改 `src/preload/shell-renderer.js`；测试 `test/preload/workspace-render.test.js`
- **接口**: `renderSessionItemHtml(session, ctx)` 纯函数；会话项带 `data-profile-id`；跨窗口显示 `.ck-ws-badge`
- **验证**: `node --test test/preload/workspace-render.test.js` 2 个用例全绿；点击跨窗口会话弹提示 + 跳转按钮调 `openProfileWindow`
- **依赖**: T005

## 阶段三：工作区搜索（P3）

### T007 搜索过滤
- **文件**: 改 `src/preload/shell-renderer-helpers.js`（新增 filterSessions）、`src/preload/shell-renderer.js`（搜索框）；测试 `test/preload/workspace-search.test.js`
- **接口**: `filterSessions(sessions, keyword)` 纯函数，字面匹配、大小写不敏感
- **验证**: `node --test test/preload/workspace-search.test.js` 6 个用例全绿；正则特殊字符不抛异常；无匹配显示空状态
- **依赖**: T005

## 阶段四：回归与收尾

### T008 全量回归与文档
- **文件**: 改 `.lingyaCode/LINGYA.md`
- **验证**: `npm test` 全绿（基线 + 新增 29 用例）；手工验证 5 个关键场景（重启导出、平台删除后导出、跨窗口聚合、跨窗口跳转、搜索特殊字符）
- **依赖**: T001-T007

## 依赖关系图

```
T001 → T002 → T003 → T004
T001 → T005 → T006
              T005 → T007
所有 → T008
```

## 并行机会

- T006 与 T007 可并行（都基于 T005 的聚合结果，改不同函数）
- T004 可与 T005 并行（前者 preload 导出，后者主进程聚合，无交集）

## 可独立验证的里程碑

- **M1（T001-T004 完成）**：会话存档能力可用，导出不再依赖 IndexedDB——P1 交付
- **M2（T005-T006 完成）**：工作区跨窗口共享可用——P2 交付
- **M3（T007 完成）**：搜索可用——P3 交付
- **M4（T008 完成）**：全量回归通过，可发版
