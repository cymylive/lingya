# Agent Note: 移动端计划面板与滚动交互重构

Status: implemented

## Problem
移动端在频繁迭代中出现了严重的体验和稳定性问题：
1. **强行拽回底部**：尽管引入了 isUserScrolling 锁，但在流式气泡创建和工具卡片插入时，代码里的 scrollToBottom(true) 依然会强制剥夺用户的滚动权，导致用户完全无法查看历史记录。
2. **计划面板不显示或卡死**：后端向手机端广播 Todo 的链路断裂，且前端在注入 UI 时因锚点匹配问题，产生了多个重复的 `todo-panel` 节点，变量名被脱敏插件污染（变成 `html`），导致前端语法崩溃（白屏或点击无反应）。
3. **输入框文字被裁切**：textarea 在换行时高度计算没包含 padding，导致只能看到文字的上半身。

## Decision
1. **彻底根除自动滚动**：直接删除了所有非用户主动触发情况下的 scrollToBottom(true) 调用（包括新增气泡、添加工具卡）。除非用户自己点发送按钮，或者点击回底部的箭头，否则页面绝不自动滚动。
2. **清理并重构计划面板**：用脚本强制清理了 HTML 里所有重复的 `todo-panel` 节点，重新插入唯一的标准节点。重写 `renderTodoPanel`，修复脱敏导致的语法错误，并增加点击标题栏折叠/展开（`collapsed`）的动画。
3. **打通 Todo 数据链路**：在 `ipc.js` 的 `todoEvents.on('change')` 中，直接调用 `remoteMgr.broadcastTodoUpdate` 将数据推送到 WebSocket。
4. **输入框自适应**：CSS 增加 `box-sizing: border-box`，JS 的 `autoResize` 增加 2px 冗余，防止因小数像素导致文字被裁切。

## Alternatives considered
- **继续用锁定变量去拦截强制滚动**：治标不治本，只要代码里还有强制滚动入口，总会在某个意想不到的角落破坏体验。
- **用 React/Vue 重构前端**：违背宪法中的“原生 DOM”原则，且失去了轻量级优势。

## Consequences
- 移动端获得了类似原生 App 的滚动手感，计划面板能完美折叠，不再霸占屏幕。
- 彻底解决了脱敏规则误伤前端代码变量导致的崩溃问题。