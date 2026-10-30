# 窗口无缝合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持将两个完全独立的 LingYa 窗口无缝拼接成一个窗口（左右或上下分屏），内部视图保持原有的账号、会话、工具调用隔离，且支持随时拆分。

**Architecture:**
利用 Electron 的 `WebContentsView` 能够在不同 `BrowserWindow` 之间转移的特性。合并时，将 A 窗口的 AI 视图从 A 中移除并挂载到 B 窗口中。B 窗口的布局函数更新为左右或上下分屏。同时修复 `window.js` 的上下文路由，确保挂在 B 窗口的 A 视图依然能找回原来的 `sessionStore` 和 `profileId`。

**Tech Stack:** Electron WebContentsView, JavaScript (CommonJS), Node.js Test runner.

## Global Constraints
- 主进程与渲染进程严格分离，通过 IPC 通信。
- 保持原有的多标签页 (tabs) 逻辑不变，合并的视图作为附加视图 (AttachedView) 独立管理。
- 合并的视图必须保持原有的 partition 和 preload，不可重新创建 WebContentsView。

## Review Focus
- **输入焦点错乱**：合并后，两个 `WebContentsView` 并排，点击其中一个时，另一个是否还能正确接收事件，侧边栏的状态是否能跟着切换？
- **IPC 路由丢失**：合并后，被合并窗口的视图发起的工具调用 (IPC)，主进程能否正确识别出该视图原本属于哪个 profile 和 session？
- **拆回独立窗口**：拆分时，重新创建的 BrowserWindow 能否完整接管原来的视图，不丢失任何状态？

---

### Task 1: 扩展窗口上下文与上下文查找

**Files:**
- Modify: `src/main/window.js`

**Interfaces:**
- Produces: `ctx.attachedView` (WebContentsView | null), `addAttachedView(ctx, view)`
- Modify: `getContextByWebContents` 遍历 `ctx.attachedView`

- [ ] **Step 1: Write the failing test**

```javascript
// test/main/window-attached.test.js
const { addWindow, getContextByWebContents, addAttachedView } = require('../../src/main/window');
// ... mock win, view ...
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `addAttachedView` in `src/main/window.js`**
  - 在 `addWindow` 的 ctx 对象里增加 `attachedView: null`。
  - 新增导出函数 `addAttachedView(ctx, view)` 用于赋值。
  - 修改 `getContextByWebContents`，在第 4 项（tabs 遍历）后增加遍历 `ctx.attachedView`。
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

### Task 2: 修改主窗口布局逻辑支持分屏

**Files:**
- Modify: `src/main/index.js`

**Interfaces:**
- Consumes: `ctx.attachedView`
- Produces: `layoutSplit(ctx, mainView, attachedView)`

- [ ] **Step 1: 修改 `index.js` 中的 `layout` 函数**
  - 如果 `ctx.attachedView` 存在，则：
    - 若为左右分屏：主 view 宽度为 `(w - 4) / 2`，附加 view x 坐标偏移一半，中间留 4px 间隙（或 -4 消除间隙）。
  - 更新窗口 resize 时，同步调整两者的 bounds。

### Task 3: 合并与拆分 IPC 通道

**Files:**
- Modify: `src/main/index.js` (IPC 注册)
- Modify: `src/preload/dom/upload-hint.js` (或者浮窗 UI 按钮)

**Interfaces:**
- Produces: `window-merge-to`, `window-unmerge`

- [ ] **Step 1: 编写测试**
- [ ] **Step 2: 实现主进程 IPC `window-merge-to`**
  - 接收参数 `targetWindowId`。
  - 找出目标窗口 ctx，和当前窗口 ctx。
  - 把当前窗口的 active tab view 摘下来 (`removeChildView`)。
  - 挂到目标窗口 (`addChildView`)，并调用 `addAttachedView` 登记上下文。
  - 销毁当前窗口的 BrowserWindow（此时已空壳）。
  - 触发目标窗口的 layout 重排。
- [ ] **Step 3: 实现主进程 IPC `window-unmerge`**
  - 把 `attachedView` 摘下来，创建一个新的 BrowserWindow 挂上去，恢复上下文。
- [ ] **Step 4: 在 UI 层面增加触发按钮**
  - （可选，先用快捷键或命令行测试）

