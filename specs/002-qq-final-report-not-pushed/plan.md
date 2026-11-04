# Implementation Plan: QQ/微信/飞书 最终报告丢失修复

**Branch**: 002-qq-final-report-not-pushed | **Date**: 2026-11-04 | **Spec**: specs/002-qq-final-report-not-pushed/spec.md

## Summary

三个 IM bridge（QQ/微信/飞书）的 hasTool 判定用粗正则 /(三反引号)(?:lingya|javascript|js)/i，与执行层 extractJsToolBlocks 的精确判定不一致。导致含 js 示例代码的最终报告被误判为「还要调工具」，不发 task-done，报告丢失。

修复：在 js-detector.js 新增 hasToolBlocks(text)，复用 extractJsToolBlocks 的返回值，三个 bridge 改为调用它。

## Technical Context

- **Language/Version**: JavaScript (CommonJS), Node 22 / Electron 33
- **Primary Dependencies**: 无新增
- **Testing**: node --test，当前基准 1110 用例
- **Target Platform**: Electron 33 preload 层
- **Project Type**: 单项目（Electron 应用）
- **Constraints**: 禁止新增依赖；preload 不得 require 常规 Node 模块（js-detector 已在 preload/dom 内，合规）
- **Scale/Scope**: 1 个新函数 + 3 处调用替换 + 1 个测试文件

## Constitution Check

| 原则 | 符合性 | 说明 |
|---|---|---|
| I. 外科手术式修改 | ✅ | 只新增 1 个函数、改 3 行调用，不动 IPC / round-collector / 推送格式 |
| II. 先思考后编码 | ✅ | 已完成 spec + clarify，根因有代码证据 |
| III. 验证闭环与 TDD | ✅ | tasks 强制先写测试（Red）再实现（Green），最后全量 npm test |
| IV. 架构分层与沙箱安全 | ✅ | 改动全在 preload/dom 内，不跨层，不引入 Node 模块 |
| V. 零 Token 与扩展性 | ✅ | 无网络调用、无新依赖、纯函数 |

**结论**：全部符合，无偏离需要说明。

## Project Structure

### Documentation
specs/002-qq-final-report-not-pushed/
├── spec.md      (已完成)
├── plan.md      (本文件)
└── tasks.md     (待生成)

### Source Code
src/preload/dom/
├── js-detector.js   ← 新增 hasToolBlocks(text) + 导出
├── qq-bridge.js     ← 第 88 行改为调用 hasToolBlocks
├── weixin-bridge.js ← 第 84 行改为调用 hasToolBlocks
└── feishu-bridge.js ← 第 84 行改为调用 hasToolBlocks

test/preload/
└── tool-block-judge.test.js  ← 新建，7 场景 × 3 通道

## 设计决策

### 为什么复用 extractJsToolBlocks 而不是新写判定

执行层已经有一套经过验证的规则：
- lingya 块 → 一律执行
- js/javascript 块 → 仅当整条回复只含代码块 且 含 await 已知工具名( 调用 → 执行
- 其他语言 → 不执行

上报层要回答的问题恰好是「执行层会不会执行」。复用同一个函数，天然保证一致，零漂移风险。

### hasToolBlocks 的实现

function hasToolBlocks(text) {
  return extractJsToolBlocks(text).length > 0;
}

一行，无新算法，无新正则。

### 行为变化对照

| AI 回复内容 | 旧判定 | 新判定 | 结果 |
|---|---|---|---|
| 纯文本 | false | false | task-done ✅ 不变 |
| 纯文本 + python 代码块 | false | false | task-done ✅ 不变 |
| 纯文本 + js 示例块（无工具调用） | **true** ❌ | **false** ✅ | **task-done（修复）** |
| 纯文本 + javascript 示例块 | **true** ❌ | **false** ✅ | **task-done（修复）** |
| lingya 工具调用块 | true | true | 不发 ✅ 不变 |
| 只有 js 块 + 含 await write( | true | true | 不发 ✅ 不变 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| extractJsToolBlocks 有副作用 | 它是纯函数（只读 text 参数，无 IO），已确认 |
| hasOnlyFences 依赖整条回复结构，与旧的粗匹配语义差异大 | 这正是修复目标；测试覆盖 7 个场景 |
| 三处改动漏改一处 | tasks 中每处独立可验证，且有共享函数测试 |
| 现有 qq-bridge-enabled.test.js 可能断言旧正则 | 实现前先跑全量测试，若冲突则更新该测试的断言（属修复范畴） |

## 验证策略

1. 新增 tool-block-judge.test.js，7 场景 × 断言 hasToolBlocks 返回值
2. 新增 bridge 集成断言：三个 bridge 源码必须 require hasToolBlocks 且不再含旧正则
3. 跑全量 node --test，基准 1110 + 新增用例全绿
4. 手动验证：QQ 发一条会产出代码示例的任务，确认最终报告送达
