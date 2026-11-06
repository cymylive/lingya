# 灵鸦（LINGYA）项目全量分析报告

> 分析时间：2026-11-05
> 分析对象：C:/Users/Administrator/Desktop/灵鸦-0.6.88-src-20261103_20261103_183031
> 版本：package.json 声明 0.6.191（LINGYA.md 记录 0.6.86，目录名 0.6.88）
> 方式：静态抽读 + 规模统计 + 全量测试实跑（只读，未修改任何源码）

---

## 一、结论速览

| 维度 | 评价 | 说明 |
|------|------|------|
| 架构清晰度 | ★★★★☆ | 主进程 / preload / tools 三层边界明确，薄壳入口（根 main.js → src/main/index.js）设计良好 |
| 代码规模 | 约 6.2 万行 | src 4.0 万 + tools 6.2 千 + test 1.2 万 + prompt 6 千 |
| 测试健康度 | ★★★★★ | 实跑 1258/1259 通过，261 秒，仅 1 个失败（记忆脱敏导入校验） |
| 工程规范 | ★★★★☆ | global-guard / readonly-guard / plan-gate / tool-lifecycle / idempotency 护栏齐全 |
| 主要风险 | 中高 | git 不可用、文档严重滞后（版本差 105、用例差 527）、占位符还原 bug、1.2GB 历史产物 |

一句话：工程成熟度高、护栏扎实、测试覆盖充分；但版本三方不一致、CHANGELOG 断更 91 个版本、git 在 PATH 缺失，加上一个正在影响 AI 自身工作的脱敏占位符 read 失败 bug，需要优先处理。

---

## 二、规模与结构

### 2.1 目录统计

| 目录 | 文件数 | 行数 | 最大单文件 |
|------|-------:|-----:|------------|
| src/main | 79 | 18,943 | index.js 113.2 KB / 2744 行 |
| src/preload | 70 | 21,414 | render.js 335.7 KB |
| ├ dom 子层 | 35 | — | intercept.js 55.6 KB |
| └ overlay 子层 | 20+ | — | template.js 87.6 KB / events.js 51.9 KB |
| tools | 43 | 6,159 | sandbox.js（jsRunner）29.2 KB |
| test | 141 | 12,378 | — |
| src/prompt | 67（含 _bak） | — | — |
| src/providers | 4 | 1,800 | — |
| 合计 | ~404 | ~62,000 | — |

### 2.2 分层架构（实测）

```
用户提问
  ↓
AI 网页回复（含 lingya 代码块）
  ↓
【preload 层】intercept.js（hook fetch/XHR）/ MutationObserver
  ↓ tool-parser.js 宽容 JSON 解析（parseJsonWithRepair）
  ↓ tool-executor.js（idempotency + withTimeout + upsertToolCard 实时反馈）
  ↓ IPC
【主进程层】ipc.js(97KB) → tool-registry → 门禁链
  ├─ dangerous-commands.js   危险命令拦截
  ├─ readonly-guard.js       只读模式写操作拦截（方案 B，启发式）
  ├─ plan-gate.js            写前须建计划（每会话最多拦一次）
  ├─ tool-lifecycle.js       按会话隔离追踪
  └─ with-timeout.js         超时包装
  ↓
【沙箱层】tools/sandbox.js（vm.createContext）
  ↓ IPC 回传
【preload】结果填回输入框 → 发给 AI → 下一轮
```

### 2.3 状态机（task-state.js，335 行）

```
IDLE --send--> SENT --ai-start--> AWAITING --ai-response--> RESPONDED
RESPONDED --有工具--> EXECUTING --执行完--> SENT（回传结果）
RESPONDED --无工具--> IDLE（任务收尾）
```

停滞阈值：SENT 30s / AWAITING 120s / RESPONDED 30s / EXECUTING 由工具超时兜底。
持久化到 localStorage，页面刷新可读回。

---

## 三、测试基线

实跑 npm test（D:/NodeJS node v24.15.0）：

```
tests 1259
pass  1258
fail  1
duration_ms 261484.2493  (~4 分 21 秒)
```

唯一失败项：

```
test/main/redact-store.test.js:98
✖ 导出→导入往返：规则完全一致
Error: 导入被拒绝：「xxx」长度仅 2 字符，子串替换会大面积误伤，至少 3 个字符
  at Object.importRules (src/main/redact-store.js:519:22)
```

含义：导入规则时做了「长度 ≥ 3」的防护，但导出→导入往返测试里含 2 字符规则，两者冲突。属于测试与实现的契约不一致，不是生产 bug。

耗时热点：token-rotation.test.js 里有个用例跑了 60011ms（等待期超时），单文件就占了总耗时 23%。可优化。

---

## 四、发现的问题（按严重度）

### P0-1｜git 在 PATH 中缺失，仓库卫生不可维护

证据：where git → NOT_FOUND；C:/Program Files/Git/cmd/git.exe、(x86)、%LOCALAPPDATA%/Programs/Git、D:/Git 全部不存在；git status → GIT_NOT_AVAILABLE。

影响：
- 无法查看未提交改动、无法分主题提交、无法回滚
- 项目有完整的 .github/workflows（lint/coverage/release），但本地无法 git 操作
- .lingyaCode/notes 的架构决策笔记体系依赖 git 提交追溯，现在断链

建议：安装 Git for Windows 并加 PATH，或在项目 README 里写明「需自行安装 git」。

### P0-2｜记忆脱敏占位符导致 read 工具读取失败（真实 bug）

证据：

| 调用 | 结果 |
|---|---|
| read("src/main/memory-store.js") | ✅ 成功，684 行 |
| read("src/main/<占位符>-store.js") | ❌ 文件不存在 |
| read("src/main/<占位符>-<占位符>.js") | ❌ 文件不存在 |
| grep("MEMORY_TOKEN_BUDGET", { path: "src/main" }) | ✅ 返回 src/main/<占位符>-store.js |

根因推断：占位符的真词是 memory，但 read 工具在还原占位符时未正确还原（或还原后拼出的路径与磁盘真实文件名不同）。而 grep 的输出是原始路径，被脱敏模块替换成占位符显示。

影响：AI 看到 grep/glob 结果里的占位符路径后，用它去 read 会失败。这直接阻断 AI 自主探索代码库——本次分析中已经踩到 5 次以上。

建议：排查 read 工具的占位符还原逻辑（或脱敏模块的 replace 规则），确保「工具输入里的占位符」与「工具输出里的占位符」使用同一套还原映射。

### P1-1｜版本号三方不一致

| 来源 | 版本 |
|---|---|
| package.json | 0.6.191 |
| .lingyaCode/LINGYA.md | 0.6.86（落后 105 个版本） |
| 目录名 | 0.6.88-src |
| CHANGELOG.md 最新条目 | 0.6.100（落后 91 个版本） |

影响：新协作者（含 AI）无法判断当前代码状态；LINGYA.md 里的「732 个用例」实际是 1259。

### P1-2｜LINGYA.md 目录结构缺 20+ 个新文件

已确认缺失（grep 实测）：
- 主进程：memory-redact.js、tools/memory-audit.js、global-guard.js、ipc-guard.js、task-status.js、token-rotation.js、workspace-aggregator.js、cdp-capture.js、cdp-wiring.js、channel-commands.js、channel-panel.js、media/*（4 个）、qq-ipc.js、weixin-ipc.js、pet-loader.js、overflow-window.js、conversation-archive*.js（2 个）、preset-store.js、prompt-template-store.js
- preload：cdp-bridge.js、dom-fallback.js、rate-limit-retry.js、redact-filter.js、sanitize-tool-output.js、tps-meter.js、upload-hint.js、xml-detect.js、harness-bridge.js、harness-preload.js、statusbar-layout.js
- overlay：comm-panel.js、eye-tracking.js、pets/*、qq-panel.js、redact-panel.js、weixin-panel.js
- tools：DispatchTool.js、PurgeTool.js、SkillTool.js、WaitForTool.js、UserTodoStore.js、memory-janitor.js、memory-audit.js、redact-log-auto-scan-tool.js、RedactLookupTool.js、SendMediaTool.js、with-timeout.js

### P1-3｜Roadmap.md 与实现状态脱节

| Roadmap 条目 | 实际状态 |
|---|---|
| 「中途停止思考」标 [ ] | 已实现（CHANGELOG 0.6.98 有 plan_confirm；任务停止功能在提示词里已有） |
| 「Skill 支持」标 [ ] | tools/SkillTool.js 已存在，提示词里 skillList() 已注册 |
| 「网络异常重试」标 [ ] | preload/dom/rate-limit-retry.js 已存在 |
| 「对话压缩」标 [ ] | preload/dom/compaction.js 已存在 |

影响：路线图不可信，无法据此排期。

### P2-1｜仓库卫生

残留文件（实测）：
- src/main/memory-store.js.bak-memsys-20261028
- src/main/project-context.js.bak-memsys-20261028
- src/main/skill-store.js.bak-skill-20261028
- dbg-redact.js（根目录）
- build-installer.log / build-portable.log / build-portable2.log
- dist/ 里 11 个历史 exe（0.6.178 ~ 0.6.191）+ win-unpacked，总计 1,235.6 MB

### P2-2｜单文件过大

| 文件 | 大小 | 行数 |
|---|---:|---:|
| src/preload/render.js | 335.7 KB | — |
| src/main/index.js | 113.2 KB | 2,744 |
| src/main/ipc.js | 97.3 KB | 2,360 |
| src/preload/overlay/template.js | 87.6 KB | — |
| src/preload/dom/send-input.js | 73 KB | — |

render.js 虽已剥离 16 个纯函数到 shell-utils.js（CHANGELOG 0.6.99 记录），仍是最大文件。

### P2-3｜测试耗时热点

token-rotation.test.js 中「无可用窗口返回 no-target」用例 60011ms（等满 targetBusyWaitMs 超时）。单文件占全测试 23% 时间。建议 mock 定时器或缩短超时。

### P3-1｜npm 命令未在 PATH

npm --version → NO_NPM（但 npm test 能跑，说明 D:/NodeJS 里有 npm 但 npm 命令名本身未在 PATH 暴露，需要完整路径）。

### P3-2｜UI-REDESIGN-PLAN 未闭合

docs/UI-REDESIGN-PLAN.md 最后一项「npm test 全绿」未勾选（之前受 electron 环境阻塞）。本次实测 1258/1259，说明基本已通，可更新。

### P3-3｜LINGYA.md 自身膨胀

216 行（系统注入部分），加上项目文档后总量很大。部分内容（如「十、协作规范」整段移植自 DeepSeek Harness）可以精简为链接引用。

---

## 五、设计亮点（值得保留）

1. 薄壳入口：根 main.js / preload.js 只做转发，真实逻辑在 src/，便于测试与重构。
2. 护栏先行：global-guard 在任何业务模块加载前安装（index.js:12），主进程异常可广播到 UI。
3. 状态机单源：task-state.js 是任务状态唯一真相源，UI 不再各处手动开关（CHANGELOG 0.6.100 记录）。
4. 并发代际管理：beginExecution/endExecution/killRunning 用代际 ID 而非布尔标记。
5. 提示词三重防护：节流 15s + 批次 ID 去重 + 接收端守卫。
6. 测试即规范：断言 MAX_WAIT_MS ≤ 180000、提示词必须含禁止死等规则、deepseek hook 不得用 window.__lingya* 全局标记。
7. 平台 hook 自包含：getHookSource() 序列化后必须语法正确且自包含。
8. 记忆脱敏三层：memory-redact（检测）/ redact-store（规则）/ redact-lookup（查询），配合 AI 主动调用。

---

## 六、修复建议（按优先级）

### 立即（止血）

| # | 任务 | 预估 |
|---|---|---|
| 1 | 修复 read 工具占位符还原 bug（P0-2） | 2h |
| 2 | 安装 git 并验证 git status 可用（P0-1） | 30min |
| 3 | 修 redact-store.test.js 导入往返测试（调整测试数据或放宽校验） | 30min |

### 短期（对齐）

| # | 任务 | 预估 |
|---|---|---|
| 4 | 更新 LINGYA.md：版本号 → 0.6.191、用例数 → 1259、目录结构补 20+ 文件 | 2h |
| 5 | 重写 Roadmap.md：按实际状态勾选，剩余项重排 | 1h |
| 6 | CHANGELOG 补 0.6.101 ~ 0.6.191 关键条目（或从 git log 生成） | 3h |
| 7 | 清理残留：3 个 .bak、dbg-*.js、3 个 build-*.log | 10min |
| 8 | dist/ 清理：保留最新 2 个版本，其余 9 个 exe 归档或删除（省 ~1GB） | 10min |

### 中期（优化）

| # | 任务 | 预估 |
|---|---|---|
| 9 | 拆分 render.js（335KB）和 index.js（113KB） | 1-2 天 |
| 10 | 优化 token-rotation.test.js 的 60s 等待用例 | 2h |
| 11 | UI-REDESIGN-PLAN 收尾，勾选最后一项 | 30min |
| 12 | LINGYA.md 第十节精简为链接 | 1h |

### 长期（能力）

按 Roadmap 原计划：ChatGPT 完整支持 → Grok → Gemini → 子 agent。

---

## 七、可立即执行的验证命令

```cmd
set "PATH=D:/NodeJS;%PATH%"
node --test --test-concurrency=1 test/main/redact-store.test.js
npm test
```

---

## 八、附：本次分析踩到的坑

1. 占位符 read 失败（P0-2）：读 src/main/<占位符>-store.js 失败 5 次，最后改用真名 memory-store.js 才成功。这是本次分析最大的效率损耗。
2. git 不可用（P0-1）：无法确认工作区脏度，只能通过 dir 扫残留。
3. npm 命令：npm --version 报 NO_NPM，但 npm test 能跑通（说明 D:/NodeJS 里有 npm 但 npm 命令名本身未在 PATH 暴露，需要 npm.cmd 或完整路径）。
4. 反引号破坏：首次写报告时用模板字符串包裹含三反引号的 markdown，导致 Unexpected end of input。改用占位符替换法重写。
