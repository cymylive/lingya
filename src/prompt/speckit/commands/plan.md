# plan — 写「怎么做」

输入：`spec.md` + `.specify/memory/constitution.md`。输出：`plan.md`。

## 执行步骤

1. **读宪法**：`.specify/memory/constitution.md`，逐条列出核心原则
2. **技术选型**：每个选型给理由，说明为什么不选替代方案
3. **架构设计**：数据模型、接口契约、状态流转、错误处理
4. **文件改动清单**：每个文件改什么、为什么改
5. **测试策略**：单测覆盖哪些场景、集成测试怎么跑、验收标准如何映射到测试
6. **Constitution Check**：逐条对照宪法，说明本方案如何满足；违反的必须写理由或改方案

## plan.md 必须含的章节

- Technical Context（技术上下文）
- Constitution Check（宪法合规检查，**不可省略**）
- Architecture & Data Model（架构与数据模型）
- API Contracts（接口契约，如有）
- File Changes（文件改动清单）
- Test Strategy（测试策略）
- Risks & Mitigations（风险与缓解）

## 硬约束

- 每个技术决策必须能追溯到 spec 中的具体需求
- Constitution Check 有违规项且无正当理由 → 停下来改方案，不得继续
- 禁止「以后再优化」式的含糊表述，要么写清怎么做，要么明确不做
