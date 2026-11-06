# Agent Note: 移动端 UI 防遮挡与滚动跟随优化

Status: implemented

## Problem
在手机端（尤其是 PWA 和 Capacitor APK）中，出现了三个极影响体验的 UI/交互问题：
1. AI 正在生成时，原本用于提示状态的悬浮胶囊（exec-status）由于采用绝对定位（`position: absolute`），在带有安全区的手机上直接飘到了顶部栏，挡住了“选择窗口”下拉框，导致无法点击。
2. 为了自动滚动到底部看最新消息，代码使用了`scrollToBottom`。但手机端惯性滑动极易触发误差范围（BOTTOM_THRESHOLD=60），导致用户想往上翻看历史时，只要新消息流式输出，就被强行拽回底部。
3. 输入框多行文本（textarea）自带丑陋的右下角缩放箭头，破坏 UI 整洁。

## Decision
1. **状态胶囊定位调整**：将 `.exec-status` 从 `absolute` 改为 `fixed`，并使用 `top: calc(var(--safe-t) + 54px)` 动态计算位置，确保它永远贴在顶部栏下方。最重要的是加入了 `pointer-events: none;`，让触摸事件直接穿透它，哪怕它悬浮在屏幕上，也绝不阻挡下方按钮的点击。
2. **滚动跟随解耦**：引入 `touchstart` 和 `wheel` 事件监听。一旦用户手指触碰屏幕或滑动滚轮，立刻将 `stickToBottom` 设为 `false`。取消自动跟随。同时把 `BOTTOM_THRESHOLD` 缩小到 20px，提高判定灵敏度。
3. **移除原生样式**：对 `textarea` 强制应用 `resize: none !important`，并在 HTML 中把“发送”和“停止”按钮放入同一容器，用状态机控制红绿交替，杜绝 CSS 覆盖导致的重叠。

## Alternatives considered
- **彻底隐藏状态胶囊**：作为唯一的系统级状态反馈，隐藏会让用户在等待时失去“AI 是否在干活”的感知，体验倒退。
- **限制 AI 的流式输出频率**：流式输出是灵鸦的核心优势，因噎废食不可取。

## Consequences
- 手机端的操作逻辑完全符合原生 App 的直觉：滑到上面就不会被拽回，碰到悬浮提示条可以直接点下面的按钮。
- 需要用户在最新版 APK 中才能体验到这些纯前端的修复。