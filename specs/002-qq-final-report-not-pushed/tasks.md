# Tasks: QQ/微信/飞书 最终报告丢失修复

**Branch**: 002-qq-final-report-not-pushed
**Input**: plan.md, spec.md

## Phase 1: 测试先行（Red）

### Task 1.1 新建判定函数测试

**Files**: test/preload/tool-block-judge.test.js（新建）

**内容**：对 hasToolBlocks(text) 断言 7 个场景
1. 纯文本 → false
2. 只有 lingya 块 → true
3. 纯文本 + js 示例块（无 await 工具调用）→ false
4. 纯文本 + javascript 示例块（无工具调用）→ false
5. 纯文本 + python 块 → false
6. lingya 块 + js 示例块混合 → true
7. 空字符串 → false

**验收**：node --test test/preload/tool-block-judge.test.js → 失败（hasToolBlocks 未定义）

---

### Task 1.2 新建 bridge 集成测试

**Files**: test/preload/bridge-hastool-unified.test.js（新建）

**内容**：读三个 bridge 源码，断言
1. qq-bridge.js 含 require 的 hasToolBlocks，不含旧正则 (?:lingya|javascript|js)
2. weixin-bridge.js 同上
3. feishu-bridge.js 同上

**验收**：node --test test/preload/bridge-hastool-unified.test.js → 失败

---

## Phase 2: 实现（Green）

### Task 2.1 在 js-detector.js 新增 hasToolBlocks

**Files**: src/preload/dom/js-detector.js（修改）

**改动**：
- 新增函数 hasToolBlocks(text) { return extractJsToolBlocks(text).length > 0; }
- 加入 module.exports

**验收**：node --test test/preload/tool-block-judge.test.js → 全绿

---

### Task 2.2 qq-bridge.js 改用 hasToolBlocks

**Files**: src/preload/dom/qq-bridge.js（修改第 88 行）

**改动**：
- 顶部 require 增加 hasToolBlocks
- 第 88 行 const hasTool = /.../.test(text) → const hasTool = hasToolBlocks(text)

**验收**：bridge 集成测试 qq 部分通过

---

### Task 2.3 weixin-bridge.js 改用 hasToolBlocks

**Files**: src/preload/dom/weixin-bridge.js（修改第 84 行）

**改动**：同 2.2

**验收**：bridge 集成测试 weixin 部分通过

---

### Task 2.4 feishu-bridge.js 改用 hasToolBlocks

**Files**: src/preload/dom/feishu-bridge.js（修改第 84 行）

**改动**：同 2.2

**验收**：bridge 集成测试 feishu 部分通过

---

## Phase 3: 回归与验证

### Task 3.1 语法检查

**命令**：
node --check src/preload/dom/js-detector.js
node --check src/preload/dom/qq-bridge.js
node --check src/preload/dom/weixin-bridge.js
node --check src/preload/dom/feishu-bridge.js

**验收**：四条命令均无输出

---

### Task 3.2 全量测试

**命令**：node --test test/

**验收**：fail 0。基准 1110，新增约 10 条 → 预期 1120+

**若失败**：检查 test/preload/qq-bridge-enabled.test.js 是否断言旧正则，若是则更新断言（属修复范畴，需在 commit message 说明）

---

### Task 3.3 提交

**命令**：
git add src/preload/dom/js-detector.js src/preload/dom/qq-bridge.js src/preload/dom/weixin-bridge.js src/preload/dom/feishu-bridge.js test/preload/tool-block-judge.test.js test/preload/bridge-hastool-unified.test.js specs/002-qq-final-report-not-pushed/

git commit -m "fix: QQ/微信/飞书最终报告丢失 — hasTool 判定与执行层对齐"

---

## Phase 4: 手动验证（需用户操作）

### Task 4.1 QQ 端到端验证

1. 通过 QQ 发一条会产出代码示例的任务（例如「写个 Python 快排并解释」）
2. 观察 QQ 是否收到含最终报告的 task-done 推送
3. 对比修复前（报告丢失）与修复后（报告送达）

**验收**：QQ 收到完整最终报告

---

## 依赖关系

- Task 1.1 → 2.1（测试先行）
- Task 1.2 → 2.2 / 2.3 / 2.4（可并行）
- 2.1 → 2.2 / 2.3 / 2.4（共享函数必须先存在）
- 全部 → 3.1 → 3.2 → 3.3 → 4.1

## 并行机会

- 2.2 / 2.3 / 2.4 三个 bridge 改动互不依赖，可并行
- 1.1 / 1.2 两个测试文件可并行编写

## 文件清单（共 7 个）

修改（4）：
- src/preload/dom/js-detector.js
- src/preload/dom/qq-bridge.js
- src/preload/dom/weixin-bridge.js
- src/preload/dom/feishu-bridge.js

新建（2）：
- test/preload/tool-block-judge.test.js
- test/preload/bridge-hastool-unified.test.js

文档（3，已在 spec 阶段创建）：
- specs/002-qq-final-report-not-pushed/spec.md
- specs/002-qq-final-report-not-pushed/plan.md
- specs/002-qq-final-report-not-pushed/tasks.md
