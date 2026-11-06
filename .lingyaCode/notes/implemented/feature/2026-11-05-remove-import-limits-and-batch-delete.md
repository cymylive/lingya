# Agent Note: 取消脱敏规则导入限制 + 批量删除功能

Status: implemented

## Problem

用户提出两个需求：

1. **取消脱敏规则的所有导入限制**。原 `checkWordSafe()` 会拒绝两类词：
   - `DANGEROUS_WORDS` 里的 80+ 个代码通用词（`const` / `js` / `read` / `title` 等）
   - 长度 ≤ 2 的词
   用户实测需要脱敏 `const` 这类词（配合 0.6.195 的入站还原，工具调用不受影响），但被硬拒绝。

2. **加批量删除功能**。原面板只有「单条删除」和「删所有 auto 规则」，缺「勾选多条一次删」。

## Decision

### 一、取消所有导入限制

`redaction-store.js` 的 `checkWordSafe()` 改为永远返回 `null`（保留函数签名，避免 `addRule` / `importRules` 两个调用点报错）。

原实现的两条护栏全部放行：
- `DANGEROUS_WORDS.has(lower)` 检查删除
- `w.length <= 2` 检查删除

保留 `COMMON_WORDS` / `DANGEROUS_WORDS` 两个常量定义（供测试或其他模块引用），只是不再用于拦截。

**副作用警告写进代码注释**：加 `js` 进规则表会让 `*.js` 路径全变占位符，`glob`/`grep` 全废；加 `read`/`write` 会让工具函数名被脱敏，代码块里的 `await read(...)` 失效。如果真遇到工具失效，去面板删掉对应规则。

### 二、批量删除

**store 层**（`redaction-store.js`）：

- 新增 `backupBeforeDestructive(tag)`：删除前把规则表复制到 `<path>.bak-<tag>-<时间戳>`，误删可从文件恢复。备份失败不阻断删除，只 `console.warn`。
- 新增 `deleteRules(names)`：按 name 数组批量删除，返回 `{ deleted, remaining }`。
- 新增 `deleteAllRules()`：清空全部规则，返回 `{ deleted }`。
- `deleteRule` / `deleteAllAutoRules` 也加了备份调用。
- `module.exports` 加三个新函数。

**IPC 层**（`ipc.js`）：

- `redaction-rules-delete-batch`：接收 `{ names }`，调 `deleteRules`。
- `redaction-rules-delete-all`：无参，调 `deleteAllRules`。

**API 层**（`api.js` + `shell-preload.js`）：

- `redactionRulesDeleteBatch(names)`
- `redactionRulesDeleteAll()`

**面板 UI**（`shell-renderer.js`，脱敏面板在 2657-2701 行的 HTML 模板 + 3207-3422 行的 JS 逻辑）：

- HTML 工具栏加一行：全选复选框 + 「删除选中(N)」按钮（初始 disabled）+ 「删除全部规则」按钮（红色）
- `renderList` 每行左侧加复选框 `<input type="checkbox" class="sh-red-cb" data-red-name="...">`
- `renderList` 渲染完后绑定：
  - 每个复选框的 `change` 事件 → 更新「删除选中(N)」的计数和 disabled 状态
  - 全选框的 `change` 事件 → 勾选/取消所有（用 `cloneNode` 替换节点避免重复绑定）
  - 全选框的 checked 状态随选中数量自动同步
- 删除选中：确认弹窗显示前 10 个名字，调 `redactionRulesDeleteBatch`
- 删除全部：二次确认（文案强调会清空 manual + auto），调 `redactionRulesDeleteAll`
- 删除后调 `loadList()` 刷新 + `setSetting('redaction-refresh', Date.now())` 通知 preload 刷新缓存

### 三、测试改写

`test/main/redaction-store.test.js` 有 5 个测试断言「拒绝」，与新行为冲突：

- `addRule 拒绝代码通用词 js`
- `addRule 拒绝 JS 关键字 await`
- `addRule 拒绝工具函数名 read`
- `addRule 拒绝过短词（<=2 字符）`
- `importRules 拒绝含危险词的导入文件`

全部改写为断言「放行」：调 `addRule` / `importRules` 后验证返回非空、`words` 里含目标词。

## Alternatives considered

**只取消 `DANGEROUS_WORDS`，保留长度 ≥ 3** —— 落选原因：用户明确要求「不要做任何限制」，包括 2 字符词。虽然 2 字符词误伤面大（`ab` 命中 `above` / `table` / `abs`），但这是用户的显式选择，加护栏等于违背需求。

**保留 `checkWordSafe` 但改为返回 warning 而非 error** —— 落选原因：需要改 `addRule` / `importRules` 的调用方式（从 throw 改为收集 warning 再返回），改动面大。而且用户要的是「不限制」，warning 仍然会让用户犹豫。

**批量删除做成「删除所有 visible 规则」而非「勾选删除」** —— 落选原因：用户明确要「批量删除添加的规则」，勾选式更精确，能保留不想删的规则。

**批量删除不备份** —— 落选原因：删规则是不可逆操作，误删会导致工具大面积失效。备份成本极低（一次文件复制），收益是误删可恢复。

**用 `innerHTML` 重建整个列表来绑定复选框** —— 落选原因：会丢失用户已勾选的状态。改用 `querySelectorAll` 逐个绑定 `change` 事件，全选框用 `cloneNode` 替换避免重复绑定。

## Consequences

**收益**：

- 用户可以导入任何词，包括 `const` / `js` / `read` / 2 字符词
- 面板支持勾选多条批量删除，删除前自动备份到 `.bak-<tag>-<时间戳>`
- 新增「删除全部规则」按钮，一次清空
- 全量测试 **1298 / 1298 通过，零失败**（项目首次全量零失败，之前那个「导出→导入往返」失败也因限制取消而自然修复）
- 原 5 个「拒绝」测试改写为「放行」测试，19/19 通过

**代价**：

- 用户如果加了 `js` / `read` 这类词，工具会立刻大面积失效。代码注释已写警告，但用户可能不看
- 2 字符词误伤面大，加进去后面板列表会很长，出站替换结果会很「花」
- 每次删除操作都会产生一个 `.bak-*` 文件，频繁删除会累积。目前没有自动清理机制

## 备注

- 限制取消：`src/main/redaction-store.js` 的 `checkWordSafe`（约 171 行）
- 备份函数：`src/main/redaction-store.js` 的 `backupBeforeDestructive`（新增，约 251 行前）
- 批量删除：`src/main/redaction-store.js` 的 `deleteRules` / `deleteAllRules`
- IPC：`src/main/ipc.js` 的 `redaction-rules-delete-batch` / `redaction-rules-delete-all`
- API：`src/preload/api.js` + `src/preload/shell-preload.js`
- 面板 HTML：`src/preload/shell-renderer.js` 约 2665-2705 行
- 面板 JS：`src/preload/shell-renderer.js` 约 3213-3490 行
- 测试：`test/main/redaction-store.test.js` 的 111-138 段
- 备份：5 个文件的 `.bak-batchdel-20261105`
