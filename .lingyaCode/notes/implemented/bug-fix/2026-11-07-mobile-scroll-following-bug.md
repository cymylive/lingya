# Agent Note: 移动端聊天滚动跟随的强拽回 Bug

Status: implemented

## Problem
在手机端（以及窄屏网页端）查看 AI 的长回复时，如果用户手指上滑去翻看历史记录，只要 AI 还在流式输出新内容（或者哪怕只停顿了一下又继续输出），页面就会瞬间自动滚动回最底部。这导致用户根本无法阅读上面的历史对话。用户体验极差，感觉像在跟程序“抢方向盘”。

根因分析：之前依赖 `nearBottom`（距离底部 < 20px）来决定是否自动跟随。但在手机端，流式输出（SSE）导致 DOM 高度频繁跳动，加上手指触摸时的惯性，极容易误判用户还在“底部”，从而触发 `scrollToBottom`。

## Decision
1. 引入 **双重状态锁**：除了原有的 `stickToBottom`，新增一个 `isUserScrolling` 变量。
2. 在 `elMessages` 容器上监听 `touchstart` 和 `wheel` 事件，只要用户主动触摸或滚动，立刻将 `isUserScrolling` 置为 `true`。
3. 在核心的 `scrollToBottom(force)` 函数中加入严苛的拦截：`if (!force && (!stickToBottom || isUserScrolling)) return;`。这意味着只要用户的手在动，无论是 AI 的流式推流还是任何代码调用，都绝对无法强制滚动页面。
4. 解除锁定的条件只有一个：用户**手动滑到了最底部**。在 `scroll` 事件监听中，如果判断 `nearBottom()` 为真，则将 `isUserScrolling` 和 `stickToBottom` 同时复位。

## Alternatives considered
- **降低流式刷新的频率**：治标不治本，且流式输出的即时感大打折扣。
- **让用户点击一个“锁定滚动”按钮**：增加了用户的心智负担，移动端交互应尽量无感。

## Consequences
- 完美解决了移动端查看历史被拽回的痛点。
- 用户只要上滑，页面就不再乱动，直到用户自己滑到底部，页面才会恢复自动跟随。