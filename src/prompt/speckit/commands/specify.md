# specify — 写「做什么」

输入：用户的需求描述。输出：`specs/NNN-short-name/spec.md`。

## 执行步骤

1. **扫描** `specs/` 目录，确定下一个编号（NNN，三位递增，超出自动扩位）
2. **生成短名**：2-4 个词，action-noun 格式（如 `add-user-auth` / `fix-payment-timeout`），保留技术术语
3. **创建目录** `specs/NNN-short-name/`
4. **写 spec.md**，严格按模板结构：
   - 用户故事（按优先级 P1/P2/P3，每个带 Why 和独立验收标准）
   - 功能需求（编号 FR-001、FR-002……，可测试的陈述句）
   - 非功能需求（性能、安全、兼容性）
   - 明确不做的范围（Out of Scope）
   - 待澄清项（Clarifications，需要用户回答的）
5. **更新** `.specify/feature.json` 为 `{"feature_directory":"specs/NNN-short-name"}`

## 硬约束

- **禁止写实现细节**：不写技术选型、不写代码、不写文件路径、不写函数名
- **验收标准必须可测**：能写成一条测试用例，或能明确观察到现象
- **用户故事必须独立可交付**：P1 单独上线也有价值
- 一个 specify 只创建一个 feature
