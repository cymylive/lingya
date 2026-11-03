# Feature Specification: 内置插件删除持久化 + 核心规则导入导出

**Feature Branch**: `001-bundled-plugin-delete-and-rules-io`

**Created**: 2026-11-04

**Status**: Draft（待批准）

**Input**: 用户请求 —— (1) 修复内置插件删除后重启复活的问题，并做 UI 区分（方案 A+B）；(2) 内置「核心规则」插件增加导出/导入规则功能。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 删除内置插件后重启不复活 (Priority: P1)

用户删除任一内置插件（核心规则 / 图谱优先 / 任务守望者），提示"已删除"，重启应用后该插件不再出现。

**Why this priority**: 这是本次 bug 修复的核心价值。当前删除动作本身成功，但每次启动被 seedBundledPlugins 重新播种回来，用户感知为"删不掉"。

**Independent Test**: 删除 core-rules → 完全退出应用 → 重新启动 → 插件面板列表中无 core-rules，AI 工具清单中无该插件贡献的工具。

**Acceptance Scenarios**:

1. **Given** 内置插件已安装且启用，**When** 用户点击删除并在确认框中确认，**Then** 插件目录被移除，列表不再显示该插件。
2. **Given** 用户已删除内置插件，**When** 重启应用，**Then** 该插件不出现在列表，其工具也不出现在 AI 工具清单。
3. **Given** 用户已删除 1 个及以上内置插件，**When** 打开插件面板，**Then** 顶部显示"已删除 N 个内置插件"提示与"恢复"按钮。

---

### User Story 2 - 恢复内置插件 (Priority: P1)

用户点"恢复内置插件"，全部被删除的内置插件重新出现并可正常加载，且原配置（核心规则的规则内容）完整保留。

**Why this priority**: 删除必须可逆，否则用户误删就永久丢失内置能力。这也是方案 A（墓碑）能成立的前提。

**Independent Test**: 删除 core-rules → 点恢复 → 插件列表出现 core-rules → 打开其面板，原有规则条目逐条还在。

**Acceptance Scenarios**:

1. **Given** 已删除 2 个内置插件，**When** 点击"恢复内置插件"，**Then** 两个插件目录被重建、出现在列表、状态为启用。
2. **Given** 核心规则插件曾被删除后恢复，**When** 打开核心规则面板，**Then** 原有规则条目与内容仍在（配置未被删除）。
3. **Given** 没有已删除的内置插件，**When** 打开插件面板，**Then** 不显示恢复入口。

---

### User Story 3 - 内置插件视觉区分 (Priority: P2)

插件面板中内置插件带"内置"角标；删除确认文案明确说明可恢复。

**Why this priority**: 避免用户把内置插件当成普通插件，误以为删除"不可恢复"而不敢操作；也让"恢复"入口有可发现性。

**Independent Test**: 打开插件面板，内置插件卡片上有"内置"标识；点其删除按钮，确认框文案包含"可通过『恢复内置插件』找回"。

**Acceptance Scenarios**:

1. **Given** 插件列表已加载，**When** 查看内置插件卡片，**Then** 卡片上有"内置"标识。
2. **Given** 内置插件，**When** 点击删除按钮，**Then** 确认框说明"该插件为内置插件，删除后可通过插件面板顶部的『恢复内置插件』找回"。
3. **Given** 用户安装的普通插件，**When** 点击删除按钮，**Then** 确认框文案保持原样（"会移除插件目录，不可恢复"）。

---

### User Story 4 - 核心规则导出 (Priority: P1)

核心规则面板增加"导出"按钮，把当前全部规则导出为 JSON 文件。

**Why this priority**: 用户在多台机器/多次重装之间迁移规则；也是删除插件前的备份手段。

**Independent Test**: 面板中有 3 条规则 → 点导出 → 选保存路径 → 生成 JSON 文件，内容含 3 条规则与元数据。

**Acceptance Scenarios**:

1. **Given** 规则列表有 3 条规则，**When** 点"导出"并选择保存路径，**Then** 生成 JSON 文件，包含 plugin/version/exportedAt/rules 四个字段，rules 长度 3。
2. **Given** 规则列表为空，**When** 点"导出"，**Then** 提示"没有可导出的规则"，不生成文件。
3. **Given** 用户在文件对话框中取消，**When** 取消，**Then** 不生成文件、不报错。

---

### User Story 5 - 核心规则导入 (Priority: P1)

核心规则面板增加"导入"按钮，选择 JSON 文件后按 id 合并规则，完成后提示新增/覆盖条数。

**Why this priority**: 与导出配对，构成完整的迁移/备份闭环。

**Independent Test**: 现有 2 条规则 → 导入含"1 条同 id + 1 条新 id"的文件 → 结果为 3 条，同 id 的内容被覆盖。

**Acceptance Scenarios**:

1. **Given** 现有 2 条规则，**When** 导入含 1 条同 id + 1 条新 id 的文件，**Then** 结果为 3 条，同 id 那条内容被覆盖，顺序按合并后重排。
2. **Given** 导入文件的 rules 字段不是数组，**When** 导入，**Then** 提示"文件格式错误"，现有规则不变。
3. **Given** 导入文件 JSON 语法错误，**When** 导入，**Then** 提示"文件格式错误"，现有规则不变。
4. **Given** 导入成功，**When** 重新初始化项目，**Then** 系统提示词中包含导入的规则内容。

---

### Edge Cases

- 内置插件被删除后应用升级、内置插件版本号变大 → 墓碑保留，**不自动复活**；提示条文案说明"有新版本可恢复"。
- 导入的 JSON 顶层是纯数组（用户手工整理）→ 兼容，按 rules 处理。
- 导入的规则缺 id / 缺 name / content 为空 → 走 normalizeRules 归一化，content 为空的条目在注入时被过滤。
- 删除内置插件时该插件正在运行 → 先 unload 再删目录。
- 恢复时应用自带源目录不存在（打包异常/被裁掉）→ 返回明确错误，不清墓碑，避免用户丢失删除意图。
- 删除普通插件 → 行为与现状完全一致（删目录 + 删记录，不留墓碑）。
- 同名目录但 manifest id 不同 → 以 manifest.id 作为墓碑与列表的 key。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 在用户删除内置插件时写入持久化的"已删除"标记（墓碑）。
- **FR-002**: 系统 MUST 在启动播种（seedBundledPlugins）时跳过带墓碑的内置插件。
- **FR-003**: 系统 MUST 在删除内置插件时保留该插件的配置数据（config 不清空）。
- **FR-004**: 系统 MUST 提供"恢复内置插件"操作：清除全部墓碑、重新播种、重新加载。
- **FR-005**: 插件列表数据 MUST 包含 bundled 布尔字段，标识是否为内置插件。
- **FR-006**: 插件面板 MUST 对 bundled=true 的插件显示"内置"角标。
- **FR-007**: 内置插件的删除确认文案 MUST 说明可通过"恢复内置插件"找回。
- **FR-008**: 插件面板 MUST 在存在墓碑时显示"已删除 N 个内置插件"及恢复按钮。
- **FR-009**: 核心规则面板 MUST 提供导出，生成含 plugin/version/exportedAt/rules 的 JSON 文件。
- **FR-010**: 核心规则面板 MUST 提供导入，读取 JSON 并按 id 合并（同 id 覆盖、新 id 追加）。
- **FR-011**: 导入 MUST 校验格式（JSON 可解析、rules 为数组），非法时不修改现有规则并给出错误提示。
- **FR-012**: 导入/导出完成 MUST 给出含条数的成功提示或明确失败原因。
- **FR-013**: 非内置插件的删除行为 MUST 与现状完全一致。

### Key Entities

- **插件墓碑（tombstone）**：记录在 `<userData>/lingya-plugins.json` 对应 pluginId 下，形如 `{ deleted: true, deletedAt: ISO 字符串 }`，与该插件的 enabled/pinned/config 共存。
- **插件描述（plugin descriptor）**：scanPlugins 的返回项，新增 `bundled: boolean`。
- **规则（rule）**：`{ id, name, content, enabled, order }`，存于 `lingya-plugins.json` 的 `core-rules.config.rules`。
- **规则导出包（rules bundle）**：`{ plugin: 'core-rules', version: string, exportedAt: ISO 字符串, rules: rule[] }`。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 删除内置插件后连续重启 3 次，该插件均不出现在插件列表，其贡献的工具也不在 AI 工具清单中。
- **SC-002**: 恢复操作后，源目录中存在的全部内置插件目录 100% 重建成功且可加载。
- **SC-003**: 导出 → 导入往返（round-trip）后，规则集合（id/name/content/enabled/order）与导出前完全一致。
- **SC-004**: 现有 1110 个测试用例保持全绿；新增用例覆盖墓碑写入/跳过/清除、bundled 判定、mergeRules 纯函数。
- **SC-005**: 删除普通插件的行为与改动前逐字节一致（同目录删除、同记录清除、无墓碑残留）。

## Assumptions

- 内置判定采用**隐式**方式：应用自带源目录（打包后 resources/plugins，开发期项目根 plugins/）中存在同名目录即为内置；不改动三个内置插件的 manifest.json。
- 恢复粒度为**一键恢复全部**。被删除的插件不在列表中，单个恢复无入口，因此不实现单插件恢复。
- 内置插件版本升级**不自动复活**墓碑插件（尊重用户删除意图）；恢复入口始终可用。
- 导出格式为 JSON（单一格式），不提供 Markdown 导出。
- 导入策略为**按 id 合并**：同 id 覆盖 name/content/enabled，新 id 追加，order 合并后统一重排为 0..N-1。
- 导出/导入的文件对话框由**主进程侧**（插件 index.js 内）调用 electron dialog 实现；渲染层 panel.js 只通过 pluginInvoke 触发，不直接接触 fs/dialog。
- 墓碑与 config 共用同一条 pluginId 记录，删除时只置 deleted 标记，不清除 config/enabled/pinned。
