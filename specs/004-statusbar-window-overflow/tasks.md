# 任务清单：状态栏多窗口溢出处理

**Feature**: `004-statusbar-window-overflow`
**Plan**: `specs/004-statusbar-window-overflow/plan.md`
**Spec**: `specs/004-statusbar-window-overflow/spec.md`

### T001 布局计算纯函数
- **文件**: 新建 `src/preload/statusbar-layout.js`、`test/preload/statusbar-layout.test.js`
- **接口**: `computeVisibleCount(availableWidth, itemWidths, totalCount)` → `{visible, folded}`；常量 `ITEM_ESTIMATED_WIDTH`、`OVERFLOW_BUTTON_WIDTH`
- **验证**: 6 个用例全绿（全放得下/放不下/恰好/极窄/空列表/未提供宽度）
- **依赖**: 无

### T002 渲染层折叠 + ResizeObserver
- **文件**: 改 `src/preload/shell-renderer.js`、`src/ui/shell.html`
- **接口**: 状态栏 DOM 增加 `#sb-overflow-item` / `#sb-overflow-btn` / `#sb-overflow-popup`
- **验证**: 分屏 8 个显示 N 块 + `+M`；拖动宽度折叠数实时变化；无横向滚动条
- **依赖**: T001

### T003 溢出浮层
- **文件**: 改 `src/preload/shell-renderer.js`
- **接口**: `renderOverflowPopup(allKeys)`；点击 `+M` toggle；点外部/Escape 关闭
- **验证**: 浮层列出全部窗口；点外部关闭；Escape 关闭；浮层开着时数据更新实时反映
- **依赖**: T002

### T004 边界收尾与回归
- **文件**: 改 `src/preload/shell-renderer.js`
- **验证**: 分屏降到 1 回单视图无残留；折叠数 0 不渲染 `+N`；极窄仍显示 `+N`；ResizeObserver 不可用不崩；`npm test` 全绿
- **依赖**: T001-T003

## 依赖关系

```
T001 → T002 → T003 → T004
```

## 里程碑

- **M1（T001-T002）**：状态栏不再溢出，多余窗口折叠为 `+N` —— P1 交付
- **M2（T003）**：点 `+N` 可查看全部 —— P2 交付
- **M3（T004）**：边界处理 + 全量回归通过
