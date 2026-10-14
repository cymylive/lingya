# Agent Note: 仿 dsh 重做 LingYa 覆盖层 UI

Status: proposed

## Problem

LingYa 的覆盖层 UI（`src/preload/overlay/template.js` + `ui.js`）是早期快速迭代的产物：工具调用以纯文本条目堆在日志列表里，视觉语言靠硬编码墨鸦色，左侧栏宽度固定不可调。用户对比 DeepSeek Harness（dsh）后认为其布局更专业、信息层次更清晰，希望借鉴。

dsh 是 TypeScript + React 的独立 Web 应用，与 LingYa 的「注入 AI 网页的浮层」架构完全不同，无法直接移植代码。需要的是**设计语言的复刻**：卡片化、三栏骨架、统一的 CSS 变量体系。

## Proposal

分四块改造，按风险递增排序：

1. **工具调用卡片**（首选）：工具调用从纯文本改为卡片（工具名 + 参数 + 状态徽标 + 可折叠输出），对齐 dsh `ui-tool` 的 ReadBlock/CodeCard/TerminalBlock
2. **CSS 变量体系**：抽取统一圆角（六档 4/8/12/16/20/28）和语义色变量，明暗主题各一套
3. **计划卡片**：`plan-panel.js` 从简单列表改为进度卡片
4. **可拖拽三栏**：左侧栏宽度可拖拽（pointer capture + rAF 节流），对齐 dsh `AppFrame`

详细落点、结构、CSS、验收标准见 `docs/UI-REDESIGN-PLAN.md`。

## Alternatives considered

**直接移植 dsh 的 React 组件** —— 落选原因：dsh 的 `ui-*` 包依赖其 Cordis 微内核、类型契约、构建链，且是独立 Web 应用。LingYa 的 UI 注入到第三方网页里，运行环境完全不同，React 组件树搬不进来。强行移植等于用 dsh 重写 LingYa，会丢掉「零 Token 成本」这个命脉。

**只改配色不改结构** —— 落选原因：用户明确说"布局好看"，指的是信息层次和骨架，不只是颜色。纯换色解决不了工具展示混乱的问题。

**一次全改（骨架 + 卡片 + 变量）** —— 落选原因：改动面太大，一旦 `template.js` 的 `OVERLAY_HTML 包含核心元素` 断言被破坏，回归难定位。分四块，每块独立可验证、可回滚。

## Acceptance criteria

- 工具调用显示为卡片，含工具名/参数/状态徽标/可折叠输出
- 计划面板显示为进度卡片
- 左侧栏可拖拽调宽（200-500px），状态持久化
- 圆角统一为六档 CSS 变量，无硬编码色
- `npm test` 全绿
- 元素 `id` 保持不变

## Risks

- **破坏现有测试**：`template.js` 有 `OVERLAY_HTML 包含核心元素` 和 `OVERLAY_CSS 包含核心样式` 断言，改 HTML/CSS 可能触发。缓解：保留旧类名做兼容，逐步替换。
- **shell.html 的 IPC 坑**：改可拖拽三栏涉及壳页面 IPC，历史上出现过「IPC 找不到 ctx」（记忆 #168）。缓解：最后做，且用 `rawWin` 反查上下文。
- **有意放弃**：不做 dsh 那么丰富的组件（diff 视图、轨迹视图、审批卡片），只取对 LingYa 最高频使用的工具卡片和计划卡片。其余按需再加。
