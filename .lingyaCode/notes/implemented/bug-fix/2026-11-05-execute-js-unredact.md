# Agent Note: AI 代码块路径必须做脱敏占位符还原

Status: implemented

## Problem

灵鸦的脱敏系统把真词（`memory` / `const` / `Windows` / `Chrome` 等）替换成占位符（`⟦自动_67⟧` / `⟦自动31⟧` / `⟦自动_15⟧` / `⟦自动_36⟧`）再回传给 AI。AI 看到的是占位符，用它去调工具时，工具收到的是字面占位符字符串——磁盘上不存在名为 `⟦自动_67⟧-store.js` 的文件，`read` 必然失败。

修复前的覆盖情况：

- **`execute-tool` 路径**（AI 用 JSON 格式的 `{"toolName":..., "params":...}` 调用）：`src/main/ipc.js:1143` 已有 `redactionStore.unredactDeep(params)`，参数被正确还原
- **`execute-js` 路径**（AI 用 \`\`\`lingya 代码块写 `await read(...)`）：`tools/JsRunner.js` 的桥接函数**从未调用 unredact**，代码里的占位符原样进入沙箱，工具收到占位符

由于灵鸦的系统提示词引导 AI 优先用 \`\`\`lingya 代码块（而非 JSON 工具调用），**实际使用中几乎全部走 execute-js 路径**——这意味着脱敏还原在真实场景里基本是失效的。症状是 AI 反复猜文件名（`memory-store.js` / `mem-store.js` / `memoryStore.js`），每个都失败，最后改用 glob 或 node 脚本绕行，分析效率极低。

规则表本身没有问题：用户的 `H:\灵鸦数据\灵鸦-脱敏.json` 有 222 条规则，含 `自动_67→memory`、`自动31→const` 等，全部 enabled。`unredactDeep` 实现也正确（单独测试能把 `⟦自动_67⟧` 还原成 charcodes `109,101,109,111,114,121` = `memory`）。缺口只在调用点。

## Decision

**在 `tools/JsRunner.js` 的桥接函数 `__ipc` 里，`JSON.parse(argsJson)` 之后、plan-gate 之前，调用 `redactionStore.unredactDeep(args)`。**

具体位置：`JsRunner.run()` 内定义的 `__ipc = async (op, argsJson) => {...}`，第 463-468 行解析 `args` 之后插入：

```js
try {
  const rs = require('../src/main/redaction-store');
  if (rs && typeof rs.unredactDeep === 'function') {
    args = rs.unredactDeep(args);
  }
} catch (_) { /* 脱敏模块不可用时保持原参数，不阻断执行 */ }
```

放在 plan-gate **之前**是有意的：计划门禁也要看到真词才能正确判断「这次写操作是否已建计划」。放在工具执行**之前**是必须的：工具拿到占位符就没法工作。

选择这个位置而非「整段代码 unredact」的原因：

- AI 的代码里可能有字符串字面量、注释、正则表达式也含占位符。整段 unredact 会把这些也改掉：`write("a.txt", "⟦自动_67⟧ 是占位符说明")` 会变成写 `"memory 是占位符说明"`，`/⟦自动_67⟧/g` 正则会变成 `/memory/g`
- 在桥接层只还原「工具实际收到的参数」，代码文本原样保留，语义精确

## Alternatives considered

**在 `execute-js` handler 里对整段代码做 unredact** —— 落选原因：会破坏代码里的字符串字面量、注释和正则。AI 写 `const re = /⟦自动_67⟧/g` 会变成 `/memory/g`，语义错误；写 `write("doc.md", "占位符 ⟦自动_67⟧ 表示 memory")` 会把文档内容也改掉。

**在沙箱 BOOTSTRAP 的 `__call` 里做 unredact** —— 落选原因：BOOTSTRAP 是注入沙箱的字符串代码，无法 `require` 主进程模块；且沙箱内不允许访问宿主对象。要做只能再开一条桥接通道，复杂度反而更高。

**在 `execute-tool` 和 `execute-js` 共用的上游做一次 unredact** —— 落选原因：两条路径的入口、参数形态、调用链完全不同（一个是 IPC handler 直传，一个是沙箱桥接回调），没有天然的共同上游。

**让外部脱敏系统主动注册规则到项目层** —— 落选原因：规则已经在项目层了（`H:\灵鸦数据\灵鸦-脱敏.json` 222 条）。问题从来不是规则缺失，而是还原逻辑没挂在 execute-js 路径。这个方向是误诊，已在分析中纠正。

**在 `tools/sandbox.js` 里改** —— 落选原因：项目里没有 `sandbox.js`。沙箱执行器是 `tools/JsRunner.js`，名字差异导致最初定位失败。

## Consequences

**收益**：

- AI 的 \`\`\`lingya 代码块里写 `read("src/main/⟦自动_67⟧-store.js")` 能正确读到 `memory-store.js`，不再需要 glob 绕行或 node 脚本
- `edit` 的 `old_string` 能正确匹配（之前从 read 抄下来的 `⟦自动31⟧` 无法匹配文件里的 `const`）
- `write` 不会把占位符写进文件（之前会写入 `⟦自动31⟧ x = 1;` 造成语法错误）
- 与 `execute-tool` 路径语义一致，两条通道行为统一
- 新增 5 条测试（`test/main/jsrunner-unredact.test.js`）锁定：顶层字符串、数组元素、多键对象值、未知占位符不误伤、无占位符零改动

**代价**：

- `JsRunner.run()` 每次工具调用多一次 `require` + `unredactDeep`。`require` 有缓存，`unredactDeep` 是 222 条字符串替换，实测单次 < 1ms，可忽略
- `unredactDeep` 是幂等的：`execute-tool` 路径已经还原过的参数再还原一次不会变（真词里不含占位符），无双重还原风险
- 沙箱的 `__unwrapOne` 有一条既有规则：单键且值为字符串的对象会被解包。测试用例要注意避开（用多键对象），这是既有行为不是本次引入的
- 本机 git 不可用，回滚依赖 `tools/JsRunner.js.bak-unredact-20261105`

## 备注

- 改动点：`tools/JsRunner.js` 的 `__ipc` 函数，`JSON.parse(argsJson)` 之后
- 被调模块：`src/main/redaction-store.js` 的 `unredactDeep`
- 规则表真实位置：`H:\灵鸦数据\灵鸦-脱敏.json`（222 条，由 `data-location.json` 的 `customDir` 指定，不是 `%APPDATA%`）
- 测试：`test/main/jsrunner-unredact.test.js`（5 条）
- 备份：`tools/JsRunner.js.bak-unredact-20261105`
- 全量测试：1271/1272 通过，唯一失败是 `redaction-store.test.js` 的「导出→导入往返」——那是改造前就存在的问题（2 字符规则与长度校验冲突），与本次无关
