# implement — 执行

输入：已批准的 `tasks.md`。输出：完成的任务 + 更新的 tasks.md。

## 执行步骤

1. **逐项执行**：按 tasks.md 顺序，一次一个任务
2. **每完成一项立即验证**：跑该任务标注的验证方式（测试/构建/手动检查）
3. **更新 tasks.md**：把 `- [ ]` 改为 `- [x]`，记录验证结果
4. **发现 tasks.md 有错 → 停下来改 tasks.md**，重新请用户批准，不得私自改道
5. **全部完成后逐条核对**：
   - spec 的验收标准全部满足
   - 所有测试绿
   - 宪法合规（Constitution Check 无未解释的违规）
   - tasks.md 全部闭合
   - 无顺手改的无关代码

## 方法论手册（按需查阅）

系统提示词末尾的「方法论手册索引」列出了可用的 SKILL.md 路径。按阶段查阅：

| implement 阶段 | 推荐查阅 |
|---|---|
| 写任何功能代码前 | `test-driven-development` — 先写测试确认失败（Red），再写最小实现（Green） |
| 遇到 bug / 测试失败 / 行为异常 | `systematic-debugging` — 先找根因再修，症状修复算失败 |
| 需要拆解复杂方案时 | `writing-plans` — 计划文档的写法规范 |
| 声称完成前 | `verification-before-completion` — 验证清单，没验证不算完成 |
| 请求/接收代码审查 | `requesting-code-review` / `receiving-code-review` |
| 结束开发分支 | `finishing-a-development-branch` |

**读法**：用 Read 工具传索引里的绝对路径，读全文后按其中指令执行。

## 硬约束

- 禁止跳过验证直接标完成
- 禁止一次性做完所有任务才验证
- 禁止在 implement 阶段擅自扩大改动范围（发现需要扩大 → 回 plan 改方案重新批准）
