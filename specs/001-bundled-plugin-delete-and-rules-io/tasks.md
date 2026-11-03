# Tasks: 内置插件删除持久化 + 核心规则导入导出

**Input**: Design documents from `/specs/001-bundled-plugin-delete-and-rules-io/`

**Prerequisites**: plan.md（已产出）、spec.md（已产出）

**Tests**: 本特性的测试是**强制**的（constitution III），不标注为可选。

**Organization**: 按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: 所属用户故事（US1 ~ US5）

## Path Conventions

单仓 Electron 项目：主进程 src/main/、渲染层 src/preload/、插件 plugins/、测试 test/main/。

---

## Phase 1: Foundational（阻塞全部用户故事）

**目的**: 墓碑存储、内置判定、播种跳过、恢复能力、删除语义改造。这些不完成，任何用户故事都无法独立验证。

- [ ] T001 在 src/main/plugin-store.js 新增墓碑 API：markDeleted(id) 写 { deleted:true, deletedAt:ISO } 并保留其余字段；isDeleted(id)；clearDeleted()（清全部墓碑但保留 config/enabled/pinned）；listDeleted() 返回 id 数组
- [ ] T002 [P] 在 src/main/plugin-host.js 抽出 findBundledSourceDir()，把 seedBundledPlugins 里 candidates 探测逻辑迁移进去（行为不变）
- [ ] T003 在 src/main/plugin-host.js 新增 isBundledId(pluginId)：源目录存在且含同名目录返回 true，否则 false；scanPlugins 返回项增加 bundled 字段
- [ ] T004 在 src/main/plugin-host.js 的 seedBundledPlugins 目录循环开头加墓碑跳过：pluginStore.isDeleted(ent.name) 为真则记日志并 continue
- [ ] T005 改造 src/main/plugin-host.js 的 deletePlugin：先算 bundled=isBundledId(pluginId)；内置插件走 pluginStore.markDeleted(pluginId) 保留 config，非内置插件维持 removeRecord(pluginId)；返回值增加 bundled 字段
- [ ] T006 在 src/main/plugin-host.js 新增 restoreBundledPlugins()：源目录不存在则返回失败且不清墓碑；否则 listDeleted 快照 → clearDeleted → seedBundledPlugins → await loadAllEnabled → 返回 { success:true, restored }
- [ ] T007 在 src/main/plugin-host.js 的 module.exports 中导出 restoreBundledPlugins

**Checkpoint**: 主进程侧墓碑能力完备，可用 Node 脚本直接验证「删除→播种跳过→恢复」。

---

## Phase 2: US1 + US2 — 删除持久化与恢复的 IPC 与 UI

**Goal**: 用户能在界面上删除内置插件、重启不复活、并一键恢复。

**Independent Test**: 删除 core-rules → 重启 → 列表无该插件 → 点恢复 → 列表出现且规则内容仍在。

- [ ] T008 [US1] 在 src/main/ipc.js 的 registerIpcHandlers 中新增 `ipcMain.handle('plugin-restore-bundled', ...)`，调用 pluginHost.restoreBundledPlugins()，返回 { success, restored, plugins: pluginHost.listPlugins(), dir }
- [ ] T009 [US1] 在 src/main/ipc.js 的 `plugin-list` 处理器返回值中确认已透传 bundled 字段（scanPlugins 已带，无需额外改动；若 listPlugins 做了字段白名单则补上 bundled 与 deleted 计数）
- [ ] T010 [P] [US1] 在 src/preload/shell-preload.js 的 shellAPI 对象中新增 `pluginRestoreBundled: () => ipcRenderer.invoke('plugin-restore-bundled')`
- [ ] T011 [US1] 在 src/preload/shell-renderer.js 的 renderPluginsView 顶部增加墓碑提示条：容器 id `sh-plug-tombstone`，文案「已删除 N 个内置插件」，右侧按钮 id `sh-plug-restore-bundled`；N 由 plugin-list 返回的已删除数量得出
- [ ] T012 [US1] 在 src/preload/shell-renderer.js 绑定 `sh-plug-restore-bundled` 点击：确认框 → 调 pluginRestoreBundled → 成功则 toast2 并重绘列表，失败提示 error
- [ ] T013 [US2] 在 src/preload/shell-renderer.js 的插件卡片删除回调中，当 bundled 为真时确认框文案改为「该插件为内置插件，删除后可通过插件面板顶部的『恢复内置插件』找回。确定删除？」；非内置保持原文案

**Checkpoint**: US1 与 US2 可在真实应用内端到端验证。

---

## Phase 3: US3 — 内置插件视觉区分

**Goal**: 内置插件卡片有明确标识，用户一眼能分辨。

**Independent Test**: 打开插件面板，三个内置插件卡片上有"内置"角标。

- [ ] T014 [US3] 在 src/preload/shell-renderer.js 的插件卡片 HTML 模板中，当 p.bundled 为真时插入角标：`<span class="sh-plug-badge-bundled" style="font-size:10px;padding:0 4px;border-radius:3px;background:var(--ck-primary);color:#fff;margin-left:4px;">内置</span>`，位置在插件名之后
- [ ] T015 [US3] 确认角标不影响既有卡片布局（与置顶开关、启用开关、按钮行共存），必要时仅在名称行内换行

**Checkpoint**: US3 独立可验收。

---

## Phase 4: US4 + US5 — 核心规则导出与导入

**Goal**: 核心规则面板可导出 JSON、可导入 JSON 并按 id 合并。

**Independent Test**: 3 条规则 → 导出 → 清空 → 导入同一文件 → 3 条规则原样回来（id/name/content/enabled/order 一致）。

- [ ] T016 [P] [US5] 在 plugins/core-rules/rules-model.js 新增纯函数 mergeRules(base, incoming)：以 id 为 key 合并，同 id 覆盖 name/content/enabled，新 id 追加；结果顺序为 base 原序 + 新条目，order 重排 0..N-1；不修改入参；并在 module.exports 中导出
- [ ] T017 [US4] 在 plugins/core-rules/index.js 的 apply 内新增 `ctx.registerIpc('exportRules', async (args, event) => ...)`：readRules() 为空返回 { success:false, error:'没有可导出的规则' }；dialog.showSaveDialog（父窗口用 BrowserWindow.fromWebContents(event.sender)，拿不到则无父窗口）默认文件名 core-rules-YYYYMMDD.json，过滤器 JSON；写文件内容为 { plugin:'core-rules', version:name 对应的 manifest version, exportedAt:ISO, rules }；取消返回 { success:false, canceled:true }；成功返回 { success:true, path, count }
- [ ] T018 [US5] 在 plugins/core-rules/index.js 新增 `ctx.registerIpc('importRules', async (args, event) => ...)`：dialog.showOpenDialog 选 JSON；读文件 → JSON.parse 失败返回 { success:false, error:'文件格式错误' }；取 parsed.rules 或 parsed 本身；非数组返回格式错误；mergeRules 合并 → 写 ctx.config.rules → ctx.settings.save() → 返回 { success:true, added, overwritten, total }；取消返回 { success:false, canceled:true }
- [ ] T019 [US4] [US5] 在 plugins/core-rules/index.js 的 render() 中，在「+ 新增规则」按钮上方插入一行两个按钮：id `cr-import`（文案「导入规则」）、id `cr-export`（文案「导出规则」），复用 sh-btn 样式，横向排布
- [ ] T020 [US4] [US5] 在 plugins/core-rules/panel.js 的 boot() 中绑定 cr-export 与 cr-import 的点击：分别 invoke('exportRules') / invoke('importRules')，成功时 flash 含条数的提示（如「已导出 3 条规则」「已导入：新增 1 条，覆盖 1 条」），失败时 flash error，canceled 时静默
- [ ] T021 [US5] 在 plugins/core-rules/panel.js 中，导入成功后刷新 rules 与 renderList()（用返回值或重新 invoke('getConfig')）

**Checkpoint**: US4 与 US5 可在核心规则面板内端到端验证。

---

## Phase 5: 测试（TDD：先 Red 后 Green）

- [ ] T022 先写 test/main/plugin-tombstone.test.js（Red）：
  - markDeleted 后 isDeleted 为真，且同记录的 enabled/pinned/config 未被清空
  - clearDeleted 清全部墓碑但保留 config
  - listDeleted 返回全部墓碑 id
  - seedBundledPlugins 跳过墓碑目录（用临时 srcDirOverride 与临时 storeDir）
  - deletePlugin 对内置插件写墓碑而非 removeRecord；对非内置插件走 removeRecord
  - restoreBundledPlugins 在源目录缺失时返回失败且墓碑仍在
- [ ] T023 在 test/main/core-rules-rules-model.test.js 增补 mergeRules 用例（Red）：同 id 覆盖、新 id 追加、order 重排、不修改入参、空 base、空 incoming、非数组入参返回 base
- [ ] T024 实现 T001~T021 使 T022、T023 变 Green
- [ ] T025 跑 `npm test` 全量，确认 1110 + 新增用例全绿；若有既有用例因 bundled 字段或 deletePlugin 返回值变化而失败，按最小改动修正断言

**Checkpoint**: 全量测试绿。

---

## Phase 6: 文档与收尾

- [ ] T026 [P] 更新 src/assets/plugin-dev-skill/PLUGIN-DEV.md 的「播种规则」一节，补充：内置插件被删除后会记墓碑，重启不再播种；插件面板顶部可一键恢复；删除内置插件不丢失其 config
- [ ] T027 自查 constitution：确认未修改任何既有 UI 元素 id、preload 未新增 Node require、未引入新依赖、未执行打包命令
- [ ] T028 逐条核对 spec.md 的 FR-001 ~ FR-013 与 SC-001 ~ SC-005，确认全部达成后向用户报告

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1（Foundational）：无依赖，必须最先完成
- Phase 2（US1+US2）：依赖 Phase 1
- Phase 3（US3）：依赖 Phase 1 的 bundled 字段（T003），与 Phase 2 可并行
- Phase 4（US4+US5）：**完全独立**于 Phase 1~3，可并行开工（T016 无依赖，T017~T021 相互依赖）
- Phase 5（测试）：T022 依赖 Phase 1，T023 依赖 T016；T024 依赖 Phase 1~4 全部；T025 最后
- Phase 6：依赖 Phase 5

### 并行机会

- T002 与 T001 可并行（不同文件）
- T010 与 T008/T011 可并行（不同文件）
- Phase 4 整体可与 Phase 1~3 并行
- T022 与 T023 可并行（不同测试文件）
- T026 可与任意实现任务并行

### 建议执行顺序（串行单人）

T001 → T002 → T003 → T004 → T005 → T006 → T007 → T022(Red) → T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T023(Red) → T017 → T018 → T019 → T020 → T021 → T024(Green) → T025 → T026 → T027 → T028

---

## Notes

- [P] 任务 = 不同文件、无依赖
- 每个用户故事完成后应能独立演示
- TDD 顺序：T022/T023 必须先写并确认失败，再实现
- 严格不修改既有 UI 元素 id（constitution I）
- 不执行任何打包命令
- 若实现中发现 tasks.md 有错，停下修改并重新请批准，不私自改道
