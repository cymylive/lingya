# Implementation Plan: 分屏滚动条可见性 + 各视图独立 token 用量

**Branch**: `002-split-scrollbar-and-per-view-token` | **Date**: 2026-11-04 | **Spec**: specs/002-split-scrollbar-and-per-view-token/spec.md

**Input**: Feature specification from `/specs/002-split-scrollbar-and-per-view-token/spec.md`

## Summary

两个独立问题，两处小改动：

1. **滚动条遮挡**：横向滚动条 `bottom:0; z-index:9999`，状态栏 `bottom:0; height:28px; z-index:10000`，滚动条被完全盖住。修复 = 滚动条 `bottom` 抬到状态栏之上、`z-index` 提到状态栏之上；纵向滚动条同样处理右下角重叠。
2. **token 各显示各的**：主进程在源窗口壳已销毁时把 token 事件丢弃。修复 = 用 `viewOwners` 找回宿主窗口并转发；payload 带 `viewKey`；壳页面按 viewKey 维护映射；状态栏按视图分栏渲染。

## Technical Context

**Language/Version**: JavaScript（主进程 CommonJS / 壳页面 preload 脚本）

**Primary Dependencies**: Electron 33.x（webContents、WebContentsView）；无新增 npm 依赖

**Storage**: 无持久化；token 映射为壳页面内存态

**Testing**: `node --test`（基准 1161 用例）

**Target Platform**: Windows x64 Electron 桌面应用

**Project Type**: desktop-app

**Performance Goals**: token 更新为高频事件，多栏渲染需 O(视图数)，视图数 ≤ 4，无性能风险

**Constraints**: 不改动 token 采集与计算；不改动分屏最小宽度；不新增持久化结构

**Scale/Scope**: 2 个 HTML 元素样式、1 个 IPC 处理器、1 个壳页面订阅函数、1 个状态栏渲染函数

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. 外科手术式修改** — PASS。滚动条仅改内联 `bottom` 与 `z-index` 两个值；状态栏保留 `#sb-context` 作为单视图场景的锚点，多视图时动态增减兄弟节点，不重写整个状态栏。
- **II. 先思考后编码** — PASS。已完成诊断与方案确认，spec 的 Assumptions 记录了全部决策依据。
- **III. 验证闭环与 TDD** — PASS。新增用例覆盖 token 事件路由（主进程纯逻辑）与状态栏映射（可抽纯函数）；先 Red 后 Green；不执行打包。
- **IV. 架构分层与沙箱安全** — PASS。token 路由在主进程；壳页面只处理展示；不新增 preload 到主进程的裸通道；无 fs / process 暴露。
- **V. 零 Token 与扩展性** — PASS。不调用任何模型接口；纯 UI 与事件分发改动。

**结论**：无违反项。

## Project Structure

### Documentation (this feature)

specs/002-split-scrollbar-and-per-view-token/
- spec.md
- plan.md（本文件）
- tasks.md（下一步产出，需用户批准）

### Source Code (repository root)

主进程
- `src/main/ipc.js` — `update-token-usage` 处理器：源壳已销毁时用 `viewOwners` 找回宿主 ctx 并转发；payload 增加 `viewKey`
- `src/main/window.js` — 新增只读辅助 `findHostContextForView(webContents)`（复用现有 viewOwners，不新增结构）

渲染层
- `src/ui/shell.html` — 横向滚动条 `bottom:28px`、`z-index:10001`；纵向滚动条 `bottom:28px`
- `src/preload/shell-renderer.js` — 状态栏 token 渲染改为按 viewKey 的映射 + 多栏渲染；拆分/关闭视图时清理条目

测试
- `test/main/token-routing.test.js`（新增）— 覆盖宿主查找与 payload 组装
- `test/preload/statusbar-token.test.js`（新增）— 覆盖多栏映射与格式化

**Structure Decision**: 沿用现有结构。主进程改动集中在 `ipc.js` 的一个处理器 + `window.js` 一个辅助函数；渲染层改动集中在 `shell.html` 两个内联样式与 `shell-renderer.js` 的 `initStatusBar` 局部。

## 关键设计决策

### 1. 滚动条位置与层级

```
横向：#lingya-split-scrollbar  bottom: 0 → 28px   z-index: 9999 → 10001
纵向：#lingya-split-vscrollbar bottom: 0 → 28px
```

不改 `left/right/top/height/width`，不改显示条件（仍由现有 `render()` 判断内容溢出）。

### 2. token 事件路由

`ipc.js` 的 `update-token-usage`：

```js
const srcCtx = windowState.getContextByWebContents(event.sender);
let target = srcCtx;
if (!target || !target.rawWin || target.rawWin.isDestroyed()) {
  target = windowState.findHostContextForView(event.sender);   // 新增
}
if (!target || !target.rawWin || target.rawWin.isDestroyed()) return { success: false };
target.rawWin.webContents.send('shell-token-updated', {
  ...payload,
  viewKey: String(event.sender.id),
});
```

`findHostContextForView`：遍历 `windows`，若某 ctx 的 `attachedViews` 中包含该 webContents 的视图，返回该 ctx；否则返回 null。

### 3. 壳页面 token 映射与多栏渲染

```js
const tokenByView = new Map();   // viewKey -> number

function renderStatusBarTokens() {
  // 单视图：复用 #sb-context，保持原视觉
  // 多视图：动态生成多个 <div class="sb-item">，按 viewKey 插入顺序排列
}
```

清理时机：收到 `window-split-state` 结果或拆屏事件时，用当前视图集合过滤 `tokenByView`，删除不在集合内的 key。

### 4. 格式化不变

沿用现有 `formatTokenCount`，不改单位与精度。

## Complexity Tracking

无违反项，本节留空。
