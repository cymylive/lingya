# Implementation Plan: 内置插件删除持久化 + 核心规则导入导出

**Branch**: `001-bundled-plugin-delete-and-rules-io` | **Date**: 2026-11-04 | **Spec**: specs/001-bundled-plugin-delete-and-rules-io/spec.md

**Input**: Feature specification from `/specs/001-bundled-plugin-delete-and-rules-io/spec.md`

## Summary

两件事：(1) 给内置插件加"墓碑"，让删除在重启后依然生效，并提供一键恢复与 UI 区分；(2) 给核心规则插件加 JSON 导出/导入。

技术路线：墓碑复用现有的 `<userData>/lingya-plugins.json`（与 enabled/pinned/config 同一条记录），不改存储文件格式；内置判定通过对比应用自带源目录实现，不改 manifest；导出/导入在插件主进程代码里用 electron dialog + fs 完成，渲染层只走已有的 pluginInvoke 通道。

## Technical Context

**Language/Version**: JavaScript（主进程/渲染层 CommonJS；插件入口 ESM）

**Primary Dependencies**: Electron 33.x（dialog）、Node 内置 fs / path；无新增 npm 依赖

**Storage**: JSON 文件 `<userData>/lingya-plugins.json`（现有文件，仅新增 deleted/deletedAt 字段）

**Testing**: `node --test`（package.json 的 npm test，基准 1110 用例）

**Target Platform**: Windows x64 Electron 桌面应用

**Project Type**: desktop-app（Electron 主进程 + preload 渲染层 + 本地插件）

**Performance Goals**: 插件面板加载不增加可感知延迟；恢复操作 ≤ 1s（三个插件目录复制）

**Constraints**: 不引入新依赖；不改 UI 现有元素 id（constitution I）；preload 不直接 require Node 模块（constitution IV）

**Scale/Scope**: 3 个内置插件、1 个插件面板视图、1 个核心规则面板；改动 6 个文件 + 3 个插件文件 + 2 个测试文件

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. 外科手术式修改** — PASS。改动限定在插件子系统与核心规则插件；不重排、不格式化无关代码；shell-renderer.js 只新增元素（新 id 用 sh-plug-restore-bundled / sh-plug-bundled-badge），不修改既有 id。
- **II. 先思考后编码** — PASS。已完成需求复述与 6 个决策点的拍板（记录在 spec.md 的 Assumptions）。
- **III. 验证闭环与 TDD** — PASS。新增 plugin-tombstone.test.js 与 core-rules mergeRules 用例，先写测试确认 Red，再实现 Green，最后跑全量 npm test。不执行打包。
- **IV. 架构分层与沙箱安全** — PASS。panel.js（渲染层）只调用 window.shellAPI.pluginInvoke；fs 与 dialog 全在主进程插件 index.js 内；preload 仅新增一条 ipcRenderer.invoke 转发。
- **V. 零 Token 与扩展性** — PASS。无 API 调用；插件入口保持 ESM 的 export function apply(ctx)；rules-model.js 保持 CommonJS。

**结论**：无违反项，无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

specs/001-bundled-plugin-delete-and-rules-io/
- spec.md（本特性规格）
- plan.md（本文件）
- tasks.md（下一步产出，需用户批准）

### Source Code (repository root)

主进程
- src/main/plugin-store.js — 新增墓碑 API：markDeleted / isDeleted / clearDeleted / listDeleted
- src/main/plugin-host.js — 抽 findBundledSourceDir；scanPlugins 加 bundled；seedBundledPlugins 跳过墓碑；deletePlugin 内置走墓碑并保留 config；新增 restoreBundledPlugins
- src/main/ipc.js — 新增 IPC 通道 plugin-restore-bundled

渲染层
- src/preload/shell-preload.js — 新增 shellAPI.pluginRestoreBundled
- src/preload/shell-renderer.js — 插件面板：内置角标、内置删除文案、墓碑提示条与恢复按钮

核心规则插件
- plugins/core-rules/rules-model.js — 新增纯函数 mergeRules(base, incoming)
- plugins/core-rules/index.js — 新增 registerIpc('exportRules') / ('importRules')
- plugins/core-rules/panel.js — 新增导出/导入按钮与交互

测试
- test/main/plugin-tombstone.test.js（新增）
- test/main/core-rules-rules-model.test.js（若已存在则增补 mergeRules 用例）

**Structure Decision**: 沿用现有单仓结构。插件子系统改动集中在 src/main/plugin-host.js 与 plugin-store.js；UI 改动集中在 src/preload/shell-renderer.js 的 renderPluginsView；核心规则能力全部落在 plugins/core-rules/ 内部，不触碰 project-context.js 的注入链路。

## 关键设计决策

### 1. 墓碑存储位置

复用 `lingya-plugins.json` 的同一条 pluginId 记录，新增 `deleted: true` 与 `deletedAt`。不新建文件，避免多一份状态源。

删除内置插件时：`markDeleted(id)`，**不调用 removeRecord**，因此 config/enabled/pinned 原样保留。删除普通插件时：保持现状 `removeRecord(id)`。

### 2. 内置判定

抽 `findBundledSourceDir()`（把 seedBundledPlugins 里的 candidates 探测逻辑提取出来），新增 `isBundledId(pluginId)`：源目录存在且其中含同名目录即返回 true。源目录不存在时返回 false（测试环境降级安全）。

scanPlugins 返回值增加 `bundled: isBundledId(manifest.id)`。

### 3. 播种跳过

seedBundledPlugins 的目录遍历循环开头加：`if (pluginStore.isDeleted(ent.name)) { 记日志; continue; }`。

墓碑 key 用目录名（与 deletePlugin 的 pluginId 一致，代码已假定目录名 == pluginId）。

### 4. 恢复

`restoreBundledPlugins()`：
1. 取 `listDeleted()` 快照
2. 若源目录不存在，直接返回 `{ success: false, error: '未找到应用内置插件目录' }`，不清墓碑
3. `clearDeleted()`
4. `seedBundledPlugins()`
5. `await loadAllEnabled()`（loadPlugin 内部对已加载插件是幂等的）
6. 返回 `{ success: true, restored: ids }`

### 5. 核心规则导入合并

`mergeRules(base, incoming)` 纯函数：
- 用 Map 以 id 为 key 收 base
- 遍历 incoming：同 id 覆盖 name/content/enabled；新 id 追加
- 结果按原 base 顺序在前、新条目在后，order 重排 0..N-1
- 返回新数组，不修改入参

importRules 的 IPC 处理：读文件 → JSON.parse（失败给"文件格式错误"）→ 取 `parsed.rules` 或 parsed 本身（兼容纯数组）→ 校验是数组 → mergeRules → 存 ctx.config → ctx.settings.save() → 返回 `{ success: true, added, overwritten, total }`。

### 6. 导出文件格式

`{ plugin: 'core-rules', version: manifest.version, exportedAt: ISO, rules: [...] }`，UTF-8，2 空格缩进。

文件对话框用 `dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {...})`；拿不到窗口时降级为无父窗口调用。

## Complexity Tracking

无违反项，本节留空。
