# Agent Note: 脱敏占位符在本地四个出口还原真词

Status: implemented

## Problem

出站脱敏把真词换成占位符（`⟦自动31⟧` / `memory` / `src/`）再发给 AI，防止真词泄露给 AI 平台。AI 复述工具结果时带占位符，于是**所有本地出口**看到的都是占位符：

1. **网页 DOM**：用户在 DeepSeek 页面直接看到、全选复制到的，是占位符
2. **IM 推送**：飞书/微信/QQ 收到的 AI 回复是占位符
3. **会话历史**：导出的 Markdown、本地存档 jsonl 是占位符
4. **覆盖层日志**：灵鸦面板的命令历史是占位符

用户实测反馈：让 AI 分析一个项目，导出的 txt 里 14 处占位符（`DeepSeek`=`DeepSeek`、`Agent`=`agent` 等），内容无法阅读。

**注意**：这不是 bug，是脱敏的必然结果。AI 只能看到占位符，复述时自然带占位符。要解决必须在本地出口做反向还原。

## Decision

在 `redaction-filter.js` 新增 `unredactText()`（与 `redactText` 共享同一份 `cachedPairs`，反向替换），然后在四个出口调用：

| 出口 | 文件 | 接入点 |
|---|---|---|
| ① 网页 DOM | `src/preload/dom/dom-unredact.js`（新建） | `MutationObserver` 监听 AI 回复容器，节流 150ms 遍历文本节点替换 |
| ② IM 推送 | `feishu-bridge.js` / `weixin-bridge.js` / `qq-bridge.js` | `report()` 函数里，`api.xxxReport(payload)` 之前还原 `payload.text` |
| ③ 会话历史 | `conversation-log.js` | `addEntry()` 里，`String(text).trim()` 之前还原 |
| ④ 覆盖层 | `overlay/ui.js` | `addHistory()` 里，`commandHistory.unshift()` 之前还原 `entry.command` 和 `entry.output` |

**DOM 还原的三条防坑措施**（这是唯一有风险的部分）：

1. **防自触发**：改 DOM 前 `observer.disconnect()`，改完再 `observe()`，避免 MutationObserver 死循环
2. **节流 150ms**：流式输出时高频 mutation，不节流会卡顿
3. **覆盖后重放**：DeepSeek 前端 diff 可能把占位符还原回去，observer 会再触发补刀

只改 `nodeValue`，不碰 `innerHTML`，不破坏 React/Vue 结构。选择器用多组模糊匹配（`.ds-markdown` / `[class*="markdown"]` / `[class*="message"] [class*="content"]`），失效时静默降级。

**服务器侧不变**：DeepSeek 收到的仍是占位符，真词全程不出本机。

## Alternatives considered

**关掉出站脱敏，让 AI 直接看真词** —— 落选原因：用户明确要求防泄露，API Key、项目名不能发给 AI 平台。这是脱敏的核心目的。

**只做 IM + 会话历史，不做 DOM** —— 落选原因：用户最常看到的是网页 DOM，不做这一层等于没解决核心诉求。

**DOM 用 `innerHTML` 整段替换** —— 落选原因：会破坏 React/Vue 的虚拟 DOM 结构，导致页面重渲染异常、事件绑定失效。只改 `nodeValue` 是唯一安全做法。

**在 AI 回复到达 preload 时还原，再写回页面** —— 落选原因：preload 无法写入页面 DOM（contextIsolation 隔离），只能通过覆盖层间接操作，且会被页面渲染覆盖。

**流式结束后一次性还原（不做节流）** —— 落选原因：流式过程中用户看到的是占位符，体验差。节流 150ms 兼顾体验和性能，代价是可能看到轻微闪烁。

## Consequences

**收益**：

- 四个本地出口全部显示真词：网页、IM 推送、导出 Markdown、覆盖层日志
- 用户复制网页内容是**真词**
- 服务器侧零变化，真词不出本机
- 双向闭环完整：出站替换（防泄露）→ 入站还原（工具能工作）→ 本地出口还原（用户能阅读）

**代价**：

- **DOM 还原是后处理，不是稳定契约**。DeepSeek 每次前端改版都可能让选择器失效，需要跟着维护。失效时静默降级（只 warn 一次），不影响对话
- **可能看到轻微闪烁**：流式输出时，占位符先渲染 → 150ms 内被替换成真词。极端情况（前端 diff 频繁）可能来回闪
- **性能开销**：长回复（几千字）+ 频繁 mutation，节流后影响可忽略，但确实多了一层 observer
- **上下文可能不一致**：用户看到真词，AI 服务器里是占位符。下一轮 AI 提到同一内容时，用户看到的真词和 AI 说的占位符对不上（但入站还原保证操作正确）
- 新增 `dom-unredact.js`（约 130 行），需要维护选择器列表

## 备注

- 反向还原函数：`src/preload/dom/redaction-filter.js` 的 `unredactText`
- DOM 还原模块：`src/preload/dom/dom-unredact.js`（新建）
- 初始化：`src/preload/index.js` 的 `initConversationLog()` 之后
- IM 三桥：`feishu-bridge.js` / `weixin-bridge.js` / `qq-bridge.js` 的 `report()`
- 会话历史：`conversation-log.js` 的 `addEntry()`
- 覆盖层：`overlay/ui.js` 的 `addHistory()`
- 全量测试：1271/1272 通过，唯一失败 `导出→导入往返` 是改造前就有的已知问题
- 打包产物：`dist/灵鸦-win-v0.6.194.exe`（109.22 MB，PE 头 `4d5a` 有效）
