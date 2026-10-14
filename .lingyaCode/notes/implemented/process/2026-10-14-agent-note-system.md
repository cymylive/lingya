# Agent Note: 移植 dsh Agent Note 架构决策笔记体系

Status: implemented

## Problem

LingYa 有过多次反复返工的教训：同一类问题（如 Proxied webContents 定位、junction 删除误伤）在几个月内重复踩坑。根本原因是**改动前没有把决策与取舍写下来**——决策依据只存在于某次对话里，无法追溯，也无法阻止后来者删掉看似多余的代码。

DeepSeek Harness（dsh）用一套 `{lifecycle}/{class}/日期-标题.md` 的 Agent Note 体系解决了这个问题：每次非平凡改动都留一份带「Problem / Decision / Alternatives / Consequences」的笔记，并由门禁强制格式。

## Decision

在 LingYa 建立同款笔记体系：

- 目录：`.lingyaCode/notes/{proposed,implemented,rejected}/{feature,bug-fix,simplification,architecture,process,testing}/`
- 格式：前三行固定头部块（`# Agent Note: <title>` / 空行 / `Status: <status>`），正文以 `## Problem` 开头，`## Alternatives considered` 为必需章节
- 校验：`scripts/check-notes.js`（纯 Node，无依赖），校验生命周期与状态一致、类别封闭、必需章节、文件名格式、implemented 禁提案用语
- 挂载：`npm test` 前不强制执行（避免打断开发），但提供独立命令 `npm run check:notes`

## Alternatives considered

**直接照搬 dsh 的 verify-agent-note-format.ts** —— 落选原因：dsh 是 TypeScript，依赖它的类型系统与 tsx 运行时。LingYa 是 CommonJS 单包、无构建，引入 TS 工具链会破坏「零构建」特性。改用纯 Node 重写核心校验逻辑。

**只写文档约定，不做校验** —— 落选原因：没有门禁的约定等于没有约定。LingYa 历史上多次出现「说好的规范没人执行」。校验脚本是这套体系能活下来的关键。

**引入完整的中英双语配对（dsh 的 .zh.md 机制）** —— 落选原因：LingYa 是单开发者项目，双语配对成本高、收益低。仅保留中文笔记。

## Consequences

**收益**：
- 决策可追溯，半年后有人想删某段代码时有依据
- 强制写下「否决了什么」，减少反复争论
- 门禁自动化，规范不靠自觉

**代价**：
- 每次非平凡改动多花几分钟写笔记
- 笔记需要与代码同步维护（实现后要更新 Decision 章节）

## 备注

本笔记是笔记体系的自举示例（用自己记录自己的建立）。
