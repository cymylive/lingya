# LingYa Constitution

<!--
Sync Impact Report:
- Version change: 0.0.0 -> 1.0.0 (Initial Adoption)
- Added principles: I. 外科手术式修改; II. 先思考后编码; III. 验证闭环; IV. 架构与安全隔离; V. 零Token与最小依赖
- Added sections: 技术栈与约束, 开发工作流与发布门禁
- Removed sections: None
- Follow-up TODOs: None
-->

## Core Principles

### I. 外科手术式修改 (Surgical Modifications)
修改现有代码时，必须尽可能缩小改动范围。禁止顺手格式化、重构或清理无关代码。每次编辑应有单一、清晰的目标，避免“来都来了”式的连带改动。涉及 UI 的改动，HTML 元素 id 必须保持不变（events.js / ui.js 依赖 getElementById）。禁止过度工程、投机性的泛化或过早优化。

### II. 先思考，后编码 (Think Before Coding)
接到需求后，必须先复述理解或提出澄清性问题，禁止直接建计划或写代码。遇到问题先分诊（L0-L3）：L0微改直接动；L1/L2必须先出计划；L3需隔离工作区。用户提出需求时，若存在歧义，必须提供带编号的选择题供用户决策，而不是开放式追问。

### III. 验证闭环与测试驱动 (Verification and TDD) [NON-NEGOTIABLE]
任何代码修改后必须运行 `npm test`（当前基准为 1110 个用例全绿）。新增功能必须先写测试用例并确认失败（Red），再实现代码（Green）。打包或发版前，必须先向用户申请权限，禁止擅自执行打包命令。

### IV. 架构分层与沙箱安全 (Architecture & Sandbox Security)
主进程与渲染进程必须严格分离。preload 脚本不能直接 require 常规 Node 模块。渲染进程调主进程一律通过 `window.electronAPI`。AI 代码执行必须在受限的 `vm` 沙箱内进行，禁止暴露 `require` / `process`。危险命令（如 `rm -rf` / `format`）必须被拦截。

### V. 零 Token 成本与扩展性 (Zero-Token & Extensibility)
坚持“内嵌 AI 网页版”的架构，严禁直接调用需要消耗 API Token 的模型接口。插件入口使用 ESM (`export function apply(ctx)`)，由 esbuild 打包，但核心代码必须保持 CommonJS 规范。插件不得破坏核心沙箱的执行链。

## 技术栈与约束
- **Electron 版本**：33.x (Chromium 130)
- **Node 环境**：推荐使用 `D:\NodeJS`
- **代码规范**：CommonJS (`require` / `module.exports`)，严禁在前端依赖 NPM 引入巨型库（如 React/Vue），UI 采用原生 DOM 或轻量级模板。
- **测试框架**：Node.js 内置 `node --test`。

## 开发工作流与发布门禁
- **需求评估**：所有新功能需经过 Spec Kit 的 specify -> plan -> tasks 流程。
- **实施门禁**：tasks.md 生成后，必须经用户审批（`speckit_approve`）才能进入 implement 阶段。
- **代码审查**：提交 PR 前，必须自查是否符合本宪法（尤其是测试与架构边界）。
- **发布流程**：本地打包采用 `npm run build:win:nsis:local`，走 GitHub Actions 发版。

## Governance
本宪法具有最高优先级，优先于所有其他文档和默认行为。任何对本宪法的修改都必须记录在 Sync Impact Report 中。所有 PR 和代码审查都必须验证是否符合本宪法。若因业务原因需要偏离原则，必须经过用户明确同意，并在代码注释中标注原因。

**Version**: 1.0.0 | **Ratified**: 2026-11-03 | **Last Amended**: 2026-11-03
