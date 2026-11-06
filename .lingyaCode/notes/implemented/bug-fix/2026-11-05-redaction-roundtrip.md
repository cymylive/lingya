# Agent Note: 脱敏双向闭环补齐——出站全替换 + 入站全还原

Status: implemented

## Problem

灵鸦的脱敏系统由两个方向组成：

- **出站**：工具返回的内容里含真词（`memory` / `const` / `src/` 等），替换成占位符（`⟦自动_67⟧` / `⟦自动31⟧` / `⟦源码目录⟧`）再发给 AI 平台，防止真词泄露
- **入站**：AI 把占位符写进工具参数，还原成真词再交给工具

修复前有四个缺口，导致「替换不彻底、还原不完整」：

1. **出站被 `isProtectedMatch` 挡住**：`redaction-store.js` 的 `isProtectedMatch` 有三条保护——路径分隔符（`/`、`\\`）、扩展名/属性访问（`.`）、ASCII 词边界。前两条导致 `src/main/index.js`、`obj.const`、`a.memory` 这类真实场景里的真词**原样发给 AI 平台**，出站替换形同虚设
2. **`execute-command` 路径没有入站还原**：AI 如果通过命令执行通道传含占位符的命令，不会还原
3. **`sanitize-tool-output.js` 是死代码**：定义了 `sanitizeToolOutput` 但全项目零调用，功能已被 `deepseek-input.js` 的 `redactText` 覆盖，留着误导后来者
4. **3 个旧测试固化了旧行为**：断言「路径/属性位置应跳过替换」，与「全替换」目标冲突

## Decision

**出站：`isProtectedMatch` 只保留第 3 条（ASCII 词边界），删除第 1、2 条（路径分隔符、扩展名/属性访问）。**

实验对比了三版策略（真实 221 条规则）：

| 样本 | A 现状（三条全保） | B 只留词边界 | C 三条全删 |
|---|---|---|---|
| `obj.const` | 0 处替换 | **1 处** | 1 处 |
| `a.memory` | 0 处替换 | **1 处** | 1 处 |
| `src/main/index.js` | 1 处（漏 `index.js`） | **2 处** | 2 处 |
| `json`（含 `js` 规则时） | 0 处 | 0 处 | 会被拆坏 |
| 双向闭环 | — | **全部 OK** | 全部 OK |

选 B 而非 C 的理由：C 删掉词边界后，如果规则表里有 `js` 这类短词，`json` 会被拆成 `⟦xxx⟧on`，虽然理论上能还原但结构被破坏、AI 读代码困惑。B 保留词边界是零成本的安全网（当前 221 条规则里没有被它挡住的词，所以实验里 B 和 C 结果一致）。

**入站：补 `execute-command` 的 `unredactText`。**

在 `ipc.js` 的 `execute-command` handler 里，`normalizeCommand` 之前加 `redactionStore.unredactText(command)`。此前只有 `execute-tool`（`ipc.js:1143`）和 `execute-js`（`JsRunner.js:475`，上一轮已补）两条路径有还原，`execute-command` 是第三条遗漏的入口。

**清理：删除 `sanitize-tool-output.js`。**

确认全项目零 `require`、零 `sanitizeToolOutput` 调用后删除。它的功能（工具输出脱敏）已由 `deepseek-input.js` 的 `sendToolResultToChat` 内部 `redactText` 覆盖。

**测试：更新 3 个固化旧行为的测试。**

- `redactText 不替换文件扩展名位置的真词` → `redactText 在扩展名/属性访问位置也替换`
- `redactText 不替换路径里的词` → `redactText 在路径上下文也替换`
- `isProtectedMatch 基础判定` → `isProtectedMatch 只保留词边界`

每个更新后的测试都加了双向闭环断言（`unredactText(redactText(x)) === x`）。

## Alternatives considered

**保持现状（A 版），靠 `unredactDeep` 单边兜底** —— 落选原因：入站还原只能保证「AI 用占位符操作能成功」，但出站不替换意味着真词（路径、属性名）**仍然原样发给 AI 平台**，脱敏的核心目的（防泄露）没达成。

**三条保护全删（C 版）** —— 落选原因：词边界保护防的是「`js` 拆坏 `json`」这类子串误伤。当前规则表里没有短词，但未来用户新建规则时可能加进来，保留这道防线零成本。

**在 preload 侧 `redactText` 之前做二次过滤** —— 落选原因：`isProtectedMatch` 是唯一的替换判定点，在主进程侧改一处即可，不需要在 preload 侧重复实现。

**保留 `sanitize-tool-output.js` 作为备份** —— 落选原因：死代码会误导后来者以为这是生效路径，且功能重复。删除前已备份为 `.bak-removed-20261105`。

## Consequences

**收益**：

- 出站替换覆盖率提升：`obj.const`、`a.memory`、`src/main/index.js`、`read("src/main/memory-store.js")` 里的真词现在全部被替换
- 三条入站路径（`execute-tool` / `execute-js` / `execute-command`）全部有还原，行为一致
- 双向闭环经端到端验证成立：7/7 样本 `unredactText(redactText(x)) === x`
- 删除 52 行死代码
- 3 个旧测试更新为断言新行为，每个都含闭环断言
- 全量测试 1271/1272 通过，唯一失败是改造前就存在的 `导出→导入往返`（2 字符规则与长度校验冲突）

**代价**：

- **AI 看到的代码更「花」**：`src/main/memory-store.js` 变成 `⟦源码目录⟧main/⟦自动_67⟧-store.js`，`obj.const` 变成 `obj.⟦自动31⟧`。AI 需要脑内翻译，但入站还原保证操作不受影响
- `execute-command` 多一次 `require` + `unredactText`，可忽略
- 删除 `sanitize-tool-output.js` 后，如果有外部代码或插件引用它，会报模块找不到。已确认项目内零引用，但插件侧无法完全排除

## 备注

- 出站判定：`src/main/redaction-store.js` 的 `isProtectedMatch`（310 行附近）
- 入站还原三处：`src/main/ipc.js:1143`（execute-tool）、`tools/JsRunner.js:475`（execute-js）、`src/main/ipc.js` execute-command handler
- 规则表真实位置：`H:\灵鸦数据\灵鸦-脱敏.json`（221 条启用），由 `data-location.json` 的 `customDir` 指定
- 更新后的测试：`test/main/redaction-store.test.js` 的三个上下文保护测试
- 备份：`src/main/redaction-store.js.bak-protect-20261105`、`src/main/ipc.js.bak-cmdunredact-20261105`、`src/preload/dom/sanitize-tool-output.js.bak-removed-20261105`
- 全量测试：1271/1272 通过，唯一失败 `导出→导入往返` 是改造前就有的已知问题
