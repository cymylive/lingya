# 脱敏规则链路分析（源码实读）

> 生成时间：2026-11-06
> 分析范围：src/main/redaction-store.js、src/preload/dom/redaction-filter.js、chat-input.js、intercept-observer.js、dom-unredact.js、src/main/ipc.js、tools/JsRunner.js、project-context.js、memory-redaction.js
> 方法：逐文件读源码 + grep 调用点，未做任何代码改动

## 一、总体架构

两层三出口：

- **规则源（主进程）**：`src/main/redaction-store.js` —— 唯一事实来源，读写 `<userData>/lingya-redaction.json`
- **规则副本（渲染进程）**：`src/preload/dom/redaction-filter.js` —— 异步拉取后缓存 `cachedPairs`，同步可用
- **八个出口**：出站（真词→占位符）与入站（占位符→真词）成对出现

## 二、规则存储格式

存储文件 `lingya-redaction.json`：

```json
{ "version": 2, "rules": [ { name, words[], desc, enabled, source, scope } ] }
```

- `name`：占位符内容，最终形态 `⟦name⟧`（U+27E6/U+27E7 包裹，零碰撞）
- `words`：真词列表
- `source`：`manual` | `auto`
- `scope`：`global`（全链路）| `memory-only`（只影响记忆检索）

### 关键设计：多词规则必须拆分

`redaction-store.js:156-167`（加载时迁移）、`:264-281`（addRule）、`:636-648`（importRules）**三处都会把 `words.length > 1` 的规则拆成 `name_1`、`name_2`…**

原因（源码注释 `:265-267`）：一占位符对多词时，反向还原无法确定用哪个词，会全还原成 `words[0]`，语义丢失。

**⚠️ 直接后果**：想伪装工具名时，`{name:"工具_执行", words:["Bash","Pwsh"]}` 导入后会变成
`bash` / `pwsh`，**不会**得到单一 `⟦工具_执行⟧`。

## 三、规则加载链路

```
[主进程启动]
  redaction-store.ensureLoaded()
    ├─ 读 lingya-redaction.json
    ├─ 归一化（补 source/scope 默认值）
    ├─ 多词规则自动拆分 → 若发生迁移则 persist() 回写
    ├─ warnToolNameRules()：检查规则表是否含会破坏工具调用的词
    └─ 文件不存在 → 写入 DEFAULT_RULES
  同时 startWatcher() 监听文件变化（热重载）
        ↓
[preload 初始化] src/preload/index.js:24-33
  redaction-filter.refreshRules()
    └─ electronAPI.getRedactionRules('global')
         └─ IPC 'get-redaction-rules' → redaction-store.getActiveRules('global')
    └─ 构建 cachedPairs = [{word, placeholder}]，按 word 长度降序
        ↓
[规则变更时] ipc 'redaction-rules-changed' → preload/index.js:13-21 → refreshRules()
```

**作用域过滤**：`getActiveRules('global')` 只返回 `scope === 'global'` 的规则。auto 规则默认 `memory-only`，**不参与** preload 侧用户输入脱敏。

## 四、出站链路（真词 → 占位符）

`redaction-store.redactText()`（`:445-473`）/ `redaction-filter.redactText()`（`:68-81`）

| # | 出口 | 代码位置 | 脱敏对象 |
|---|---|---|---|
| 1 | 用户短消息 | `chat-input.js:466-473` | 输入框文本 |
| 2 | 初始提示词（回退文本模式） | `chat-input.js:907` → setInputContent | systemPrompt |
| 3 | 初始提示词（附件模式） | `file-upload.js:132-139` | systemPrompt 文件内容 |
| 4 | 工具结果回传 | `chat-input.js:693-699` | 单工具输出 |
| 5 | JS 汇总回传 | `chat-input.js:745-751` | 多脚本输出 |
| 6 | harness 事件 | `harness-bridge.js:34-40` | 工具卡片显示 |

**注意**：`project-context.js` 里**没有** redactText 调用（历史会话提到的硬编码别名逻辑已被清除，当前确认干净）。systemPrompt 的脱敏实际发生在 **preload 侧填输入框/上传附件时**，不在主进程组装时。

### 替换算法差异（重要）

- **主进程版**（`:445-473`）：逐词扫描 + `isProtectedMatch()` 词边界保护。ASCII 词若前后是 `[A-Za-z0-9_$]` 则**不替换**（防止 `js` 把 `json` 拆坏）。2026-11-05 已取消路径分隔符/扩展名保护。
- **preload 版**（`:68-81`）：纯 `split/join`，**无词边界保护**。

→ 两侧行为不完全一致，同一文本在主进程和渲染进程可能得到不同结果。目前实际出站都走 preload 版。

## 五、入站链路（占位符 → 真词）

| # | 入口 | 代码位置 | 还原对象 |
|---|---|---|---|
| 1 | AI 回复拦截 | `intercept-observer.js:393-404` | **整段 raw 回复**先 unredact，再提取代码块 |
| 2 | execute-js（AI 代码块工具调用） | `JsRunner.js:469-478` | 工具参数 args（unredactDeep） |
| 3 | execute-tool（结构化工具调用） | `ipc.js:1193-1196` | 工具参数 params（unredactDeep） |
| 4 | execute-command | `ipc.js:962-965` | 命令行字符串 |
| 5 | 网页 DOM 显示 | `dom-unredact.js:37-58` | AI 回复容器文本节点 |
| 6 | 会话存档/导出 | `conversation-log.js:222-223` | 存档文本 |
| 7 | IM 推送（飞书/微信/QQ） | `feishu-bridge.js:34` 等 | 推送文本 |
| 8 | 覆盖层日志 UI | `overlay/ui.js:648-652` | command / output |

### 第 1 项是全链路的关键枢纽

`intercept-observer.js:393-404` 的注释写得很清楚：

> 出站脱敏把系统提示词里的围栏标识 `lingya` 换成占位符，AI 模仿输出的代码块围栏也是占位符，`js-detector` 只认 `lingya/js/javascript`，识别不到 → 误判任务完成。同理代码块内的工具函数名被脱敏后 JsRunner 执行报 `xxx is not defined`。整体 unredact 一次，两个问题一起解决。

所以：**出站脱敏可以放心脱工具名，因为 AI 回复会先整体还原**。

### unredactDeep

`redaction-store.js:492-501`：递归处理 string / array / object，用于工具参数。

## 六、护栏与防护

| 机制 | 位置 | 说明 |
|---|---|---|
| 危险词黑名单 `DANGEROUS_WORDS` | `:224-237` | 列出 js/const/await/readFile 等，但… |
| `checkWordSafe()` | `:240-252` | **2026-11-05 起永远返回 null**，所有词都放行 |
| 启动时风险警告 | `:114-134` | 规则表含 RISKY 词时 console.warn |
| 词边界保护 | `:427-443` | 仅主进程 redactText 有 |
| 破坏性操作前备份 | `:322-335` | delete 前复制 `.bak-<tag>-<时间戳>` |
| 文件热重载 | `:60-106` | fs.watch + 防抖，`_isPersisting` 标记避免自触发 |

**结论**：护栏已形同虚设（`checkWordSafe` 放行一切），只剩启动警告这一道提示。

## 七、记忆脱敏（独立机制，易混淆）

`src/main/memory-redaction.js` 的 `isSensitive()` 与上面的占位符脱敏**不是一回事**：

- 目的：判断一条记忆**是否允许外发**
- 手段：内置 5 条主题正则（封号分析/反检测/模拟真人等）+ 用户规则表里的词命中 name/content/tags
- 效果：命中则整条记忆不注入提示词

它**读取** redaction-store 的规则（`:61-72`），但只用来判定"敏感与否"，不做文本替换。

## 八、链路完整性判断

**双向闭环成立**：
```
真词 --redactText(preload)--> ⟦占位符⟧ --发给 AI--> AI 回复含 ⟦占位符⟧
  --unredactText(intercept-observer)--> 真词 --执行--> 成功
```

**三个已知薄弱点**：
1. **多词规则必拆分** → 占位符带 `_1`/`_2` 后缀，无法得到干净的单一别名
2. **两侧替换算法不一致** → 主进程有词边界保护，preload 没有
3. **护栏全部放行** → 用户可把 `js`/`await` 加进规则表，会导致工具调用大面积失败（靠启动警告提示）

## 九、接入新脱敏能力时的落点

- 加"规则源"相关能力 → `src/main/redaction-store.js`
- 加"用户输入/工具结果出站"→ `src/preload/dom/` 里调用 `redaction-filter`
- 加"AI 回复入站"→ `src/preload/dom/intercept-observer.js`（或独立模块，参考 dom-unredact.js）
- 加"工具参数还原"→ `JsRunner.js`（execute-js 通道）或 `ipc.js`（execute-tool 通道）
- 加"主进程侧文本还原"→ 直接 `require('./redaction-store').unredactText/unredactDeep`
