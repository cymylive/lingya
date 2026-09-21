# LingYa 0.5.3 mod 安装到 0.5.1 记录

> 安装日期：2026-09-20
> 目标项目：C:\Users\Administrator\Desktop\lingya-0.5.1（原版本 0.5.1）
> mod 来源：H:\lingya\LingYa二次开发归档-0.5.3（基线为 0.5.3 的二次开发归档）

## 一、安装方式说明

mod 归档是基于 **0.5.3** 的完整文件快照，而目标项目是 **0.5.1**。
直接覆盖会把 0.5.3 上游特性（附件上传、MCP 增强、重试/看门狗等）混入 0.5.1，因此采用
**三方 diff 精确移植**：

1. 从 GitHub 拉取 0.5.3 原版（tag v0.5.3）作为基线；
2. 解包 0.5.3 便携版 app.asar，得到「0.5.3 + mod」成品；
3. 对比「0.5.3 原版 → 0.5.3+mod」提取出 **mod 自身的真实改动**；
4. 将该改动手工合并到 0.5.1，避开 0.5.3 上游特性。

备份：原始文件已存于 H:\lingya\_backup051（src / tools / assets / package.json）。

## 二、已安装的 mod 功能（共 12 项）

| 序号 | 功能 | 类型 |
|------|------|------|
| 1 | 对话状态可视化（悬浮球三态状态灯） | 新增+改造 |
| 2 | 长期记忆系统（存储/AI工具/管理面板/注入） | 移植 |
| 3 | Skill 技能系统（存储/管理面板/本地导入/注入） | 移植 |
| 4 | web_search 联网搜索工具 | 移植 |
| 5 | 系统托盘（后台常驻 + 开机自启跟随 exe） | 新增 |
| 6 | 关闭窗口修复（菜单显式真正关闭） | 修复 |
| 7 | 工具浏览器窗口关闭修复（will-prevent-unload） | 修复 |
| 8 | 记忆与技能搜索 | 新增 |
| 9 | 窗口大小记忆（每 profile 独立） | 新增 |
| 10 | 新会话自动注入（记忆+技能） | 新增 |
| 11 | 设置面板滚动修复 | 修复 |
| 12 | 4 个提示词模板补 {{MEMORY_SECTION}} / {{SKILL_SECTION}} | 修复 |

## 二·补、追加功能：停止任务（2026-09-21 新增）

### 需求
对话任务执行过程中无法中断，需要一个「停止」按钮，点击后立即停止。

### 功能
| 入口 | 行为 |
|------|------|
| 面板「⏹ 停止」按钮 | 生成中/执行中时出现，点击即停 |
| 悬浮球右键 | 任意时刻右键悬浮球即停 |
| 恢复 | 发送任意消息自动清除停止状态，恢复正常 |

### 停止时发生什么（三层全断）
1. **AI 生成层**：调用 provider 的 findStopButton() 点击页面原生「停止生成」
2. **工具执行层**：主进程 killAll() 杀掉所有活动子进程（taskkill /T 杀进程树）
3. **自动循环层**：置 stopped 标志，之后收到的 AI 回复、工具结果一律丢弃，不再回传触发下一轮

### 改动文件
| 文件 | 改动 |
|------|------|
| tools/active-processes.js | **新增**：活动子进程跟踪 + 全局中止标志 |
| tools/BashTool.js | 注册/注销子进程 |
| tools/PwshTool.js | 注册/注销子进程 |
| tools/JsRunner.js | 注册子进程 + hostBridge 检测中止 + run 入口守卫 |
| src/main/ipc.js | 新增 abort-execution / clear-abort handler |
| src/preload/api.js | 暴露 stopExecution / clearAbort |
| src/preload/dom/state.js | 加 stopped 标志 |
| src/preload/overlay/ui.js | setStopped/isStopped + 停止按钮显隐联动 |
| src/preload/overlay/template.js | 停止按钮 + 已停止提示 + 悬浮球 stopped 态 CSS |
| src/preload/overlay/events.js | 停止按钮绑定 + 悬浮球右键 + stopTask/clearStopped |
| src/preload/dom/intercept-observer.js | 停止后丢弃回复、忽略完成事件、resetGenerating |
| src/preload/dom/tool-executor.js | 停止后不执行新工具、不回传结果 |
| src/preload/dom/chat-input.js | 发消息清除停止态 + 延迟发送守卫 |
| src/providers/deepseek.js / claude.js / chatgpt.js | 新增 findStopButton() |

### 修复：手动发消息未恢复状态（2026-09-21）
**问题**：右键停止后手动发消息，悬浮球仍显示「已停止」，未恢复实时对话状态。
**原因**：清除 stopped 的逻辑只写在 chat-input.js 的 sendToChat()（程序自动发送路径），
用户手动打字发送不经过它，状态永不恢复。
**修复**：改为以 lingya-ai-start 事件（AI 开始生成，无论谁触发）作为恢复信号——
intercept-observer.js 收到 lingya-ai-start 时，若 state.stopped 为真则清除并恢复自动执行。
（lingya-ai-start 在每次 completion 请求发出瞬间触发，停止不会触发它，是可靠的"新一轮开始"信号。）

### 验证
- 16 个改动文件 node --check 全通过
- 测试套件 **246 tests / 246 pass / 0 fail**
- 集成验证：正常执行→中止拒绝→沙箱内调用拦截→恢复执行，全部符合预期

## 三、文件清单

### 新增文件（9 个）
| 文件 | 说明 |
|------|------|
| src/main/memory-store.js | 记忆存储 + 智能选择器（分词/打分/token预算） |
| src/main/skill-store.js | 技能存储 + SKILL.md 解析 + buildSkillSection |
| src/main/tray.js | 系统托盘（常驻 + 自启跟随） |
| tools/MemoryTool.js | 记忆 AI 工具（memory_save/update/delete/list） |
| tools/WebSearchTool.js | 联网搜索工具（Bing 抓取解析） |
| src/preload/overlay/memory-panel.js | 记忆管理面板 |
| src/preload/overlay/skill-panel.js | 技能管理面板 |
| src/preload/dom/auto-inject.js | 新会话自动注入监视 |
| assets/tray-icon.png | 托盘图标 |

### 修改文件（20 个）
- 主进程：src/main/index.js、ipc.js、project-context.js、profile-manager.js
- preload：src/preload/api.js、index.js、dom/intercept-observer.js、dom/session-list.js、
  overlay/events.js、overlay/project-dir.js、overlay/template.js、overlay/ui.js
- providers：src/providers/deepseek.js、chatgpt.js、claude.js（后两者为 mod 版直接覆盖，0.5.1↔0.5.3 基线一致）
- 工具：tools/index.js、JsRunner.js、browser-window-manager.js
- 提示词：src/prompt/default.md、deepseek.md、chatgpt.md、claude.md
- 工程：package.json（extraResources 加 tray-icon.png）

## 四、关键适配点（0.5.1 与 0.5.3 差异处理）

1. **initProject 签名**：0.5.1 为 (skipPrompt, windowContext, presetDir, isCompaction)，
   记忆/技能注入块插在 mcpSection 之后，placeholders 追加 MEMORY_SECTION / SKILL_SECTION。
2. **无独立设置面板**：0.5.1 设置项内联在主面板，「新会话自动注入」开关放在「发送延迟设置」上方，
   由 events.js 的 bindEvents 直接绑定 change 事件保存到 localStorage。
3. **无 watchdog / retry-engine**：intercept-observer 只加 lingya-ai-start 监听与超时兜底，
   不引入 0.5.3 的 watchdog 调用。
4. **无 MCP_SECTION 占位符**：0.5.1 提示词模板不加 {{MCP_SECTION}}，只加记忆/技能两节。
5. **tray 的 hasTray() 守卫**：window-all-closed / close 事件在无托盘时退化为原行为，保证健壮。

## 五、验证结果

- **语法校验**：全部 23 个改动文件 `node --check` 通过。
- **依赖安装**：`npm install`（需 PATH 含 D:\NodeJS）→ 410 packages。
- **测试套件**：`node --test` → **246 tests / 246 pass / 0 fail**。
- **集成验证**：memory-store / skill-store 的 save/list/buildSection 正常；
  MemoryTool / WebSearchTool 工具对象可实例化，工具名 memory_save / web_search 正确。
- **键值链路**：lingya-auto-inject（开关）、lingya-last-project-dir（目录记忆）写入与读取一致。

## 六、运行方式

```powershell
$env:Path = "D:\NodeJS;" + $env:Path
cd C:\Users\Administrator\Desktop\lingya-0.5.1
npm start
# 或 electron .
```

## 七、注意事项

- 长期记忆存于 `<userData>/lingya-memory.json`，技能存于 `<userData>/lingya-skills.json`。
- userData = C:\Users\Administrator\AppData\Roaming\lingya-ai-pro-session。
- 新会话自动注入需先手动点一次「初始化项目」确定目录，之后新会话自动复用。
- 打包需在 package.json 的 extraResources 中带上 assets/tray-icon.png（已配置）。

## 八、回滚方式

如需还原到安装前状态，用备份覆盖：
```powershell
Copy-Item -Recurse -Force H:\lingya\_backup051\src   C:\Users\Administrator\Desktop\lingya-0.5.1\src
Copy-Item -Recurse -Force H:\lingya\_backup051\tools C:\Users\Administrator\Desktop\lingya-0.5.1\tools
Copy-Item -Force H:\lingya\_backup051\package.json   C:\Users\Administrator\Desktop\lingya-0.5.1\package.json
```
（并删除新增的 9 个文件）
