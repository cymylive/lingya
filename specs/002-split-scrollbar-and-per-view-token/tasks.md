# Tasks: 分屏滚动条可见性 + 各视图独立 token 用量

**Input**: Design documents from `/specs/002-split-scrollbar-and-per-view-token/`

**Prerequisites**: plan.md（已产出）、spec.md（已产出）

**Tests**: 强制（constitution III）。

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

单仓 Electron 项目：主进程 `src/main/`、壳页面 `src/ui/`、渲染层 `src/preload/`、测试 `test/main/` `test/preload/`。

---

## Phase 1: Foundational（阻塞两个用户故事）

- [ ] T001 在 `src/main/window.js` 新增并导出 `findHostContextForView(webContents)`：遍历 `windows`，若某 ctx 的 `attachedViews` 中存在 `p.view.webContents === webContents`，返回该 ctx；否则返回 null
- [ ] T002 在 `src/main/ipc.js` 的 `update-token-usage` 处理器中改用新逻辑：先 `getContextByWebContents`，若 target 为空或其 `rawWin` 已销毁，则调 `findHostContextForView` 回退；仍找不到则返回 `{ success: false }` 且不发送
- [ ] T003 在 `src/main/ipc.js` 的 `update-token-usage` 发送 payload 时追加 `viewKey: String(event.sender.id)`，其余字段原样透传

**Checkpoint**: 主进程能把合并后视图的 token 事件送达宿主壳页面，且带上来源标识。

---

## Phase 2: US1 — 滚动条可见性

**Goal**: 左右分屏横向滚动条、上下分屏纵向滚动条都不被状态栏遮挡。

**Independent Test**: 左右合并两窗口 → 横向滚动条完整可见可拖动；上下合并 → 纵向滚动条右下角不被状态栏覆盖。

- [ ] T004 [US1] `src/ui/shell.html` 中 `#lingya-split-scrollbar` 的 `bottom:0` 改为 `bottom:28px`，`z-index:9999` 改为 `z-index:10001`
- [ ] T005 [US1] `src/ui/shell.html` 中 `#lingya-split-vscrollbar` 的 `bottom:0` 改为 `bottom:28px`
- [ ] T006 [US1] 确认 `shell-renderer.js` 的 `initSplitScrollbar` / 纵向滚动条逻辑中 `bar.clientWidth` / 高度计算不依赖旧的 `bottom:0` 假设；若有硬编码视口高度，按新布局修正

**Checkpoint**: US1 可在真实应用内验证。

---

## Phase 3: US2 — 各视图独立 token 用量

**Goal**: 状态栏按视图分栏显示 token，互不覆盖；单视图时视觉不变。

**Independent Test**: A、B 合并 → A 产生 token → B 产生 token → 状态栏同时显示两个数值；拆屏后回到单栏。

- [ ] T007 [P] [US2] 在 `src/preload/shell-renderer.js` 抽出纯函数 `upsertTokenEntry(map, viewKey, context)`：写入并返回新 Map；供测试与渲染共用
- [ ] T008 [P] [US2] 在 `src/preload/shell-renderer.js` 抽出纯函数 `pruneTokenEntries(map, activeViewKeys)`：删除不在集合内的 key，返回新 Map
- [ ] T009 [US2] 改造 `initStatusBar`：用 `tokenByView` Map 替代单一 `ctxEl.textContent` 写入；收到 `onTokenUpdated` 时 `upsertTokenEntry` 后重绘
- [ ] T010 [US2] 实现 `renderStatusBarTokens()`：视图数 1 时复用 `#sb-context` 保持原视觉；视图数 ≥2 时在状态栏内动态生成多个 `sb-item`，格式 `对话上下文: <值>`，栏间插入 `sb-sep` 竖线分隔元素（新增 class，样式内联，不改既有 class）
- [ ] T011 [US2] 在 `initStatusBar` 中订阅分屏状态变化（复用现有 `window-split-state` 结果或拆屏事件），用当前视图集合调 `pruneTokenEntries` 后重绘
- [ ] T012 [US2] 视图被拆分/关闭时（`window-unmerge` 成功后），主动从 `tokenByView` 删除对应 viewKey 并重绘

**Checkpoint**: US2 可在真实应用内验证；单窗口场景截图对比无视觉差异。

---

## Phase 4: 测试（TDD：先 Red 后 Green）

- [ ] T013 先写 `test/main/token-routing.test.js`（Red）：
  - `findHostContextForView` 能在 attachedViews 中命中并返回宿主 ctx
  - 未命中返回 null
  - 源 ctx 的 rawWin 已销毁时，路由逻辑选择宿主 ctx
  - 宿主也找不到时返回 `success: false` 且不调用 send
  - payload 含 `viewKey` 且等于 webContents id 字符串
- [ ] T014 先写 `test/preload/statusbar-token.test.js`（Red）：
  - `upsertTokenEntry` 新增与覆盖
  - `pruneTokenEntries` 删除不在集合的 key
  - 格式化沿用 `formatTokenCount`（万/亿）
  - 空 Map 渲染为单栏 `0`
- [ ] T015 实现 T001~T012 使 T013、T014 变 Green
- [ ] T016 跑全量 `npm test`（用 `D:\NodeJS\node.exe` 并临时把 `D:\NodeJS` 加入 PATH），确认 1161 + 新增用例全绿

**Checkpoint**: 全量测试绿。

---

## Phase 5: 收尾

- [ ] T017 自查 constitution：未改既有 UI 元素 id（`#sb-context` / `#sb-tps` 保留）、未新增 npm 依赖、未执行打包
- [ ] T018 逐条核对 spec 的 FR-001~FR-010 与 SC-001~SC-005，向用户报告

---

## Dependencies & Execution Order

- Phase 1（T001~T003）：无依赖，先做
- Phase 2（T004~T006）：与 Phase 1 无依赖，可并行
- Phase 3（T007~T012）：T009 依赖 T007/T008；T010 依赖 T009；T011/T012 依赖 T009
- Phase 4：T013 依赖 T001/T002/T003；T014 依赖 T007/T008；T015 依赖全部实现；T016 最后
- Phase 5：依赖 Phase 4

### 建议串行顺序

T001 → T002 → T003 → T013(Red) → T007 → T008 → T014(Red) → T004 → T005 → T006 → T009 → T010 → T011 → T012 → T015(Green) → T016 → T017 → T018

---

## Notes

- 不修改分屏最小宽度 `SPLIT_MIN_WIDTH = 800`
- 不修改 token 采集与计算
- 不改 `#sb-context` / `#sb-tps` 的 id（constitution I）
- 多栏分隔符使用新增 class，样式内联，不污染既有 CSS
- 若实现中发现 tasks.md 有错，停下修改并重新请批准
