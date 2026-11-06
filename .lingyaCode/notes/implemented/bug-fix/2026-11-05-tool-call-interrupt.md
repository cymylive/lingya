# Agent Note: 修复「每次调用工具都中断」——四条叠加的中断路径

Status: implemented

## Problem

用户报告：每次灵鸦调用工具都会中断，必须人工说「继续」才能往下走。实测日志（`chat.deepseek.com-1793880614795.log`，1034 行）暴露了四条独立的中断路径：

### 路径一：发送延迟撞 RESPONDED 超时（最核心）

日志 478-495 行的完整现场：

```
478  AWAITING -> RESPONDED              ← 收到 AI 回复
488  等待 38249ms 后发送                 ← 随机延迟 38 秒
489  RESPONDED 已停滞 31s 超过阈值 30s   ← 超时触发
490  重置为 IDLE（RESPONDED 超时自动恢复） ← 状态被强制清掉
491  等待结束，开始触发发送
493  IDLE -> SENT（XML工具调用提示）      ← 从 IDLE 发消息，链条断了
```

**时间线冲突**：`sendDelay` 最长 **40000ms**（`chat-input.js` 的随机区间 `[10000, 40000]`），`RESPONDED` 超时阈值 **30000ms**（`task-state.js:30`）。延迟还没结束，状态机就判定「卡死」并重置。

`queued` 标记机制存在（`task-state.js:201` 的 `setQueued`），但**只覆盖「回复处理排队」，不覆盖「发送延迟等待」**——`enqueueProcessing` 里设了，`doSendToChat` 的 `setTimeout` 里没设。

### 路径二：XML/DSML 误判

`xml-detect.js:51` 的原条件：

```js
return hasDsmlMark || (hasXmlInvoke && (hasXmlClose || hasXmlParam));
```

`hasXmlClose` 过松——AI 讨论 XML、复述工具格式、写文档时，很容易带出 `</invoke>` 这类文本，被误判为「AI 用了 XML 格式调工具」。

一旦误判，就走「发 XML 提示消息」流程 → 触发路径一的延迟陷阱。

### 路径三：`judgeUserWait` 把「复述计划」当「提问」

`intercept-observer.js:199` 的判定，最宽松的一条：

```js
// 1b) 行首字母选项：A. / B. / A) / B）（至少 2 个不同字母）
const letterOpts = noCode.match(/^[ \t]*([A-Da-d])\s*[.．、)）]\s*\S/gm) || [];
if (letters.size >= 2) return { matched: true, strong: true };
```

AI 在做任务分析、列方案、复述计划时，几乎必然出现 A/B/C 选项。被判定为 `strong: true`（强等待），直接 `reset('AI 在向用户提问')`，停止自动续跑。

日志里 10 次「AI 在向用户提问」（361/372/502/511/520/529/538/552/771 行），大部分是误判——AI 只是在汇报进度时列了几个方向。

### 路径四：`tryParseToolCall` 把普通 JSON 当工具调用

`tool-parser.js:118-127` 的第三级兜底：从任意正文里捞 `{...}` 尝试解析。AI 复述 todo 项时输出的 `{"content":"...","status":"completed"}` 被当成工具调用候选，缺 `toolName` 后返回 null——但已触发后续 XML 检测链路。

## Decision

四处改动，全部在 preload 层，不动主进程和 IPC 协议：

### P0-a：提高 SENT / RESPONDED 超时阈值到 60s

`task-state.js:22-33`：

```js
SENT: 60 * 1000,        // 30s → 60s
RESPONDED: 60 * 1000,   // 30s → 60s
```

覆盖最长 40s 延迟 + 20s 余量。代价是真卡死时要多等 30s，可接受。

### P0-b1：tick 自愈检查从 RESPONDED 扩展到 SENT

`task-state.js` 的 ticker：

```js
// 原：if (current.state === STATES.RESPONDED && !current.queued && ...)
// 改：if ((current.state === STATES.RESPONDED || current.state === STATES.SENT) && !current.queued && ...)
```

因为延迟期间状态可能停在 SENT（已发送等响应），也可能停在 RESPONDED（收到回复待发送），两个都要保护。

### P0-b2：发送延迟期间设/清 queued

`chat-input.js` 的 `doSendToChat`：

- `setTimeout` 之前：`taskState.setQueued(true)`
- `triggerSend` 成功后：`taskState.setQueued(false)`（在 `taskState.transition(SENT)` 之前）
- 发送失败 / 用户停止 / 提前 return 的三条路径也各加一次清理

**为什么复用 `queued` 而不新增 `sending` 标记**：语义上「等待发送」和「排队处理」都是「还没发出去」，共用 `queued` 最省事。UI 显示的文案是「已收到回复，排队等待处理…」，用户看到的是「还没发出去」，符合直觉。新增独立标记会波及 UI、状态机、监督者三处，改动面大而收益小。

### P1：XML 检测收紧

`xml-detect.js:51`：

```js
// 原：return hasDsmlMark || (hasXmlInvoke && (hasXmlClose || hasXmlParam));
// 改：return hasDsmlMark || (hasXmlInvoke && hasXmlParam);
```

去掉宽松的 `hasXmlClose`。真正的 DSML 调用一定带 `parameter name=`，只有 `</invoke>` 不算。

### P2：judgeUserWait 加前置判断

`intercept-observer.js:199` 的 `judgeUserWait` 开头：

```js
// 如果本轮回复包含工具调用代码块，说明 AI 还在干活，不算提问
if (/```(?:lingya|json|javascript|js)/i.test(text)) {
  return { matched: false, strong: false };
}
```

AI 输出工具调用代码块时，即使正文里带 A/B/C 选项，也说明它还在执行阶段，不该判定为「等用户决策」。

## Alternatives considered

**只提高超时阈值，不修 queued** —— 落选原因：阈值是拍脑袋的数字，下次用户把随机延迟上限调到 60s 就又会撞。修 `queued` 是结构性的，阈值提高只是兜底。

**新增独立的 `sending` 标记** —— 落选原因：语义上 `queued` 已经覆盖「还没发出去」，新增标记会波及 UI（`ui.js:378` 的文案）、状态机（`describe()`）、监督者三处。改动面大，收益仅是多一个更精确的文案，不划算。

**缩短随机发送延迟上限（40s → 15s）** —— 落选原因：会破坏现有的拟人化防检测效果。40s 的随机区间是有意设计的（对齐 Cuckoo），目的是让发送节奏不像机器。

**XML 检测彻底移除** —— 落选原因：某些场景下 AI 确实会用 XML/DSML 格式调工具（比如模型切换后行为变化），完全移除会漏掉这类情况。收紧条件保留能力，同时消除误判。

**judgeUserWait 改成「只认问号」** —— 落选原因：AI 经常用「请选择」「你希望我」这类句式提问，不带问号。只认问号会漏判真实提问，导致任务被误催。

**在 `tryParseToolCall` 里收紧第三级兜底（P3）** —— 本次未做。日志里这个误判没有直接导致中断（返回 null 后只是继续走 XML 检测），影响较小。留作后续优化。

## Consequences

**收益**：

- **修复「每次调用工具都中断」**：延迟期间 queued=true，tick 不再误判卡死，状态机不会在消息发出前被重置
- **XML 误判大幅减少**：AI 讨论 XML / 复述工具格式不再触发假提示消息
- **复述计划不再被当提问**：AI 输出工具代码块时，正文里的 A/B/C 选项不会中断自动续跑
- 全量测试 1297/1298 通过，唯一失败是改造前就存在的 `redaction-store.test.js` 导出导入问题
- 手动验证：P1 5/5、P2 4/4 边界用例全部通过

**代价**：

- 真卡死时（工具真的挂了）要多等 30s 才触发兜底恢复。之前 30s 就报「卡死」，现在 60s
- `queued` 被复用于「等待发送」语义，UI 文案是「排队等待处理」，与实际「等待发送」略有偏差。用户感知上一致（都是还没发出去），可接受
- 修复后仍需用户实测验证。代码层已到位，但真实的 DeepSeek 交互时序只有跑起来才知道有没有遗漏的边界

## 备注

- 阈值：`src/preload/dom/task-state.js:22-33`
- tick 自愈：`src/preload/dom/task-state.js` 的 ticker（约 100-130 行）
- queued 设置：`src/preload/dom/task-state.js:201` 的 `setQueued`
- 延迟设/清：`src/preload/dom/chat-input.js` 的 `doSendToChat`（约 376-638 行）
- XML 检测：`src/preload/dom/xml-detect.js:51`
- 提问判定：`src/preload/dom/intercept-observer.js:199` 的 `judgeUserWait`
- 备份：四个文件的 `.bak-interrupt-20261105`
- 全量测试：1298 tests / 1297 pass / 1 fail
