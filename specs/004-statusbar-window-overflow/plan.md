# 状态栏多窗口溢出处理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 状态栏在分屏窗口数超出可视宽度时自动折叠为 `+N`，并提供浮层查看全部窗口信息。

**Architecture:** 把「计算该显示几个块」抽成纯函数（可测），渲染层用 `ResizeObserver` 监听状态栏宽度触发重算。浮层由壳页面动态创建，定位在状态栏上方，点外部/Escape 关闭。

**Tech Stack:** Electron 33 / CommonJS / 原生 DOM / `node --test`

**Spec:** `specs/004-statusbar-window-overflow/spec.md`

## Global Constraints

- 当前测试基准：`npm test` 1234 用例全绿
- UI 元素 id 不变：`sb-context`、`sb-tps-item`、`lingya-statusbar`
- 单视图场景行为零变化（FR-006、FR-016）
- 状态栏 CSS 现有类名保持：`sb-item`、`sb-label`、`sb-value`
- 不改主进程、不改 IPC、不改数据流

## Review Focus

1. **状态栏极窄（连一个块都放不下）** —— 期望至少显示 `+N`，不得空白
2. **分屏数从多降到 1** —— 期望回到单视图原样，无残留 `+N`、无残留浮层
3. **浮层打开时窗口被关到只剩 1 个** —— 期望浮层自动关闭，回到单视图
4. **ResizeObserver 不可用** —— 期望回退到固定 4 个，不崩溃
5. **token 值缺失的新窗口** —— 期望显示 `0`，不是 `--` 或空白
6. **折叠数恰好为 0** —— 期望不渲染 `+N` 按钮

---

## Task 1: 布局计算纯函数

**Files:**
- Create: `src/preload/statusbar-layout.js`
- Test: `test/preload/statusbar-layout.test.js`

**Interfaces:**
- Produces:
  - `computeVisibleCount(availableWidth, itemWidths)` → `{ visible: number, folded: number }`
  - `ITEM_ESTIMATED_WIDTH` 常量（约 240）
  - `OVERFLOW_BUTTON_WIDTH` 常量（约 64）

- [ ] **Step 1: 写失败测试**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { computeVisibleCount, ITEM_ESTIMATED_WIDTH, OVERFLOW_BUTTON_WIDTH } = require('../../src/preload/statusbar-layout');

test('全部放得下时 folded 为 0', () => {
  const r = computeVisibleCount(2000, [240, 240, 240]);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 0);
});

test('放不下时按宽度截断', () => {
  // 可用 1000，每块 240，溢出按钮 64 → 最多放 (1000-64)/240 = 3.9 → 3 个
  const widths = [240,240,240,240,240,240,240,240];
  const r = computeVisibleCount(1000, widths);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 5);
});

test('恰好放得下时不折叠', () => {
  const r = computeVisibleCount(720, [240, 240, 240]);
  assert.strictEqual(r.visible, 3);
  assert.strictEqual(r.folded, 0);
});

test('极窄宽度至少显示 0 个块 + 折叠全部', () => {
  const r = computeVisibleCount(100, [240, 240, 240]);
  assert.strictEqual(r.visible, 0);
  assert.strictEqual(r.folded, 3);
});

test('空列表返回 0/0', () => {
  const r = computeVisibleCount(1000, []);
  assert.strictEqual(r.visible, 0);
  assert.strictEqual(r.folded, 0);
});

test('未提供宽度数组时按估算宽度算', () => {
  const r = computeVisibleCount(1000, null, 8);
  assert.ok(r.visible >= 1);
  assert.strictEqual(r.visible + r.folded, 8);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `set "PATH=D:\NodeJS;%PATH%" && node test\preload\statusbar-layout.test.js`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 实现**

`computeVisibleCount(availableWidth, itemWidths, totalCount)`：先算所有块总宽，若 ≤ 可用宽度则全部显示；否则逐步减少可见数直到 `sum(visible) + OVERFLOW_BUTTON_WIDTH ≤ availableWidth`。`itemWidths` 为空时用 `ITEM_ESTIMATED_WIDTH × totalCount` 估算。

- [ ] **Step 4: 跑测试确认通过**

Run: `set "PATH=D:\NodeJS;%PATH%" && node test\preload\statusbar-layout.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/preload/statusbar-layout.js test/preload/statusbar-layout.test.js
git commit -m "feat: 状态栏折叠布局计算纯函数"
```

---

## Task 2: 渲染层接入折叠 + ResizeObserver

**Files:**
- Modify: `src/preload/shell-renderer.js`（`renderTokens` 多视图分支）
- Modify: `src/ui/shell.html`（`.statusbar` 加 `overflow-x: hidden`，新增浮层容器与样式）

**Interfaces:**
- Consumes: Task 1 的 `computeVisibleCount`
- Produces: 状态栏 DOM 中 `[data-sb-overflow]` 按钮 + `#sb-overflow-popup` 浮层

- [ ] **Step 1: shell.html 加浮层容器与样式**

在 `.statusbar` 内末尾加：
```html
<div class="sb-item sb-overflow" id="sb-overflow-item" style="display:none;">
  <span class="sb-value" id="sb-overflow-btn" style="cursor:pointer;">+0</span>
</div>
<div id="sb-overflow-popup" style="display:none;position:absolute;bottom:32px;right:16px;max-height:320px;overflow-y:auto;min-width:280px;background:var(--ck-bg-solid);border:1px solid var(--ck-border);border-radius:8px;padding:8px;z-index:10001;box-shadow:0 4px 16px rgba(0,0,0,0.3);"></div>
```
`.statusbar` 的 CSS 加 `overflow-x: hidden;`。

- [ ] **Step 2: renderTokens 多视图分支改造**

在 `renderTokens()` 里，生成块之前先算可见数：
```js
const barWidth = barEl.getBoundingClientRect().width - 32;  // 减去 padding
const layout = computeVisibleCount(barWidth, null, keys.length);
const visibleKeys = keys.slice(0, layout.visible);
const foldedKeys = keys.slice(layout.visible);
```
只渲染 `visibleKeys`，然后更新 `#sb-overflow-btn` 文本为 `+N`，`display` 按 `foldedKeys.length > 0` 切换。

- [ ] **Step 3: 加 ResizeObserver**

在 `renderTokens` 外初始化：
```js
let _sbResizeObserver = null;
function ensureResizeObserver() {
  if (_sbResizeObserver || typeof ResizeObserver === 'undefined') return;
  _sbResizeObserver = new ResizeObserver(function () {
    try { renderTokens(); } catch (_) {}
  });
  _sbResizeObserver.observe(barEl);
}
```
在 `renderTokens` 首次调用时 `ensureResizeObserver()`。ResizeObserver 不可用时静默跳过（回退到只在数据更新时重算）。

- [ ] **Step 4: 手动验证**

启动应用 → 分屏 8 个窗口 → 状态栏应显示 N 个块 + `+M` → 拖动窗口宽度 → 折叠数实时变化 → 无横向滚动条。

- [ ] **Step 5: Commit**

```bash
git add src/preload/shell-renderer.js src/ui/shell.html
git commit -m "feat: 状态栏溢出折叠（按宽度动态计算）"
```

---

## Task 3: 溢出浮层

**Files:**
- Modify: `src/preload/shell-renderer.js`

**Interfaces:**
- Consumes: Task 2 的 `foldedKeys` / `tokenByView` / `tpsByView` / `viewInfoByKey`
- Produces: 浮层渲染函数 `renderOverflowPopup(allKeys)`，点击外部/Escape 关闭

- [ ] **Step 1: 实现浮层渲染**

```js
function renderOverflowPopup(allKeys) {
  const popup = document.getElementById('sb-overflow-popup');
  if (!popup) return;
  popup.innerHTML = '';
  for (const vk of allKeys) {
    const winNo = viewInfoByKey.get(vk);
    const val = tokenByView.get(vk);
    const tps = tpsByView.get(vk);
    const row = document.createElement('div');
    row.className = 'sb-item';
    row.style.cssText = 'padding:4px 6px;border-radius:4px;';
    row.innerHTML =
      '<span style="font-size:11px;font-weight:600;margin-right:6px;">' + (winNo != null ? winNo + '号窗口' : '窗口?') + '</span>' +
      '<span class="sb-label">对话上下文:</span>' +
      '<span class="sb-value">' + formatTokenCount(typeof val === 'number' ? val : 0) + '</span>' +
      '<span class="sb-label" style="margin-left:8px;">输出速度:</span>' +
      '<span class="sb-value">' + ((tps && tps !== '--') ? tps : '--') + '</span>';
    popup.appendChild(row);
  }
}
```

- [ ] **Step 2: 绑定点击与关闭**

点击 `#sb-overflow-btn` 时 toggle 浮层；文档级 click 监听（捕获阶段）判断点击是否在浮层/按钮外，是则关闭；keydown Escape 关闭。

- [ ] **Step 3: 浮层内容随数据更新**

`renderTokens()` 末尾：若浮层当前可见，重新调 `renderOverflowPopup(keys)`。

- [ ] **Step 4: 手动验证**

分屏 8 个 → 点 `+3` → 浮层列出全部 8 个 → 点外部关闭 → 再点 `+3` → Escape 关闭 → 浮层开着时新窗口的 token 更新能实时反映。

- [ ] **Step 5: Commit**

```bash
git add src/preload/shell-renderer.js
git commit -m "feat: 状态栏溢出浮层（查看全部窗口）"
```

---

## Task 4: 回归与边界收尾

**Files:**
- Modify: `src/preload/shell-renderer.js`（边界处理）

- [ ] **Step 1: 处理边界**

- 分屏数降到 1：删除所有 `[data-sb-multi]`、隐藏 `+N`、关闭浮层（已有单视图分支，确认浮层也关闭）
- 折叠数为 0：隐藏 `+N`
- 极窄宽度：`visible === 0` 时仍显示 `+N`（此时 `+N` 即全部）
- `ResizeObserver` 不可用：不报错，仅靠数据更新触发重算

- [ ] **Step 2: 跑全量测试**

Run: `set "PATH=D:\NodeJS;%PATH%" && npm test`
Expected: 全绿（1234 + 新增 6）

- [ ] **Step 3: 手动验证边界**

1. 分屏 8 个 → 逐个关闭到 1 个 → 状态栏回到单视图原样，无 `+N`、无浮层
2. 浮层打开时关闭窗口到只剩 1 个 → 浮层自动关闭
3. 窗口拖到极窄 → 至少显示 `+N`
4. 新开窗口还没 token → 显示 0

- [ ] **Step 4: Commit**

```bash
git add src/preload/shell-renderer.js
git commit -m "fix: 状态栏溢出边界处理"
```

---

## 自检结果

- **Spec 覆盖**：US1 → Task 1/2（FR-001~008）；US2 → Task 3（FR-009~014）；FR-015/016 → Global Constraints + Task 4；Edge Cases 全部落到 Task 4 的手动验证。
- **步骤扫描**：每个 step 单一动作、有可检查结果。
- **类型一致性**：`computeVisibleCount` 返回 `{visible, folded}`，Task 2/3 消费一致。
- **Review Focus**：6 条均已在 Task 1 测试或 Task 4 手动验证中钉住。
- **比例**：计划精简，代码块只给关键签名与断言，实现体留给执行者。
