# 架构决策笔记（Agent Notes）

> 移植自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent Note 体系，用于记录 LingYa 的**决策与取舍**——代码和文档无法承载的「为什么」以及「放弃了什么」。

## 为什么需要它

LingYa 有过反复返工的教训（见长期记忆「同一路径失败 2-3 次必须质疑架构本身」）。根本原因是**改动前没有把决策和取舍写下来**，导致：

- 同一问题反复争论、反复改
- 后来者不知道某个设计「为什么是这样」，误以为是历史包袱而删掉
- 改完代码后，决策依据只存在于某次对话里，无法追溯

Agent Note 强制一件事：**改代码前/后，把决策、备选方案、后果写成一份可追溯的笔记。**

## 布局与命名

每份笔记有两个维度，编码在**路径**中：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`

- **生命周期**（顶层文件夹）——笔记的状态，随状态变化在文件夹间移动：
  - `proposed/`：实施前评审的提案（尚未构建或仅部分构建）
  - `implemented/`：决策已交付。文件记录做了什么决定、否决了什么，并与实际交付内容保持同步
  - `rejected/`：提案经过讨论后被否决。仅当其决策依据仍能避免一种诱人错误时保留
- **类别**（嵌套文件夹）——决策的种类：

| 类别 | 覆盖范围 |
|---|---|
| `feature` | 面向用户或模型的新能力 |
| `bug-fix` | 修正缺陷或弥补事故复盘发现的缺口 |
| `simplification` | 在不增加能力的前提下移除代码、行为或对外范围 |
| `architecture` | 关于**交付源码**的结构性决策：模块之间的关系、运行时词汇 |
| `process` | 代码**周边**的工具、策略或工作流——门禁、包管理器——不涉及运行时行为 |
| `testing` | 测试基础设施与策略 |

文件名中的日期是该主题**首次提出**的时间。笔记之间的交叉引用使用相对 Markdown 链接。

## 何时需要写一份

**只有代码、测试和现有文档未能解释的决策理由具有长期价值时**，才需要新增或更新笔记。

需要写：
- 新增/修改架构性决策（改分层、改通信机制、改存储格式）
- 修复非平凡的 bug（根因有价值）
- 移除功能（记录为什么移除、放弃了什么）
- 引入新流程/门禁

不需要写：
- 纯机械改动（格式化、重命名、调样式）
- 局部 UI 展示/交互微调
- 补一个明显的漏洞

判断标准：**「半年后有人想删这段代码，这份笔记能否阻止他犯错？」** 能，就写。

## 文件格式

每份活跃笔记遵循统一格式（由 `scripts/check-notes.js` 强制校验）：

### 头部块

前三行严格为：

```markdown
# Agent Note: <title>

Status: <status>
```

后跟一个空行。`Status:` 必须与文件所在生命周期文件夹一致：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一句话原因>`

### 正文骨架

正文以 `## Problem` 开头（不依赖解决方案即可独立成文的动机）。

```markdown
## Problem
## Proposal
…自定义章节…
## Alternatives considered
## Acceptance criteria
## Risks
```

```markdown
## Problem
## Decision
…自定义章节…
## Alternatives considered
## Consequences
```

```markdown
## Problem
## Proposal
…冻结提案原样…
```

### 曾考虑的替代方案——必需

**每份笔记都必须包含 `## Alternatives considered` 章节**：每个真实的替代方案及其落选原因。

> 记录决策时不记录它击败了什么，就是在邀请反复争论——这正是本体系要防止的问题。

## 校验

```bash
npm run check:notes
```

或直接：

```bash
node scripts/check-notes.js
```

校验项：
- 生命周期文件夹与 `Status:` 行一致
- 类别文件夹在封闭集合内
- `## Problem` 开头
- 必需章节齐全（`## Alternatives considered`）
- 文件名符合 `yyyy-mm-dd-topic-title.md` 格式
- implemented 笔记不出现提案阶段用语（`## Proposal` 等）

## 与 LINGYA.md 的关系

- `LINGYA.md`：项目**地图**（结构、机制、命令）——回答「是什么」
- `notes/`：**决策记录**（为什么这样做、否决了什么）——回答「为什么」
