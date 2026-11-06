# Tasks: [FEATURE NAME]

**Feature**: `[NNN-short-name]` | **Plan**: [link to plan.md]

## Phase 1: Setup

- [ ] T001 [文件路径] — [具体改什么] — 验证：[跑什么测试/看什么现象]

## Phase 2: Tests (TDD 先写)

- [ ] T002 [P] [测试文件] — [写什么测试] — 验证：测试失败（Red）
- [ ] T003 [P] [测试文件] — [写什么测试] — 验证：测试失败（Red）

## Phase 3: Core Implementation

- [ ] T004 [文件路径] — [实现什么] — 验证：T002/T003 转绿

## Phase 4: Integration

- [ ] T005 [文件路径] — [集成什么] — 验证：[集成测试]

## Phase 5: Polish

- [ ] T006 全量测试 — 验证：`[测试命令]` 全绿
- [ ] T007 宪法合规复查 — 验证：Constitution Check 无未解释违规

## Dependencies

- T002, T003 可并行 [P]
- T004 依赖 T002, T003

## 说明

- `[P]` = 可与同阶段其他 [P] 任务并行
- 每个任务完成后把 `[ ]` 改为 `[x]`，并在行尾追加 `— ✅ 验证通过`
