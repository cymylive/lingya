# Agent Note: token 用量按会话隔离并持久化，显示不再串味也不归零

Status: implemented

## Problem

悬浮球上的「对话 Token」数字和自动压缩的阈值判定，读的都是 `state.serverTokenUsage` 这一个**全局单字段**：

- 写入：`src/preload/dom/intercept-observer.js` 的响应回调里 `state.serverTokenUsage = detail.tokenUsage;`
- 读取：`src/preload/overlay/events.js` 的 `updateConversationTokenDisplay()`（每秒刷新显示）与 `checkAutoCompact()`（阈值判定）

数据源本身是正确的：`src/providers/deepseek.js` 的 `captureTokenUsage()` 抓的是响应体里的 `accumulated_token_usage`，这是 DeepSeek 按**当前会话**给出的累计值。问题出在存储层——把「会话级数据」塞进了「进程级单例字段」。

这导致两个叠加的缺陷：

**缺陷一：切换会话串味。** DeepSeek 是 SPA，切换会话不重新加载页面，`state` 不会重置。切到会话 B 后，B 还没产生任何响应，`state.serverTokenUsage` 里仍然是 A 的值，于是悬浮球在 B 会话里显示 A 的 token 数；更严重的是 `checkAutoCompact()` 也会用 A 的 token 数去和 B 的阈值比较，可能误触发自动迁移，把 B 的上下文搬走。

**缺陷二：重启应用归零。** 即使按会话缓存到内存 Map（`serverTokenUsageBySession`），进程退出 Map 就没了。用户实测：会话 A 的 token 显示 8w，完全关闭 LingYa 再打开，同一对话显示 0，要等下一轮 AI 响应才恢复。

这与仓库里已记录过的 `2026-10-26-abort-flag-session-scoped-isolation.md` 是同一类缺陷：**会话级状态被错误地做成了进程级单例**。缺陷二是这个错误的延伸——不仅进程内不该共享，进程重启后也不该丢。

## Decision

两层改造：内存按会话缓存 + localStorage 持久化。

**第一层：内存按会话缓存。** 新增 `state.serverTokenUsageBySession`（`sessionId → tokenUsage` 的普通对象），写入时双写，切换会话时搬运。

- `src/preload/dom/state.js`：在 `serverTokenUsage` 之后新增 `serverTokenUsageBySession: {}`。`serverTokenUsage` 的语义**保持不变**，仍是「当前会话的显示值」，因此 `events.js` 的两个读取函数零改动。
- `src/preload/dom/intercept-observer.js` 的响应回调：在原有 `state.serverTokenUsage = detail.tokenUsage` 之后，同时写入 `state.serverTokenUsageBySession[sid] = detail.tokenUsage`。
- `src/preload/dom/intercept-observer.js` 的 `watchSessionForStateReset().check()`：在更新 `state.currentSessionId` 之后，执行 `state.serverTokenUsage = state.serverTokenUsageBySession[sid] || null`。

**第二层：localStorage 持久化。** 整个缓存 Map 序列化成一个键 `lingya-token-by-session`，启动时读回、写入时落盘、删会话时清理。

- `src/preload/dom/intercept-observer.js` 顶部：新增 `TOKEN_CACHE_KEY`、`loadTokenCache()`、`saveTokenCache(map)` 三个定义。`loadTokenCache()` 逐条校验 `accumulatedTokens` 必须是 number，脏数据一律丢弃；`saveTokenCache()` 用 try/catch 包裹，配额超限/隐私模式时**静默降级为仅内存生效**，绝不让持久化失败影响主流程。
- `startInterceptObserver()` 开头：`state.serverTokenUsageBySession = loadTokenCache()`，**并立即按当前 URL 解析 sid、把该会话的缓存值搬运到 `state.serverTokenUsage`**。只加载 Map 不搬运是不够的——见下方关键细节 4。
- 响应回调写入内存 Map 之后：`saveTokenCache(state.serverTokenUsageBySession)`。
- `src/preload/dom/deepseek-history-archiver.js`：新增 `clearTokenCacheForSession(sessionId)`，接入 `doDelete`（真删）和 `deleteSessionSilent`（迁移时删旧会话）两个真实删除入口。**归档（`doArchive`）不清理**——归档可以取消，清掉会导致取消归档后显示 0。

四个关键细节：

1. **写入时用 URL 解析 sid，不用 `state.currentSessionId`。** 后者由 800ms 轮询更新，若刚发完请求就切换会话，存在最多 800ms 的时序窗口，会把 A 的 token 误记到 B 的键上。`provider.extractSessionId(window.location.href)` 是同步取值，与请求时刻一致。
2. **首页/新会话用 `'__home__'` 作为键。** `readSid()` 在首页返回 `null`，若直接用 `null` 做键会被转成字符串 `'null'`，且与「真的取不到 sid」无法区分；显式命名避免歧义。
3. **没有缓存时置 `null` 而非保留旧值。** 第一次进入该会话、或持久化被降级后尚未响应时，悬浮球显示 0，等下一次响应自动填充——**显示 0 好过显示别的会话的数字**。
4. **启动加载缓存后必须立即搬运一次，不能只填 Map。** `watchSessionForStateReset` 的 `check()` 有 `if (sid === lastSid) return` 的短路：启动时 `lastSid` 被初始化为当前 URL 的 sid，若页面直接停在某个会话上（而不是先落首页再跳），`check()` 永远不会触发，`state.serverTokenUsage` 会一直保持 `null`。此时即使 `loadTokenCache()` 已把 A=8w 读进 Map，悬浮球仍显示 0——**用户实测的「重开归零」正是这个路径**。所以启动块里必须显式执行一次 `state.serverTokenUsage = cached[当前sid] || null`。只加载不搬运，持久化等于白做一半。

## Alternatives considered

**持久化采用「每会话一个 localStorage 键」（`lingya-token-<sid>`）。** 落选原因：要遍历 `Object.keys(localStorage)` 找前缀，清理孤儿键更麻烦，键名不受控。当前写入只在收到 AI 响应时发生（每轮一次），全量序列化的开销可忽略；集中一个键也便于排查。若未来会话数达到数千导致序列化成为瓶颈，再改成分键不迟。

**持久化采用 IndexedDB。** 落选原因：IndexedDB 是异步 API，而 `checkAutoCompact()` 现在是每秒同步读 `state.serverTokenUsage`，改成异步要动 overlay 层的判定时序，改动面远超收益。localStorage 的同步读取与现有「内存即读」的模型天然契合。

**持久化写入做节流（照搬 `task-state.js` 的 500ms 节流）。** 落选原因：`task-state.js` 节流是因为它写入频繁（状态机每次转换都写）。token 写入频率是「每轮对话一次」，远低于节流阈值，直接写即可，不必引入节流复杂度。

**启动时按会话列表对账，清理孤儿键。** 落选原因：会话列表通过 `window.electronAPI.listSessions()` 异步获取，不适合在启动的同步路径里对账；而且「删除时同步清理」已经覆盖了主要的泄漏源。若未来发现仍有孤儿键残留（如异常退出导致删除中断），可在启动后异步补一次对账。

**改读取端，让 `events.js` 的两个函数自己去查 Map。** 落选原因：`updateConversationTokenDisplay()` 与 `checkAutoCompact()` 都要改成 `state.serverTokenUsageBySession[state.currentSessionId || '__home__']`，两处重复、且把「会话键的构造规则」泄漏到 overlay 层。保持 `serverTokenUsage` 作为「当前值」的语义，让隔离完全发生在 dom 层内部，读取方无感知，改动面更小。

**切换会话时清空 `serverTokenUsage`，切回来等新响应重新填。** 落选原因：切回一个有历史的会话时，悬浮球会先归零，直到该会话产生新响应才恢复，用户看到的是「回来数字没了又冒出来」。缓存方案切回来立刻是正确值。

**在 `check()` 里直接调用 `updateConversationTokenDisplay()` 立刻刷新显示。** 落选原因：该函数是 `overlay/events.js` 的私有函数，未导出；`intercept-observer.js` 属于 `dom` 层，跨层调用会让 dom 反向依赖 overlay。用 `try/catch` 包住只会静默吞掉 ReferenceError，看起来改成了实际没生效。显示刷新交给既有的 1 秒定时器，最多 1 秒延迟可接受。

## Consequences

**收益**：

- 每个会话的 token 显示互相独立，切换会话后悬浮球立即反映目标会话的值（有缓存时）或归零（无缓存时），不再显示上一个会话的数字。
- **关闭并重新打开 LingYa 后，历史会话的 token 直接恢复显示**，不必等新响应。这解决了用户实测反馈的「重开归零」问题。
- `checkAutoCompact()` 的阈值判定跟着隔离，消除了「用 A 的 token 数判定 B 是否该迁移」的误触发路径。
- `events.js` 零改动，读取方语义不变，后续改动不需要关心隔离实现。

**代价**：

- **持久化引入 localStorage 生命周期管理**：会话删除时必须同步清理对应键，否则缓存无限增长。已在 `doDelete` 和 `deleteSessionSilent` 两处接入清理，但这是「靠人记得」的约定，新增删除入口时容易漏。理论上可以在 `loadTokenCache()` 里加 TTL（如 90 天未更新的键自动丢弃）作为兜底，当前未做。
- **删除当前会话时需同时归零显示字段**：`clearTokenCacheForSession()` 除删除缓存键外，还要判断 `state.currentSessionId === sessionId`，是则 `state.serverTokenUsage = null`。否则删掉正在看的会话后，悬浮球会保留已删会话的数字，直到下一次会话切换触发 `check()` 才覆盖。这个分支同样被 `try/catch` 包裹，漏了不会报错——只能靠人工验证。
- **配额超限会静默降级**：`saveTokenCache()` 失败时只写内存，用户不会收到任何提示，重启后表现为「又归零了」。这是显式选择的取舍——持久化是锦上添花，不能反过来用 Toast 打扰正常使用。排查这类问题时可看控制台有无 `[LingYa][Token]` 日志。
- **多实例共享 localStorage**：LingYa 支持多开，localStorage 按浏览器 profile 隔离而非按进程。两个实例操作同一会话时会以最后写入为准。不同会话互不干扰（键不同），当前场景下可接受。
- 「当前值」与「缓存」两份数据需要在写入和切换两处保持同步，且**两处都有 `try/catch` 包裹，出错时不抛异常、不会让测试变红**——只能靠人工验证发现。这一点已在本笔记中显式记录，修改相关代码时必须同时检查这两个写入点。
- 内存 Map 只增不减（除非会话被删除）。每个会话约几百字节，普通使用规模下可忽略；长期不重启且打开成百上千个会话时理论上有缓慢增长，随持久化清理一并缓解。

## 备注

- 状态字段：`src/preload/dom/state.js` 的 `serverTokenUsageBySession`
- 持久化键：`localStorage['lingya-token-by-session']`（`TOKEN_CACHE_KEY`）
- 持久化函数：`src/preload/dom/intercept-observer.js` 的 `loadTokenCache()`、`saveTokenCache()`
- 启动恢复 + 搬运：`startInterceptObserver()` 开头（先 `loadTokenCache()` 填 Map，再按当前 URL 把目标会话的值搬到 `serverTokenUsage`）
- 写入点：`src/preload/dom/intercept-observer.js` 响应回调中的 `if (detail.tokenUsage)` 分支
- 切换搬运点：`src/preload/dom/intercept-observer.js` 的 `watchSessionForStateReset().check()`
- 删除清理：`src/preload/dom/deepseek-history-archiver.js` 的 `clearTokenCacheForSession()`，接入 `doDelete` 与 `deleteSessionSilent`；除删缓存键外，若 `currentSessionId === sessionId` 同步置 `serverTokenUsage = null`
- 读取方（未改动）：`src/preload/overlay/events.js` 的 `updateConversationTokenDisplay()`、`checkAutoCompact()`
- 数据来源：`src/providers/deepseek.js` 的 `captureTokenUsage()`，字段 `accumulated_token_usage`
- 同类前例：`.lingyaCode/notes/implemented/bug-fix/2026-10-26-abort-flag-session-scoped-isolation.md`
