# Feature Specification: QQ/微信/飞书 最终报告丢失修复

**Feature Branch**: 002-qq-final-report-not-pushed

**Created**: 2026-11-04

**Status**: Draft（待批准）

**Input**: 用户反馈 —— LingYa 0.6.182 在 QQ 机器人上，任务最后一步完成后 AI 输出的最终报告不回传；中间过程消息正常。微信同构代码存在同样缺陷。飞书代码相同。

## 根因（已定位，有代码证据）

执行层与上报层判定标准不一致：

| 层 | 文件 | 判定逻辑 |
|---|---|---|
| 执行层 | src/preload/dom/js-detector.js:60-113（extractJsToolBlocks） | lingya 块一律执行；js/javascript 块仅当「整条回复只有代码块」且「含 await 已知工具名( 调用」才执行 |
| 上报层 | qq-bridge.js:88 / weixin-bridge.js:84 / feishu-bridge.js:84 | 正则 /(三反引号)(?:lingya|javascript|js)/i —— 只要出现代码块就判 hasTool=true |

触发路径：AI 输出最终报告时，正文若带任何 js/javascript 代码示例（哪怕不调用工具），上报层判 hasTool=true → 不发 task-done → qq-ipc.js:310-312 规定 ai-reply 不推送 → 最终报告丢失。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 最终报告必须送达 QQ (Priority: P1)

用户通过 QQ 下达任务，AI 执行多步工具调用后输出最终报告（可能含代码示例、总结、结论）。用户必须在 QQ 中收到这条最终报告。

**Why this priority**: 这是本次 bug 的核心。最终报告是任务的产出，丢失等于任务白做。

**Independent Test**: 构造一条 AI 最终回复，正文包含 js 示例代码块但不含任何工具调用 → 观察 QQ 是否收到完整报告。

**Acceptance Scenarios**:

1. **Given** AI 最终回复含纯文本 + 一个 js 示例代码块（无 await 工具名( 调用），**When** 触发上报，**Then** QQ 收到 task-done 推送，正文完整。
2. **Given** AI 最终回复含纯文本 + 一个 javascript 示例代码块（无工具调用），**When** 上报，**Then** 同上。
3. **Given** AI 最终回复只含纯文本（无任何代码块），**When** 上报，**Then** QQ 收到 task-done，行为与当前一致。
4. **Given** AI 回复含真实 lingya 工具调用块，**When** 上报，**Then** 不发 task-done（等待工具执行后的下一轮），行为与当前一致。

---

### User Story 2 - 最终报告必须送达微信 (Priority: P1)

与 Story 1 相同场景，作用于微信 iLink 通道。weixin-bridge.js 与 qq-bridge.js 代码同构，同一 bug 同时影响两个通道。

**Independent Test**: 同 Story 1，观察微信是否收到最终报告。

**Acceptance Scenarios**:

1. **Given** 微信通道已启用，AI 最终回复含非工具代码块，**When** 上报，**Then** 微信收到 task-done 推送。

---

### User Story 3 - 最终报告必须送达飞书 (Priority: P2)

与 Story 1 相同场景，作用于飞书通道。feishu-bridge.js:84 存在完全相同的正则。用户本次只报告 QQ，但同一 bug 应一并修复。

**Independent Test**: 同 Story 1，观察飞书是否收到最终报告。

**Acceptance Scenarios**:

1. **Given** 飞书通道已启用，AI 最终回复含非工具代码块，**When** 上报，**Then** 飞书收到 task-done 推送。

---

### User Story 4 - 工具执行失败时最终报告仍须送达 (Priority: P2)

如果某轮 AI 回复确有工具调用块，但工具执行失败（语法错误、超时），AI 随后输出的「失败说明 + 结论」必须送达。

**Why this priority**: 工具失败时用户更需要看到结果说明。

**Independent Test**: 构造含真实 lingya 块的回复 → 模拟工具执行失败 → AI 输出失败说明 → 观察是否推送。

**Acceptance Scenarios**:

1. **Given** AI 输出含工具块的回复，工具执行失败，AI 随后输出失败说明文本，**When** 该说明触发上报，**Then** 三个通道均收到推送。

---

### Edge Cases

- AI 最终回复同时含 lingya 块和普通 js 示例块 → 按「有真实工具调用」处理，不发 task-done（等待下一轮）
- 代码块语言标记为 python / bash / json 等非 JS 类 → 不触发 hasTool，正常发 task-done
- AI 最终回复为空字符串（只有 thinking）→ 保持现状（主进程判断是否推送）
- AI 回复被中断（interrupted=true）→ 保持现状（intercept-observer.js:432-452 已提前 return，不上报）
- 用户中途 /stop → 保持现状
- 同一轮多段流式回复 → 只在最后一段完成时上报，不重复推送

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: qq-bridge.js 的 hasTool 判定 MUST 与 js-detector.js 的 extractJsToolBlocks 判定保持一致。
- **FR-002**: weixin-bridge.js 的 hasTool 判定 MUST 与 extractJsToolBlocks 保持一致。
- **FR-003**: feishu-bridge.js 的 hasTool 判定 MUST 与 extractJsToolBlocks 保持一致。
- **FR-004**: 判定规则 MUST 满足：lingya 块 → hasTool=true；js/javascript 块 → 仅当「整条回复只含代码块」且「含 await 已知工具名( 调用」时 hasTool=true；其他语言块 → hasTool=false。
- **FR-005**: hasTool=false 时 MUST 发 task-done；hasTool=true 时 MUST 不发。
- **FR-006**: 判定逻辑 MUST 在三个 bridge 文件中保持一致，禁止各自实现不同版本。
- **FR-007**: 判定逻辑 MUST 有单元测试覆盖：纯文本 / lingya 块 / js 示例块 / javascript 示例块 / 其他语言块 / 混合块 / 空回复。
- **FR-008**: 现有 stripToolBlocks 行为 MUST 保持不变（剥离代码块用于 QQ 文本展示）。

### Key Entities

- **hasTool 判定**：布尔值，决定是否发 task-done。当前为粗匹配正则，需改为与执行层一致。
- **extractJsToolBlocks**：已有函数（js-detector.js:60-113），返回实际会被执行的代码块数组。
- **task-done 事件**：三个 bridge 上报给主进程的最终推送事件。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 构造「纯文本 + 无工具调用的 js 代码块」回复，三个通道 100% 收到 task-done 推送。
- **SC-002**: 构造「含真实 lingya 工具调用块」回复，三个通道 100% 不发 task-done（保持现状）。
- **SC-003**: 现有测试全绿（当前基准 1110 用例），新增用例覆盖 FR-007 的 7 个场景 × 3 个通道。
- **SC-004**: 三个 bridge 文件的 hasTool 判定必须调用同一个共享函数，不允许重复正则。
- **SC-005**: stripToolBlocks 输出与改动前逐字节一致。

## Assumptions

- 修复采用外科手术式：只改 hasTool 判定，不动 round-collector / qq-ipc.js / weixin-ipc.js / feishu-ipc.js 的推送逻辑。
- 复用 js-detector.js 已有的 extractJsToolBlocks 作为判定依据，不新增判定算法。
- 三个 bridge 文件抽出一个共享判定函数（建议放在 js-detector.js 导出 hasToolBlocks(text)），三处 require 同一份。
- 不改变 ai-reply 事件本身的行为（仍然不推送）。
- 不改变 task-done 的推送内容格式。
- 微信/飞书通道当前是否启用不影响本次修复（逻辑修复与通道开关无关）。
