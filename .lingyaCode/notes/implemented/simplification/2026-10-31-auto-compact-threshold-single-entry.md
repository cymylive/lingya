# Agent Note: 自动压缩阈值只保留侧边栏唯一入口，判定改为每秒实时读

Status: implemented

## Problem

「自动压缩上下文」的阈值原本有**两个可写入口**，且写的是同一份 localStorage 键：

- 悬浮球覆盖层面板：`src/preload/overlay/template.js` 的 `#lingya-auto-compact-enabled` / `#lingya-auto-compact-threshold` / `#lingya-auto-compact-save`，保存逻辑在 `src/preload/overlay/events.js` 的 `saveAutoCompactConfig()`。
- 侧边栏设置页：`src/preload/shell-renderer.js` 的 `#sh-set-acen` / `#sh-set-acth` / `#sh-set-acsave`，保存时经 `shell-set-setting` IPC 回到 AI 视图，由 `src/preload/dom/chat-input.js` 的 `lingya-set-setting` 监听写盘。

两处写同样的 `lingya-auto-compact-enabled` / `lingya-auto-compact-threshold`，用户不知道该信哪个；更糟的是「在 A 处改完，B 处的输入框还显示旧值」，看起来像设置没生效。

同时存在一个独立的同步缺陷：判定函数 `checkAutoCompact()` 读的是模块级变量 `autoCompactEnabled` / `autoCompactThresholdWan`，而这两个变量**只在页面加载时**由 `loadAutoCompactConfig()` 赋值一次。侧边栏改设置只写 localStorage、不通知该模块，因此**必须刷新页面才生效**。

## Decision

**自动压缩的配置入口只保留侧边栏设置，悬浮球面板不再提供任何阈值/开关 UI；判定逻辑改为每秒实时读 localStorage。**

- `src/preload/overlay/template.js`：删除「自动压缩」整行（开关复选框、阈值输入框、保存按钮）及配套的 5 条 CSS 规则。悬浮球的「对话 Token」区块只保留计数显示与「压缩」按钮。
- `src/preload/overlay/events.js`：
  - 删除 `loadAutoCompactConfig()`、`saveAutoCompactConfig()` 两个函数与 `autoCompactEnabled`、`autoCompactThresholdWan` 两个模块级变量，以及初始化时的按钮绑定。
  - `checkAutoCompact()` 每次调用从 localStorage 现读 `lingya-auto-compact-enabled` / `lingya-auto-compact-threshold`（后者单位「万」，缺省 80），不再依赖缓存变量。
  - 保留 `autoCompactTriggering` 作为重入锁，其语义不变。
- `src/preload/dom/chat-input.js` 不改：它本就负责把侧边栏的值写入同一份 localStorage 键；由于判定端改为每秒现读，写入后**最长 1 秒内自动生效**，无需额外通知机制。

侧边栏用于回显的 `sh-acen` / `sh-acth` 键（只服务界面显示，非生效值）保持原样，保存时与生效键同写。

## Alternatives considered

**保留 UI 面板的开关，只删阈值输入框和保存按钮** —— 落选原因：开关仍需一个提交动作，而没有保存按钮就无法确认用户意图；若做成 change 即写，则又变成第二个写入口，与「唯一入口」目标冲突。

**保留整行，把阈值输入框改成只读、跟随侧边栏显示** —— 落选原因：只读值必须有人负责刷新，否则会显示过期数据；为一个纯展示元素引入跨模块刷新链路，成本高于收益。

**删 UI 面板，同时保留「加载时缓存一次」的旧判定方式** —— 落选原因：删掉 UI 面板后，用户唯一能改设置的地方就是侧边栏，而旧判定方式需要刷新才生效，等于把「改完没反应」这个体验缺陷从次要路径提升为主路径。

**删除 UI 面板，并在 `chat-input.js` 写入后主动调用一次重载函数** —— 落选原因：需要跨模块导出/引入重载函数，耦合度上升；而 `checkAutoCompact()` 本就挂在每秒的 `setInterval` 上，现读 localStorage 的代价是一次同步取值，可忽略。用现读替代推送，逻辑更简单且没有「漏发通知」的失效面。

**把生效键统一改成侧边栏的 `sh-*` 键，删除 `lingya-auto-compact-*`** —— 落选原因：`lingya-auto-compact-*` 已被判定逻辑与既有用户配置使用，改动键名会让存量用户的配置失效，属于破坏性迁移，且与本次「删除重复入口」的目标无关。

## Consequences

**收益**：

- 配置入口唯一，不存在「改哪一处才生效」的歧义；悬浮球面板更简洁，只留计数与手动压缩。
- 侧边栏保存后最长 1 秒内按新阈值判定，**不再需要刷新页面**，同时修掉了原有的同步缺陷。
- 判定路径不再有模块级缓存，消除了「缓存变量与 localStorage 不一致」这一整类失效模式。

**代价**：

- `checkAutoCompact()` 每秒执行一次 `localStorage.getItem` 两次。localStorage 是同步 API，但取值极小且在既有 1 秒定时器内，实测无感；若未来把轮询频率提高到亚秒级，应改为「写入时派发 CustomEvent + 判定端监听」。
- 判定与配置之间由「显式赋值」变为「隐式读盘」，阅读 `checkAutoCompact()` 的人必须看到函数体内的读取语句才能明白配置来源；已在函数上方注释标明「配置的唯一入口是侧边栏设置」。
- 删除的是 UI 元素而非功能，若后续有人想在悬浮球重新暴露阈值，需要先理解本笔记，避免再次引入双写入口。

## 备注

- UI 删除：`src/preload/overlay/template.js`（Token 区块）
- 判定与配置读取：`src/preload/overlay/events.js` 的 `checkAutoCompact()`
- 侧边栏写盘链路：`src/preload/shell-renderer.js` → `shell-set-setting` → `src/preload/dom/chat-input.js` 的 `lingya-set-setting` 监听
- 轮询入口：`src/preload/overlay/events.js` 的 `startTokenCounter()`（1 秒间隔）
