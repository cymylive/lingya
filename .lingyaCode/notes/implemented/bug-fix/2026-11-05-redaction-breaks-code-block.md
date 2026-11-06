# Agent Note: 脱敏规则破坏代码块识别导致任务提前结束

Status: implemented

## Problem

用户报告：任务中途「突然结束」，AI 说一句「让我继续查…」就回 IDLE，不再自动往下走，必须人工说「继续」。

实测日志（`chat.deepseek.com-1793885795361.log`）暴露的现场：

```
408  收到回复：正文 1042 字符，思考 315 字符
411  正常文本回复，未检测到工具调用，且无未完成计划   ← 硬编码日志
412  重置为 IDLE（一轮循环正常收尾）
```

同样的模式在日志里重复出现 3 次。

**根因链条**（用户自己判断出来的）：

1. 系统提示词里写的是 \`\`\`lingya 代码块围栏
2. 出站脱敏把 `lingya` 替换成 `lingya`（规则表里有「代码块」这条规则，`words: ['lingya']`）
3. AI 看到的系统提示词是 \`\`\`lingya
4. AI 模仿输出，回复里的代码块围栏也是 \`\`\`lingya
5. `js-detector.js` 的 `extractJsToolBlocks()` 只认 `lingya` / `js` / `javascript` 三种围栏语言
6. 识别失败 → 落到「正常文本回复」分支 → `taskState.reset('一轮循环正常收尾')` → 任务结束

**规则表里还命中了四个工具函数名**：`edit` / `glob` / `bash` / `todoWrite`。即使围栏被还原，代码块里写的 `await edit(...)` 在 AI 看来也是 `await edit(...)`，JsRunner 执行会报 `edit is not defined`。

**关键证据**：在 `intercept-observer.js` 里搜索 `unredact`，结果是**零**——入站还原从未在代码块检测之前执行。

## Decision

### 修复 1：`extractJsToolBlocks` 的入参改为 unredact 后的文本

`intercept-observer.js` 的 `processInterceptedResponse` 里，`extractJsToolBlocks(raw)` 之前插入：

```js
let workRaw = raw;
try {
  const { unredactText } = require('./redaction-filter');
  if (typeof unredactText === 'function') workRaw = unredactText(raw);
} catch (_) { /* 脱敏模块不可用则用原文 */ }
const jsBlocks = extractJsToolBlocks(workRaw);
```

**一个改动解决两个问题**：

- 围栏 `lingya` 还原成 `lingya` → `js-detector` 能识别
- 代码块内的工具函数名 `edit` 还原成 `edit` → JsRunner 执行不报错

**为什么不改 js-detector 让它认占位符**：占位符名由规则表决定，用户可以改成任意名字。让 js-detector 去猜「哪个占位符代表 lingya」不可维护。正确的做法是「检测前先还原」，让 js-detector 只处理真词。

**为什么不整体 unredact 后直接覆盖 raw**：`judgeUserWait(raw)` 和 `DONE_HINT_RE.test(raw)` 这些语义判断用原 raw 更准确（占位符版本可能让提问判定正则误判）。只让代码块检测用 workRaw。

### 修复 2：加载规则时警告「含工具关键名的词」

`redaction-store.js` 的 `ensureLoaded` 里加 `warnToolNameRules()`，加载完成后检查规则表是否含以下 22 个关键名：

```
lingya / read / readLines / write / edit / glob / grep / bash / pwsh
todoWrite / deleteFile / webFetch / webSearch / viewImage / mysql
nameConversation / purge / bashBackground / bashOutput / bashKill
injectJs / mcpCall
```

命中则打三条 `console.warn`，说明「这些词被脱敏后 js-detector 识别不到代码块，JsRunner 报 not defined」，并提示用户去面板删规则。

**不阻止，只警告**：用户可能是有意脱敏这些词（比如真有个项目叫 `read`）。阻止等于违背需求。但至少要让人知道风险。

## Alternatives considered

**改 `js-detector` 的 `JS_TOOL_CALL_RE` 让它同时认占位符** —— 落选原因：占位符名由用户规则表决定，千变万化。今天叫 `lingya`，明天可能叫 `⟦围栏⟧`。让检测器去猜「哪个占位符代表 lingya」不可维护。

**整体 unredact 后覆盖 raw，后续所有逻辑都用还原版** —— 落选原因：`judgeUserWait` 和 `DONE_HINT_RE` 这些语义判断用原 raw 更准。占位符版本会让「AI 在向用户提问」的正则误判（比如占位符名本身含问号类字符）。

**在出站脱敏时跳过代码块围栏** —— 落选原因：出站脱敏是 preload 的 `redactText` 做的，它不知道文本里哪部分是代码块围栏、哪部分是正文。要做需要引入 Markdown 解析，改动面太大。而且这不解决「代码块内工具函数名被脱敏」的问题。

**规则表里发现工具关键名就自动删除** —— 落选原因：用户可能有意加的。自动删除是越权操作。改为警告，把决策权留给用户。

**只在 `js-detector` 里加 unredact** —— 落选原因：`extractJsToolBlocks` 是纯函数，不依赖 electron / redaction-filter。在纯函数里引入 `require('./redaction-filter')` 会破坏它的可测性（测试环境没有 electron）。放在调用点（`processInterceptedResponse`）更合适。

## Consequences

**收益**：

- **修复「任务提前结束」**：脱敏后的代码块围栏能被识别，工具调用不再被当成纯文本
- **修复「工具函数名未定义」**：代码块内的工具名被还原，JsRunner 执行正常
- **端到端验证通过**：修复前识别 0 个代码块，修复后识别 1 个，内容是 `await read("a.txt")`
- **警告机制生效**：当前规则表命中 8 条，加载时输出醒目警告
- **全量测试 1298/1298 零失败**
- 相关测试 27/27 通过（js-detector + tool-parser）

**代价**：

- 每次 AI 回复多一次 `unredactText` 调用。210 条规则字符串替换，实测 < 2ms，可忽略
- 警告只在首次加载时打一次（用 `_warnToolNamesOnce` 守卫），后续刷新规则不重复刷屏。这意味着用户刷新规则后如果新加了危险词，不会立即看到警告——需要重启才看到。**这是有意的**，避免每次刷新都刷屏
- 不阻止危险词进规则表。用户如果坚持加 `read`，工具还是会失效。但至少有警告

## 备注

- 修复 1：`src/preload/dom/intercept-observer.js` 的 `processInterceptedResponse`（约 389 行，`extractJsToolBlocks` 调用之前）
- 修复 2：`src/main/redaction-store.js` 的 `ensureLoaded`（新增 `warnToolNameRules` 内嵌函数）
- 检测逻辑：`src/preload/dom/js-detector.js` 的 `extractJsToolBlocks`（未改，只改调用方）
- 备份：两个文件的 `.bak-fence-fix-20261105`
- 全量测试：1298 / 1298 通过
