# LingYa 仿 dsh UI 布局改造方案（阶段 2）

> 依据：DeepSeek Harness（dsh）的 `packages/client/ui-layout`（三栏骨架）与 `ui-primitives`（组件视觉）。
> 落点：LingYa 的 `src/preload/overlay/template.js`、`src/preload/overlay/ui.js`、`src/ui/shell.html`。
> 约束：**不改 `id` 属性**（events.js / ui.js 依赖 getElementById）；每步独立可回滚；改后跑 `npm test`。

---

## 一、现状 vs dsh 目标

| 维度 | LingYa 现状 | dsh 目标 | 差距 |
|---|---|---|---|
| 布局骨架 | 覆盖层浮在 AI 网页上，左侧栏 280px 固定 | 三栏 grid + drag handle | 中 |
| 工具展示 | 纯文本条目塞进日志列表 | 卡片化（工具名 + 参数 + 状态徽标 + 可折叠输出） | 大 |
| 计划展示 | plan-panel.js 简单列表 | 进度卡片 + 状态徽标 | 中 |
| 视觉语言 | 墨鸦主题硬编码色 | CSS 变量体系 | 中 |
| 圆角 | 不统一 | 六档：4/8/12/16/20/28 | 小 |

---

## 二、改造分块（按优先级 + 风险）

### 块 ①　工具调用卡片（首选，改动最小最出效果）

**模块**：`src/preload/overlay/tool-card.js`（已完成）
**导出**：`renderToolCard(opts)`、`TOOL_CARD_CSS`、`injectToolCardCSS(doc)`、`escapeHtml`、`summarizeArgs`、`formatOutput`

**卡片结构**：

```html
<div class="lingya-tool-card" data-status="success" data-collapsed="false">
  <div class="lingya-tool-card__head">
    <span class="lingya-tool-card__icon">▶</span>
    <span class="lingya-tool-card__name">bash</span>
    <span class="lingya-tool-card__summary">echo hi</span>
    <span class="lingya-tool-card__badge">成功</span>
  </div>
  <div class="lingya-tool-card__body">…参数 / 输出…</div>
</div>
```

**接入方式**：
1. `template.js` 的 `OVERLAY_CSS` 末尾追加 `require('./tool-card').TOOL_CARD_CSS`
2. 或在覆盖层注入后调用 `injectToolCardCSS(document)`
3. 渲染工具结果处调用 `renderToolCard({ name, args, status, output })`

### 块 ②　计划卡片（改 plan-panel.js）

把 `plan-panel.js` 从简单列表改成 dsh `ui-plan` 的进度卡片。风险低，独立模块。

### 块 ③　可拖拽三栏 —— 已存在（无需改造）

核查发现 LingYa 早已实现：`src/ui/shell.html` 的 `#lingya-sidebar-resizer` + `src/preload/shell-renderer.js` 第 80-98 行的拖拽逻辑（MIN_W=240 / MAX_W=640 / localStorage 持久化）。**此项无需改造。**

### 块 ④　视觉语言（CSS 变量体系）—— 务实收敛

**决策**：不做强制替换。理由：LingYa 的 `--ck-*` 变量体系已协调，dsh 六档圆角是给 React 组件设计的，直接套到注入浮层会破坏现有视觉。强行替换属过度工程。

**保留**：`tool-card.js` 已自带一套 `--lg-radius-*` / `--lg-*` 变量（与 dsh 六档对齐：sm=8 / md=12 / lg=16），作为卡片类新组件的局部变量。其余沿用 `--ck-*`。

---

## 三、执行顺序

```
块① 工具卡片（已完成模块） → 块④ CSS 变量 → 块② 计划卡片 → 块③ 可拖拽三栏
```

---

## 四、验收标准

- [x] 工具卡片模块 tool-card.js（14 测试通过）
- [x] 工具卡片接入 template.js（OVERLAY_CSS 追加）
- [x] 工具卡片接入渲染流程（tool-executor.js：require + renderResultCard + 4 处调用 + #lingya-tool-cards 容器）
- [x] 计划面板加进度条（plan-panel.test.js 2/2 通过）
- [x] 左侧栏可拖拽调宽（早已存在，无需改造）
- [x] 圆角变量：tool-card.js 自带 `--lg-radius-*`（务实收敛，不强制全局替换）
- [x] 元素 `id` 保持不变
- [ ] `npm test` 全绿（受 electron 环境问题阻塞，改动相关测试已全过）

---

## 五、已知坑

1. **模板字符串反引号**：写含三反引号的字符串时，用数组 join（LINGYA.md 常见坑 #1）
2. **CSS 数组插入**：单引号字符串元素里放真实换行会语法错误，必须拆成独立数组元素（#2）
3. **IPC 找不到 ctx**：`shell.html` 的 IPC 要走 `rawWin` 反查上下文（记忆 #168）
4. **打包前必须先问用户**（记忆 #171）
5. **改 UI 必须保持元素 id 不变**（events.js / ui.js 依赖 getElementById）
6. **写文件用 String.raw 或数组 join**：普通模板字符串会吃掉 `\s`、`\n` 等转义（本轮踩坑）
