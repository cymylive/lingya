# Agent Note: 写操作不限制项目目录（路径逃逸是刻意设计）

Status: rejected — 用户明确要求保留写项目外文件的能力，安全限制会破坏该场景

## Problem

`tools/WriteTool.js` 与 `tools/EditTool.js` 用 `path.join(projectDir, filePath)` 解析路径，
对 `../` 不做任何拦截。实测 `../../../Windows/System32/drivers/etc/hosts` 可以穿越到
项目目录之外，写入任意位置。

这在代码审查中看起来像「严重安全漏洞」：一个 Agent 工具，凭什么能写系统文件？

## Proposal

在写操作前加越界校验：

```js
const resolved = path.resolve(projectDir, input.filePath);
const rel = path.relative(projectDir, resolved);
if (rel.startsWith('..') || path.isAbsolute(rel)) {
  return ToolResult.error('路径越界：' + input.filePath);
}
```

同时收紧工具描述里的「或绝对路径」措辞。

## Alternatives considered

**只拦 `../` 不拦绝对路径** —— 落选原因：形同虚设。`C:\Windows\...` 这种绝对路径直接绕过，
校验只挡住了更麻烦的写法。要拦就必须两个都拦。

**加白名单（允许特定系统路径）** —— 落选原因：用户的使用场景是「改项目外的配置文件」，
具体是哪些路径无法预先枚举（可能是 `~/.ssh/config`、可能是某个软件的配置目录）。
白名单维护成本高且必然漏。

**保留能力但加确认弹窗** —— 落选原因：AI 自动化执行时无人值守，弹窗会阻塞整个流程；
且用户要的就是「直接改」，加确认等于把成本转嫁给用户。

## Consequences

**收益**：
- AI 可以修改项目外的配置文件（如 `~/.ssh/config`、编辑器配置、系统配置），
  这是实际存在的使用场景，不是理论风险
- 与 `bash` 工具的行为一致 —— `bash` 本来就能执行 `rm C:\Windows\...`，
  只限制 `write` 而不限制 `bash` 是自欺欺人

**代价**：
- AI 判断失误时可能写到预期之外的位置，且不易察觉
- 被恶意内容诱导时（如抓取的网页里嵌了指令）可能覆盖敏感文件

**风险接受依据**：
- `bash` / `pwsh` 工具本身就能做任意文件操作，限制 `write` 无法真正提升安全性，
  只会降低可用性
- 真正的防护应该是「不让 AI 读到恶意指令」（输入侧），而不是限制输出侧的路径

## 备注

**任何人在代码审查中看到「写操作没有路径校验」，不要再提为漏洞。**
这是 2026-10-23 用户明确否决过的提案（原话：「AI 再也改不了项目外的配置文件，
我需要可以改项目外的文件，所以这个功能不需要改」）。

要做安全限制，必须先问用户，并说明会破坏什么场景。
