# Agent Note: 工具卡片必须自己注入样式，且执行前就要出现

Status: implemented

## Problem

用户反馈：AI 明明在调用工具（会话里有 `lingya` 代码块、有执行结果回传），但覆盖层面板上**什么都看不到**，因此判断「工具没有正常工作」。

排查后发现这是三条独立缺陷叠加，每一条单独都足以让反馈消失：

1. **样式从未注入**。`src/preload/overlay/tool-card.js` 定义了 `TOOL_CARD_CSS` 并通过 `module.exports` 导出，还写了个 `injectToolCardCSS()` 辅助函数——但**全项目没有任何地方调用它**。结果是 `#lingya-tool-cards` 里确实渲染出了卡片 div，可是没有边框、没有背景、没有字号、折叠也失效。在 DeepSeek 的深色页面上，它与普通正文视觉上毫无区别。

2. **只在「事后」渲染一次**。`renderResultCard` 唯一的调用点在 `await window.electronAPI.executeJs()` **返回之后**。执行期间（可能长达数分钟的工具调用）界面零反馈。

3. **容器默认隐藏**。卡片容器 `#lingya-result-section` 在 `template.js` 里初始就带 `lingya-hidden` 类，用户必须手动展开覆盖层的「日志」页签才能看到内容——而用户没有任何理由知道要去那里找。

另外还发现一个独立的挂死点：`tools/browser-window-manager.js` 的 `injectJS()` 直接 `await wc.executeJavaScript(wrapped, true)`。当目标 webContents 被遮挡、最小化或渲染进程卡住时，这个 Promise **永不 settle**。表现是 AI 回复停在 `The tool call seems to not be returning`，Agent 循环彻底停摆，且没有任何错误提示。`wyp/log/main-errors.log` 里多次出现的 `[unresponsive]` 记录与此吻合。

## Decision

**卡片职责自包含，反馈前置，挂死必须有超时。**

- `ui.injectCSS()` 统一注入 `TOOL_CARD_CSS`（带 `lingya-tool-card-style` id，幂等）。样式不再依赖调用方记得去注入。
- `tool-card.js` 新增 `upsertToolCard(box, opts)`：支持传入 `cardId`，同 id 的卡片**原地替换**而非重复追加，让「执行中 → 成功/失败」是同一条目的状态翻转，而不是两条记录。
- `tool-executor.js` 的两个入口（`handleJsToolScript` / `handleToolCall`）都改为：
  1. **执行前**先插入 `status: 'running'` 的卡片，并主动移除容器的 `lingya-hidden`
  2. 完成后按同一个 `cardId` 原地更新为 `success` / `error`
  3. 异常路径（catch）同样落到卡片上，不允许「失败了但界面无变化」
- `browser-window-manager.injectJS()` 用 `Promise.race` 加 60 秒超时；超时抛明确错误，让上层卡片显示失败、Agent 循环得以继续。

## Alternatives considered

**在 `template.js` 里把 `TOOL_CARD_CSS` 合并进 `OVERLAY_CSS`** —— 落选原因：`tool-card.js` 的设计初衷是「卡片模块自包含，含渲染 + 样式」，合并进 template 会让它重新依赖外部。更关键的是 `tool-card.js` 有独立单测（`test/preload/tool-card.test.js` 验证 `TOOL_CARD_CSS` 内容），合并后样式与渲染分居两处，改动容易不同步。

**改成「每次渲染都带内联 style」** —— 落选原因：卡片结构有十余个元素，内联样式会让渲染函数变成噪声，也无法用伪类（`:hover`、`[data-status]` 属性选择器）。CSS 类 + 一次性注入是正确分工。

**容器 `lingya-result-section` 默认就不隐藏** —— 落选原因：该容器为空时占据版面、干扰视觉。正确做法是「有内容才展开」——即渲染卡片时主动移除 `lingya-hidden`，而不是把默认值翻过来。

**injectJS 超时后自动重试一次** —— 落选原因：挂死通常意味着目标 webContents 本身就卡住了，重试大概率同样挂 60 秒，只会让用户多等一分钟。明确失败、让 AI 换个方式（例如用 `webFetch` 或先激活该标签页）更有价值。

## Consequences

**收益**：
- 工具调用从「点下发送」到「执行完成」全程有可见反馈，且是同一条卡片的状态翻转，不会刷屏
- 失败路径也有卡片，用户能区分「没跑」「跑了但失败」「跑了且成功」
- injectJS 不再能永久冻结 Agent 循环
- 样式与渲染同属 `tool-card.js` 且被统一注入，后续改卡片外观只需动一个文件

**代价**：
- `tool-executor.js` 的调用点从「一次」变成「两次」（前 running、后结果），`cardId` 必须在两个调用点间正确传递；`handleToolCall` 的 `callId` 来自 AI 侧、可能缺失，故加了 `callId || ('tool_' + toolName)` 的兜底
- 卡片最多保留 20 张的裁剪逻辑从 `renderResultCard` 挪到了 `upsertToolCard`，两处行为需保持一致
- 60 秒超时对某些极慢的注入场景可能是误杀（但相比永久挂死仍是更好的取舍）

## 备注

- 样式注入点：`src/preload/overlay/ui.js` 的 `injectCSS()`
- 卡片更新：`src/preload/overlay/tool-card.js` 的 `upsertToolCard()`
- 调用点：`src/preload/dom/tool-executor.js` 的 `handleJsToolScript()` / `handleToolCall()`
- 超时：`tools/browser-window-manager.js` 的 `injectJS()`
