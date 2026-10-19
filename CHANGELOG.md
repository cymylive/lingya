# Changelog

## [0.6.85] - 2026-10-19

### Fixed
- **长对话流式输出卡顿**（严重性能问题）
  - 现象：对话越长越卡，AI 流式输出时页面明显顿挫
  - 根因 1：`page-title-sync.js` 的 MutationObserver 开了 `characterData: true`，AI 每吐一个 token 都触发回调
  - 根因 2：`findPageTitleEl()` 每次用 `querySelectorAll('*')` 遍历整页，对每个叶子节点调 `getBoundingClientRect()` + `getComputedStyle()`（强制同步重排），长对话几万节点 → 每次几十到几百毫秒
  - 根因 3：`deepseek-history-archiver.js` 的 `applyArchivedState()` 每次做 3 次全量 `querySelectorAll`，250ms 防抖后仍频繁执行

### Changed
- **`page-title-sync.js` 四项优化**
  - 去掉 `characterData: true`，只监听 `childList`（标题变化时 React 替换的是节点，不是字符）
  - `findPageTitleEl()` 加元素缓存：命中且位置校验通过就直接返回，不再全量扫描；位置变了自动失效重扫
  - `guardTick` 加 500ms 最小间隔节流（原来 120ms 防抖，流式输出时触发太频繁）
  - 缓存命中时判断 `document.body.contains` 前先检测该方法存在（兼容测试环境的 mock DOM）
- **`deepseek-history-archiver.js` 两项优化**
  - `scheduleRefresh()` 加 2 秒最小刷新间隔（流式输出时不再每 250ms 全量扫一次）
  - `applyArchivedState()` 在没有任何归档记录时提前返回，跳过后续全量扫描

### Notes
- 全量测试 421/421
- **升级提醒**：安装 0.6.85 前请先完全退出旧版进程；便携版 `unpackDirName` 为 `LingYa-runtime-0.6.85`

## [0.6.84] - 2026-10-19

### Fixed
- **数据导出报 `Cannot find module 'archiver'`**（严重）
  - 根因：`src/main/data-management.js` 的导出功能依赖 `archiver`，但它只作为间接依赖存在于 `node_modules`，未在 `package.json` 的 `dependencies` 中声明
  - electron-builder 打包时只包含 `dependencies` 声明的模块，导致安装版运行时找不到 `archiver`
  - 修复：`npm install archiver --save`，正式加入 `dependencies`（`^8.0.0`）
  - 同时确认 `adm-zip`（导入功能依赖）在 `dependencies` 中（`^0.6.1`）

### Notes
- 全量测试 421/421
- **升级提醒**：安装 0.6.84 前请先完全退出旧版进程

## [0.6.83] - 2026-10-19

### Added
- **安装向导新增「选择数据目录」页**（仅安装版，便携版不受影响）
  - 位于「选择安装目录」之后，默认值 `%APPDATA%\lingya-ai-pro-session`
  - 可直接输入路径，或点「浏览…」选文件夹
  - 安装时写入 `<安装目录>\data-location.txt`，主进程启动时读取
  - 通过 `build/installer.nsh` 的 `customPageAfterChangeDir` 宏实现
- **侧边栏「数据目录」管理面板**（侧边栏 → 设置 → 数据目录）
  - 显示当前路径、来源标记（默认/自定义）、体积、文件数
  - 四个按钮：指定位置 / 恢复默认 / 导出数据 / 导入数据
  - 配置写入 `%APPDATA%\lingya-ai-pro-session\data-location.json`（固定位置，切走数据目录后仍可读到）

### Fixed
- **计划监督失效：计划停在 1/5 后不再催促**（严重）
  - 根因：AI 回复中含「需要我继续」「确认后」等词被 `looksLikeUserQuestion` 误判为「向用户提问」，置 `awaitingUserInput = true` 后监督者永久跳过
  - 修复 A：`awaitingUserInput` 超过 **3 分钟**视为误判，清除标志并继续监督
  - 修复 B：`looksLikeUserQuestion` 判定范围从尾部 400 字符收紧到 **150 字符**，关键词精简（长文中提及不再误判）
  - 修复 C：`fab` 状态卡在 `executing`/`generating` 超过 **5 分钟**时强制复位为 `idle` 并继续监督
  - 修复 D：`stallCount` 打满上限后不再永久放弃，改为每 **5 分钟**降频催促一次
  - 附带：计划已完成时同步清除 `awaitingUserInput` 标志

### Changed
- `state.js` 新增 `awaitingUserInputAt`（记录标志置位时刻）
- 启动优先级新增：`<安装目录>\data-location.txt`（安装向导选择），位置在侧边栏配置之后、便携判定之前

### Notes
- 全量测试 421/421
- `looksLikeUserQuestion` 自测 9/9 通过
- **升级提醒**：安装 0.6.83 前请先完全退出旧版进程；便携版 `unpackDirName` 为 `LingYa-runtime-0.6.83`

## [0.6.81] - 2026-10-19

### Changed
- **延迟计算改为每轮独立**（上一版 0.6.78 的「取本轮最长」方案调整）
  - 改前：同一轮 Agent 循环里，所有后续发送都沿用本轮最长耗时 → 10s 深度思考后，即使后续回复只要 3s，延迟仍是 20s
  - 改后：每次只看紧邻的上一次请求往返耗时，不累加、不继承历史最长
  - 示例：AI 回复① 10s → 延迟 20s；AI 回复② 3s → 延迟 6s；AI 回复③ 4s → 延迟 8s
  - 日志改为「本次请求往返 XXXms（含 AI 思考 + 生成回复）× 比例 = YYYms」

### Removed
- 删除 `state.js` 的 `currentRoundMaxThinkMs` / `currentRoundReplyCount`（本轮累加字段）
- 删除 `chat-input.js` 的「用户消息时重置本轮统计」逻辑
- 删除 `intercept-observer.js` 的 `max()` 比较与用户直发时的累加重置

### Notes
- 全量测试 421/421
- 延迟公式仍为：`延迟 = max(兜底延迟, 本次请求往返耗时 × 比例)`，比例默认 0.2、上限默认 60000ms
- **升级提醒**：安装 0.6.81 前请先完全退出旧版进程；本次 `unpackDirName` 为 `LingYa-runtime-0.6.81`

## [0.6.78] - 2026-10-19

### Changed
- **防频率风控方案重构：思考耗时自适应延迟**（替换 v0.6.75 的三层休眠）
  - 新逻辑：`延迟 = max(兜底延迟, min(上次 AI 思考耗时 × 比例, 上限))`
  - 默认：兜底 1000ms、比例 0.2、上限 15000ms
  - 思考 10 秒 → 等 2 秒；思考 30 秒 → 等 6 秒；思考 100 秒 → 15 秒（上限截断）
  - 原理：AI 思考越久说明服务端负载越重，下一条就等越久，天然跟随实际负载

### Removed
- **删除 v0.6.75 的三层休眠方案**（实测无效）
  - 思考节点延迟：`deepseek.js` 的 SSE 流读取节流（服务端看请求频率，不看客户端消费速度）
  - 全局发送间隔锁：`chat-input.js` 的 `globalLastSendTime` 下限（AI 思考本就 10-30 秒，5 秒下限不起作用）
  - Token 阈值休眠：每 20 万 token 强制休眠 3 秒（粒度粗，依赖服务端 token 回报）
- **删除发送延迟设置**（随机 2000-4000ms）：与自适应延迟概念重叠，统一为一套
  - 涉及 `state.js` 的 `sendDelayMin/Max`、`chat-input.js` 的 `randomDelay()`、覆盖层与侧边栏的 UI

### Fixed
- **停止后下次发送被拖满上限**（严重）：用户点「停止」时未重置 `lastRequestStartAt`，导致停止前累积的等待时长被算进下次思考耗时，触发上限截断（默认 15 秒）
- **用户手动发消息时思考耗时测不到**：用户直接在网页输入框发消息不经过 `sendToChat`，`lastRequestStartAt` 保持 0。改为在 `lingya-ai-start` 事件里兜底记录起点
- **日志计算与真实逻辑不一致**：`maxDelay = 0` 时日志返回 0 但实际逻辑不截断，改为与 `computeThinkAdaptiveDelay()` 完全一致
- **`initialSendDelay` 重启丢失**：IPC 能设置但启动时无恢复，已补 localStorage 读取
- **`state.js` 注释随实现漂移**：删除「不低于随机基础延迟」等过时描述

### Added
- `state.js` 新字段：`initialSendDelay`（1000ms 兜底）、`lastThinkMs`、`lastRequestStartAt`、`thinkRatio`（0.2）、`thinkMaxDelay`（15000）
- `chat-input.js` 新函数：`initialDelay()`、`computeThinkAdaptiveDelay()`
- 两处 UI 配置：侧边栏「设置 → 思考耗时自适应延迟」、覆盖层「主页 → 思考耗时自适应延迟」

### Notes
- 全量测试 421/421
- **升级提醒**：安装 0.6.78 前请先完全退出旧版进程；本次 `unpackDirName` 为 `LingYa-runtime-0.6.78`，不会复用旧解压目录

## [0.6.76] - 2026-10-19

### Fixed
- **便携版升级后仍运行旧版本**（严重）
  - 根因：`package.json` 的 `build.portable.unpackDirName` 写死为 `LingYa-runtime-0.6.74`，升版本时未同步
  - 便携版 exe 启动时检查 `%TEMP%\LingYa-runtime-0.6.74\.lingya-ready`，存在则**跳过解压**直接运行旧目录里的程序
  - 表现：装上 v0.6.75，关于页显示 0.6.74，新功能（三层防频繁风控）全部看不到
  - 修复：`unpackDirName` 改为 `LingYa-runtime-0.6.76`

### Changed
- **`scripts/sync-version.js` 自动同步 `unpackDirName`**
  - 从 tag 提取版本号后，一并更新 `build.portable.unpackDirName` 为 `LingYa-runtime-<version>`
  - 打印变更日志，避免以后升版本再次漏改

### Notes
- 全量测试 421/421
- **升级提醒**：安装 0.6.76 前请先完全退出旧版进程，并删除 `%TEMP%\LingYa-runtime-0.6.7{2,3,4,5}` 旧解压目录

## [0.6.75] - 2026-10-19

### Added
- **三层防频繁风控**（解决 DeepSeek 长任务报「消息发送过于频繁」）
  - **思考节点延迟**：主世界 `pump()` 流读取在思考段落换行 / THINK→RESPONSE 切换处停顿，默认 2000ms
    - 延迟的是 `response.clone().body`，网页原生渲染不受影响
    - `getThinkDelay()` 实时读 localStorage，改配置立即生效
    - 新增 `hasThinkNodeInObjects()` 递归检查 BATCH 帧（修复子帧漏判）
  - **全局发送间隔锁**：`sendToChat` 保证任意两条消息发出间隔 ≥ `globalSendInterval`（默认 5000ms），防止工具回传 / 计划续跑 / 兜底续跑多路径同秒连发
  - **Token 阈值休眠**：累计 token 每跨越一个阈值倍数（默认 20 万），该次发送前额外休眠 `tokenSleepDuration`（默认 3000ms）
    - `band = floor(累计token / 阈值)` 机制保证同一区间只触发一次
    - token 累计回落（新对话 / 压缩上下文）时自动重置 band
- **配置入口（两处）**
  - 侧边栏 → 设置 → 「Token 休眠（防频繁风控）」
  - 覆盖层 → 主页 → 「防频繁风控（DeepSeek）」
  - 参数持久化到 localStorage，重启保留

### Changed
- `state.js` 新增 `thinkNodeDelay` / `globalSendInterval` / `tokenSleepThreshold` / `tokenSleepDuration` / `tokenSleepLastBand`

### Notes
- 全量测试 421/421

## [0.6.74] - 2026-10-18

### Fixed
- **工具调用被当成普通文本渲染**：AI 偶尔输出 `<lingya>...</lingya>` XML 标签而非三反引号围栏
  - `js-detector.js` 新增 `extractLingyaTags()`：兼容闭合标签、未闭合标签（取到消息结尾）、大小写不敏感
  - `extractJsToolBlocks()` 合并围栏与标签两种结果并去重
  - 新增 7 个单元测试
- **覆盖层出现一行 `/* ===== */` 裸文本**（`template.js` 的 `OVERLAY_HTML` 数组末尾误留了一行 CSS 注释）
- **AI 调用 openBrowserWindow 抢焦点**：AI 抓网页/注入 JS 时会强制切到新标签
  - `tools/browser-window-manager.js` 的 `activate: true` → `false`
- **主标签标题跨窗口串台**：A 窗口的标题会改到 B 窗口
  - `session-store.syncMainTabTitle(title, targetWin)` 新增 `targetWin` 参数，按窗口反查 ctx 而非用全局「最近活跃窗口」
- **收藏列表 / 主题 / 侧栏设置跨窗口共享**：壳窗口的 `webPreferences` 缺 `partition`，所有窗口共用默认 localStorage
  - 加 `partition: profileData.partition`，按 profile 隔离

### Added
- **标签数量徽章**：`▾` 按钮内显示当前非主标签数量（主标签不计入），0 个时半透明

### Changed
- **下拉列表常驻**：删除标签 / 收藏增删后不再关闭，实时刷新
  - `KEEP_OPEN_ACTIONS` 白名单 + `updateData(新列表)` 回调

### 代码审计修复
- **P1-1** `archiver.stop()` 漏清理：补 `_timer` / click 监听器 / `_bound` / 跨模块标志
- **P1-2** `dropdown-window.close()` 不重置 `_blurGuardUntil`
- **P1-3** `doExport` / `doDelete` 加 `AbortController` 超时（60s / 30s）
- **P2-1** 收藏增删缺 `p.currentList` 时从 localStorage 兜底读
- **P2-2** `_pendingCtx` 加序号，快速右键不再插错菜单项
- **P3-1** `dropdown-window.js` 重复注释
- **TDZ 崩溃**：`_currentType` / `_currentTheme` 声明移到文件顶部
- **blur 误关**：加 800ms `_blurGuardUntil` 保护期

### Notes
- 全量测试 421/421

## [0.6.73] - 2026-10-18

### Added
- **插件系统补齐 preload 执行链**（此前 `ctx.registerPreload()` 只注册不执行）：
  - `src/preload/index.js` 调用 `getPluginPreloads()` → `new Function(script)()` 执行插件脚本
  - **异步执行**：外层 + 每个脚本各一层 `setTimeout(0)`，不阻塞主线程（不影响 supervisor 的 30s 心跳）
  - 单个插件抛错不影响其他插件与主流程
- **`deepseek-archive` 插件**（`plugins/deepseek-archive/`）：
  - DeepSeek 侧栏归档功能打包为可独立安装/卸载的插件
  - 分发版：`deepseek-archive-1.0.0.lingya-plugin.zip`（23.8 KB）
  - 内置版本改为「插件优先」：插件已启用则跳过内置，避免重复注入

### Fixed
- **侧栏视觉撕裂 / 图标闪烁 / checkbox 消失**（5 处根因）：
  1. **checkbox 被 flex 压成 0 宽**：13 处缺 `flex-shrink: 0` → 加全局 `input[type=checkbox]{flex-shrink:0!important;min-width/height:13px}`
  2. **侧栏与 AI view 错位**：`width` transition 180ms 与主进程 `setBounds`（瞬时）不同步 → 移除 transition
  3. **活动栏图标反复重排**：`scrollbar-gutter: stable` + `contain: layout paint`
  4. **子像素重绘锯齿**：`.sh-ab-item` 加 `will-change: background` + `translateZ(0)` + `flex-shrink: 0`
  5. **柔光高光盖到 AI view**：`#lingya-sidebar-slot::before` 改为仅 `.open` 态显示
- **归档模块跨模块重复注入**：`start()` 增加 `window.__lingyaDeepseekArchiveStarted` 检查

### Notes
- 全量测试 414/414
  - 已验证：插件 preload 执行成功、归档菜单注入正常、监督者心跳未受影响

## [0.6.72] - 2026-10-18

### Fixed
- **归档一个置顶会话后，整组置顶会话全部消失**（严重 bug）：
  - 根因：隐藏时用 `anchor.parentElement.style.display = 'none'`，但 `parentElement` 可能是**包含多个会话的置顶组容器**
  - 修复：新增 `findRowElement()` —— 从 anchor 往上走，遇到「包含多个会话的父级」就停，说明上一个才是行容器
  - 改用 `data-lingya-archived-row` 属性 + CSS 隐藏，不再直接改内联样式

### Added
- **归档项「导出对话」按钮**（📥）：
  - 实测 API：`GET /api/v0/chat/history_messages?chat_session_id=<sid>`
  - 解析 `chat_messages[]`：`USER` → `REQUEST`，`ASSISTANT` → `THINK`（折叠）+ `RESPONSE`
  - 生成 Markdown：标题 / 会话 ID / 更新时间 / 消息数 → 每条消息分节，思考过程用 `<details>` 折叠
  - 文件名用**真实会话标题**（不再拼接 sessionId 后缀）
- **归档项「删除对话」按钮**（🗑）：
  - 实测 API：`POST /api/v0/chat_session/delete`，body `{ chat_session_ids: [sid] }`
  - 二次确认（原生 confirm）+ 提示不可恢复
  - 删除成功后：从归档存储移除 + 从 DOM 移除该行

### Changed
- 移除归档区搜索框（用户不需要）

### 过程修复的变量名笔误
- `think.trim()` → `thinks.trim()`
- `resp.trim()` → `resps.trim()`（`resp` 是 fetch 的 Response 对象，不是字符串）

### Notes
- 全量测试 414/414
- CDP 实测：导出 2,087,061 字符 Markdown 成功，文件名 `CTF任务待命.md`
- CDP 实测：删除 API 返回 `biz_code: 0`

## [0.6.71] - 2026-10-18

### Added
- **DeepSeek 原生菜单「归档」项**（真正可用版）：
  - 逆向出真实触发方式：**点会话行的「...」按钮**（不是右键——右键事件虽触发但 React 不响应）
  - 菜单结构：`.ds-floating-position-wrapper > .ds-dropdown-menu[role="menu"] > .ds-dropdown-menu-option`
  - 克隆「分享」项做模板，改 label 为「📦 归档」/「↩ 取消归档」，插入到「删除」之前
  - 实测菜单项：`[重命名, 取消置顶, 分享, 多选, 归档, 删除]`
- **归档区搜索框**：
  - 展开「📦 已归档」后显示搜索输入框
  - 实时过滤（input 事件），匹配标题 + sessionId，大小写不敏感
  - 无匹配时显示「没有匹配的归档会话」
  - 重渲染时保留搜索关键词；展开时自动聚焦

### Changed
- 归档注入模块从「拦截右键 + 自绘菜单」改为「监听 ... 按钮 + 往原生菜单追加项」
  - 好处：复用原生样式，视觉完全一致

### Technical Notes
- 用 CDP（Chrome DevTools Protocol）做全自动验证：`Input.dispatchMouseEvent` 点击 ... 按钮 → 检查菜单项 → 点击归档 → 验证结果
- DeepSeek 的 React 只响应真实用户手势（`isTrusted=true`），右键无法触发菜单；但 `...` 按钮的点击可以
- 原生搜索（侧栏放大镜）搜消息正文，不含已归档会话（符合归档语义）；归档区搜索搜标题，互补

### Notes
- 全量测试 414/414

## [0.6.70] - 2026-10-18

### Added
- **DeepSeek 网页侧栏「对话归档」注入**（对齐 deepseek-pp 的效果）：
  - 新增 `src/preload/dom/deepseek-history-archiver.js`，仅在 DeepSeek 平台启用
  - 在 DeepSeek **自己的侧栏历史列表上方**注入「📦 已归档 (N)」分组（可折叠，折叠状态持久化）
  - **在任意会话行上右键**弹出菜单：「📦 归档此对话」/「↩ 取消归档」
  - 归档的会话从 DeepSeek 原生列表隐藏（`display:none`），不影响服务端数据
  - 归档区里的条目点击可直接跳转到该会话；点「↩」取消归档
  - 数据存在 `localStorage['lingya-ds-archived-sessions']`（`{ [sessionId]: {title, archivedAt} }`）
  - `MutationObserver` 监听 DOM 变化，DeepSeek 列表刷新时自动重新应用隐藏状态

### 技术说明
- **不能复用 DeepSeek 原生右键菜单**：其菜单由 React 控制，合成 `contextmenu` 事件不触发（需要真实用户手势），所以自己绘制浮动菜单
- DOM 锚点：`a[href*="/a/chat/s/"]` → 行容器 → 列表共同父级，注入点精确
- 与 0.6.69 的「LingYa 本地会话归档」相互独立：那个管 LingYa 自己的会话列表，这个管 DeepSeek 网页侧栏

### Notes
- 全量测试 414/414

## [0.6.69] - 2026-10-18

### Added
- **会话归档功能**：
  - `session-store` 条目新增 `archivedAt` 字段（ISO 时间戳；null = 未归档）
  - 新增 `setSessionArchived(sessionId, archived)` + `session-archived-updated` 全窗口广播
  - 新增 IPC `set-session-archived`；`list-sessions` 返回值增加 `archivedAt`
  - 覆盖层「会话」页签 + 侧栏「会话列表」每个会话项新增 **📦 归档** 按钮
  - 已归档会话收进 **📦 已归档 (N)** 折叠区，展开后每项有 **↩ 取消归档** 按钮
  - 折叠状态记在 `localStorage`（覆盖层 `lingya-archived-open` / 侧栏 `lingya-shell-archived-open`）
  - 已归档项视觉降透明度（0.62）以区分

### 设计说明
- 归档只影响 **LingYa 本地会话列表的可见性**，不影响 DeepSeek 网站上的会话（对方没有归档概念）
- 归档不阻止跳转/继续使用；归档的会话仍可通过「已归档」区展开后点「跳转」进入
- 不与现有 `projectDir` 分组冲突：先按当前项目目录过滤，再在结果内分「进行中 / 已归档」两组

### Notes
- 新增 6 个单元测试（normalizeEntry 保留 archivedAt / 旧数据兼容 / 归档写时间戳 / 取消归档置 null / 会话不存在 / 缺 sessionId）
- 全量测试 414/414

## [0.6.68] - 2026-10-18

### Fixed
- **切换对话时顶部主标签标题不跟着变**（一直停留在最开始那个标题）：
  - 根因：`session-store.handleUrlChange` 切会话时只恢复了项目目录，**从不更新主标签标题**；`setMainTabTitle` 只在「改名」时被调用
  - 新增 `session-store.getSessionTitleById(sessionId)`：读某会话的标题
  - 新增 `session-store.syncMainTabTitle(title)`：取主上下文 → 调 `tabManager.setMainTabTitle`
  - `handleUrlChange` 两个分支都接上：
    - 有 sessionId → 用该会话标题；无标题则显示 `会话 <前8位>`
    - 无 sessionId（新会话首页）→ 显示 `新对话`

### Notes
- 新增 4 个单元测试（有标题会话 / 无标题会话 / 新会话首页 / getSessionTitleById）
- 实测 4 个切换场景全部正确，壳页面横向标签同步刷新
- 全量测试 408/408

## [0.6.67] - 2026-10-18

### Added
- **顶部横向标签栏恢复，但只显示主标签**（LingYa 对话）：标题用会话名（`nameConversation` 写入的那个），不跟随网页 `<title>`；点击可切回主标签
- **标签列表下拉**（`▾` 按钮）：垂直展开在按钮正下方，**只列其他网站的标签**（主标签已排除）；可切换/关闭
- **收藏夹下拉**（`★` 按钮）：同一套下拉窗口，支持输入网址+名称添加收藏、点击打开、× 删除；数据存 localStorage `lingya-bookmarks`，重启保留

### Changed
- **主标签标题不再跟随网页标题**：`tab-manager` 里 `page-title-updated` 对 `isMain` 标签直接 return；新增 `setMainTabTitle(ctx, title)`，由 `session-store.notifyTitleUpdated` 在会话改名时调用
- **下拉数据过滤**：主进程 `lingya-dropdown-open` 里 `listTabs(ctx).filter(t => !t.isMain)`

### Fixed
- **下拉面板被 AI 网页遮住**（关键）：AI 网页是 `WebContentsView`（原生层），永远盖在壳页面 HTML 之上，所以在壳页面里画下拉无论怎么调 z-index 都看不见
  - 改为**独立 BrowserWindow 浮层**（`src/main/dropdown-window.js` + `src/ui/dropdown.html` + `src/preload/dropdown-preload.js`）：无边框、透明、置顶、parent 绑定主窗口、失焦自动关闭
  - 按按钮屏幕坐标定位到正下方，超出屏幕边缘自动翻转/贴边
  - 主进程通过 IPC `lingya-dropdown-open/close/action` 协调；收藏增删回传壳页面写 localStorage
- **下拉位置偏上/错位**：壳页面 `getBoundingClientRect()` 返回的是**页面内坐标**，独立窗口需要**屏幕坐标**
  - 修复：主进程 `lingya-dropdown-open` 里加上 `ownerWin.getContentBounds()` 的 x/y 偏移
  - 实测：标签列表 期望 y=134 实际 y=133，收藏夹 期望 y=134 实际 y=133（偏差 1px）

### Notes
- 全量测试 401/401

## [0.6.66] - 2026-10-18

### Fixed
- **点网页里的 target=_blank / window.open 仍弹独立窗口**（如百度「更多」）：
  - 根因：`tab-manager.createTab` 只创建了 `WebContentsView`，**没有注册 `setWindowOpenHandler`** → Electron 走默认行为弹独立 `BrowserWindow`
  - 修复：每个标签创建时注册 `webContents.setWindowOpenHandler`，把 `window.open` / `target=_blank` 统一转成**当前窗口的新标签**，并返回 `{ action: 'deny' }` 阻止 Electron 弹窗
  - `about:blank` 弹窗（有些站点先 open 空窗口再 document.write）无法转标签，直接 deny

### Notes
- 实测百度：触发前后 `tabs 3→4`、`windows 1→1`，新内容全部落在标签页
- 单元测试 14/14（新增 3 个 window.open 拦截用例）
- 全量测试 401/401

## [0.6.65] - 2026-10-18

### Fixed
- **非 AI 平台标签页残留 agent 机制**（0.6.64 只挡了 UI，继续排查并全部隔离）：
  - `init()` 的 `if (!currentProvider) return` 守卫覆盖了全部 agent 逻辑：覆盖层注入、`updateHomeMode` 轮询、`intercept-observer`、`auto-inject`、`feishu-bridge`、`schedule-bridge`、**`supervisor`（监督续跑）**、会话标题同步与 SPA 轮询、`conversation-log`、`overlay-watcher`、用户名轮询
  - 顶层 `chatInput.registerIpcListeners()`（`lingya-set-setting` / `lingya-run-action` / `lingya-insert-to-chat` / `initial-prompt`）与 `toolNames` 也已收进 `if (currentProvider)`
  - 实测百度标签页：`hasLingyaRoot=false`、`lingyaClassCount=0`、`injectedStyleCount=0`、`hasShellAPI=false`、`fetchIsNative=true` → 纯网页
  - `electronAPI` 保留（`injectJS` 等工具需要）
- **退出时报 `Cannot read properties of undefined (reading 'catch')`**：
  - 根因：Electron 33 的 `session.flushStorageData()` 返回 `undefined` 而非 Promise，直接 `.catch` 抛 TypeError
  - 修复：`Promise.resolve(ses.flushStorageData())` 包一层 + 方法存在性检查 + try/catch

### Notes
- 全量测试 398/398

## [0.6.64] - 2026-10-18

### Fixed
- **非 AI 平台标签页（如百度）也显示悬浮球/覆盖层/计划卡**：
  - 根因：`src/preload/index.js` 的 `init()` 无条件执行 `ui.injectCSS()` + `ui.injectOverlay()` + `ui.forceShowOverlay()`，不管当前页面是不是 AI 平台
  - 修复：`init()` 开头加守卫 —— `getProviderByUrl(location.href)` 返回 null（非内置/自定义 AI 平台）时直接 return，不注入任何 UI
  - 同时把 `chatInput.registerIpcListeners()` / `toolNames.refreshToolNames()` 也收进 `if (currentProvider)` 分支，非 AI 页不做无谓注册
  - `electronAPI` 仍照常暴露（`injectJS` 等工具在普通网页标签上继续可用）

### Notes
- 实测：打开百度标签后 `document.getElementById('lingya-root')` 为 null，页面保持原样
- 全量测试 398/398

## [0.6.63] - 2026-10-18

### Fixed
- **标签栏在浅色主题下仍是深黑色**：
  - 根因：`html, body` 背景硬编码 `#0c0e10`（深色），标签栏用的是半透明 `--ck-bg-sub` → 浅色主题下透出深色底
  - 新增主题实色变量：`--ck-bg-solid`（主背景不透明）/ `--ck-bg-bar`（标签栏，深色 `#14181c` 略亮于主背景、浅色 `#f1f3f5` 略暗于主背景，都形成层次）
  - `body` / 侧栏 slot 改用 `--ck-bg-solid`；标签栏改用 `--ck-bg-bar`
  - 地址栏输入框 focus 态背景改用 `--ck-bg-solid`（避免半透明发灰）

### Notes
- 深色/浅色主题实测截图均正确
- 全量测试 398/398

## [0.6.62] - 2026-10-18

### Added
- **浏览器多标签页**（改造自独立窗口模式）：
  - 新增 `src/main/tab-manager.js`：每个窗口内多个 `WebContentsView`，同时只显示一个（active）
  - 新增顶部**标签栏**：标签切换 / 新建（`+`）/ 关闭（`×`，主标签不可关）
  - 新增**地址栏**：后退 / 前进 / 刷新 / 输入网址回车导航（自动补 `https://`）
  - `openBrowserWindow()` 工具改为**优先在当前窗口开标签**，仅当无可用上下文时退化到独立 BrowserWindow
  - `injectJS(windowId, code)` 语义不变，但目标是标签的 webContents
  - 标签标题跟随网页 `page-title-updated`，URL 跟随 `did-navigate`

### Changed
- **窗口结构**：`ctx.view` 始终指向当前活动标签，Proxy 的 `webContents / loadURL / loadFile` 动态解析 → 85 处旧代码零改动
- **布局**：顶部让出 40px（`TABBAR_HEIGHT`），侧栏下移至 y=40
  - `layoutAIView` 遍历所有标签统一 `setBounds`

### Fixed
- 窗口标题被 `shell.html` 的 `<title>` 覆盖成「LingYa Shell」→ `page-title-updated` + `preventDefault()`

### Notes
- 全量测试 398/398（新增 11 个 tab-manager 用例）
- 侧栏对等检查：IPC 108→116、shellAPI 88→97，missing 全空

## [0.6.61] - 2026-10-17

### Added
- **初始化项目后自动 AI 重命名**（不用再手动点）：
  - 新增 `src/preload/dom/auto-rename.js`：`init-project` 成功后等 AI 处理完初始化回复（悬浮球连续 2 次回到 idle），再自动发送重命名指令
  - 触发点统一收口在 `api.js` 的 `initProject()`，覆盖三条路径：手动点「初始化项目」/ 新会话自动注入 / 压缩后自动初始化
  - 去重：`localStorage['lingya-auto-renamed-sessions']` 记录已命名会话（最多保留 300 个）；**任何来源的命名都会标记**（AI 自动命名 / 用户手动改名 / 自动重命名），所以同一会话不会重复触发
  - 超时保护：最多等 3 分钟 AI 空闲，超时放弃并打日志
  - 开关：`localStorage['lingya-auto-rename-enabled']`，**默认开启**，显式设 '0' 关闭；侧栏「设置」→「自动注入」卡片里新增复选框

### Notes
- 全量测试 387/387（新增 8 个 auto-rename 用例）

## [0.6.60] - 2026-10-17

### Fixed
- **会话重命名真正生效到 AI 网页（历史对话列表 + 页面顶部标题）**：
  - 0.6.59 的修复不彻底：只做 DOM 猜测，且页面顶部的定位规则抓错了元素（抓到了 AI 回复里的长文本）
  - **逆向出 DeepSeek 官方改名接口**：`POST /api/v0/chat_session/update_title`，body `{chat_session_id, title}`，鉴权 `Authorization: Bearer <localStorage.userToken.value>`；实测返回 `code: 0` 且服务端持久化（刷新后保留）
  - 实测发现关键问题：**调 API 改了服务端，但 React 状态不更新，UI 不跟着变**；直接改 DOM 生效但不持久
  - 最终方案 = **API 改名（持久化）+ DOM 双写（立即见效）+ MutationObserver 守护（防 React 重渲染改回）**
  - 页面顶部标题定位规则修正为：`top 0~60px`、`left > 150`（跳过侧边栏）、字号 ≥13、排除按钮词表（开启新对话/复制/下载/思考中等）
  - 侧边栏定位：`a[href*="/a/chat/s/<id>"]` 内的叶子 div
  - 非当前会话：只改侧边栏对应项，不动页面标题
  - SPA 路由切换（pushState）时重新应用标题

### Added
- `test/preload/page-title-sync.test.js`：14 个用例，覆盖 sessionId 提取、侧栏/页面标题定位、按钮词排除、旧标题精确匹配、平台识别、API+DOM 双写、非当前会话、API 失败兜底、未登录

### Notes
- 全量测试 379/379（新增 14 个）
- 仅实现 DeepSeek 平台；其他平台走 DOM 兜底（无 API 改名）

## [0.6.59] - 2026-10-17

### Fixed
- **AI 重命名/手动改名后，AI 网页顶部的会话标题不跟着变**：
  - 根因：`nameConversation` / 手动改名只写 LingYa 自己的 `session-store`，完全不碰 AI 网页（DeepSeek/Claude/ChatGPT）自身 UI 里的标题元素，所以用户看到「已重命名为 XXX」但页面顶部还是旧标题
  - 新增 `src/preload/dom/page-title-sync.js`：启发式定位页面顶部标题元素（优先 header 内「字号最大 + 靠上 + 叶子节点 + 短文本」，排除 button/a/input/role=button；找不到 header 时退化为「页面顶部 80px 内的最大字号短文本」）
  - `src/preload/index.js`：订阅 `session-title-updated`，仅当 `payload.sessionId` 与当前页面 URL 提取的 sessionId 一致时才同步，避免改别的会话污染当前页面
  - `src/main/session-store.js`：`notifyTitleUpdated` 额外同步 **Electron 窗口标题**（`rawWin.setTitle('LingYa - ' + title)`），仅作用于「当前会话就是该 sessionId」的窗口

### Notes
- 全量测试 365/365；侧栏对等检查全绿

## [0.6.58] - 2026-10-17

### Added
- **会话手动重命名**（补齐 cuckoo-code 的工作区改名能力）：
  - 覆盖层「会话」页签：每个会话项新增 **改名** 按钮
  - 侧栏「会话列表」面板：每个会话项新增 **改名** 按钮
  - 后端新增 sessionStore.setSessionTitleById(sessionId, title) —— 按 sessionId 改任意会话标题，不要求该会话是当前会话
  - IPC set-session-title 扩展：传 sessionId 改指定会话，不传则改当前会话（向后兼容）
  - session-title-updated 改为**广播给所有窗口**（AI 视图 + 壳窗口），改名后两处列表实时刷新
- **AI 重命名按钮**（长上下文场景：几十万 token 后手动触发 AI 重新总结命名）：
  - 覆盖层「会话」页签头部新增 **🤖 AI 重命名**
  - 侧栏「会话列表」面板头部新增 **AI 重命名**
  - 点击后向 AI 发送提示词：回顾完整上下文 → 提炼核心工作 → 只调一次 nameConversation(title)（≤20 字）
  - 侧栏走 shell-run-action('ai-rename') 通道 → AI 视图的 lingya-run-action 处理器

### Fixed
- **AI 自动命名后列表不刷新**：notifyTitleUpdated 原来只发给主窗口，另一个 webContents 收不到；改为 getAllContexts() 全量广播

### Notes
- 全量测试 365/365

## [0.6.57] - 2026-10-16

### Fixed
- **侧栏计划面板切会话不刷新**（0.6.56 隔离的真正漏点）：
  - 根因：侧栏（shell 窗口）与 AI 视图是**不同的 webContents**，侧栏拿不到 AI 页面 URL → `renderPlanView` 只渲染一次（`rendered[name]` 缓存），切换会话时**没有事件通知侧栏刷新** → 一直显示首次加载的旧会话计划
  - 修复：`session-store.handleUrlChange` 广播 `lingya-session-changed`（发给 AI 视图 + 壳窗口）→ `shell-preload` 暴露 `onSessionChanged` → `renderPlanView` 订阅后重拉

### Notes
- 全量测试 361/361

## [0.6.56] - 2026-10-16

### Fixed
- **切到新会话时仍显示上个会话的计划**（彻底修复会话隔离）：
  - 根因：`resolveSessionId` 在 URL 提取不到 sessionId 时**回退到 `state.currentSessionId`**（仍是上个会话）→ 新会话读到旧会话的 todo
  - 修复：**URL 属于已知平台时以 URL 为准** —— 能提取 sessionId 用它，提取不到（新会话首页）**返回 null**（不回退）；只有拿不到 URL / 非平台 URL 才回退
  - 效果：进入新会话（DeepSeek 首页 /）→ sessionId=null → 计划面板显示"暂无计划"

### Notes
- 全量测试 361/361

## [0.6.55] - 2026-10-16

### Changed
- **计划清单完成后保留**：`todoWrite([])` 空列表被拒绝 —— 已完成的计划保留在面板供回顾（完成项自动加删除线 `text-decoration: line-through`）
  - 如需开始新计划，直接传新的完整列表（替换旧列表）
  - 提示词补充：禁止 AI 用空列表清空计划

### Notes
- 全量测试 361/361

## [0.6.54] - 2026-10-16

### Fixed
- **待办存储未初始化（路径错误）**：`src/main/index.js` 里 `require('../tools/TodoWriteTool')` 路径错误（`src/main/` 下 `../tools` = `src/tools`，不存在）→ init 抛错被 try/catch 吞掉 → `STORE_FILE=null` → **todo 不落盘**
  - 修复：改为 `require('../../tools/TodoWriteTool')`（正确指向 `<root>/tools/`）
  - 这是 0.6.53 计划面板修复的连带 bug（持久化失效）

### Notes
- 全量测试 361/361

## [0.6.53] - 2026-10-16

### Fixed
- **计划面板跨会话串扰 + 完成后仍显示未完成**（彻底修复）：
  - **严格会话隔离**：todo 存储改为 `<userData>/lingya-todos.json`，**只按 sessionId 隔离**，删除"回退到 profileId 键"的泄漏逻辑（此前 A 会话的 todo 会漏到 B 会话）
  - **新建会话临时键 + 迁移**：sessionId 未就绪时存 `pending:<profileId>`，URL 出现后由 `migratePendingTodos` 迁移到真实 sessionId 键
  - **完成即归档**：全 completed 时标记 `archived`，面板显示 **✓ N/N**（绿色），自动续跑**跳过归档会话**（不再误催）
  - **广播带 sessionId**：前端按当前会话过滤，杜绝跨会话串扰
  - **持久化**：todo 落盘，重启保留

### Notes
- 全量测试 361/361
- 烟测：会话隔离 / 归档 / 临时键迁移 / 重启持久化 全部通过

## [0.6.52] - 2026-10-16

### Added
- **自带 Node.js 运行时**：构建时下载 node v20.18.1 到 resources/runtime/，打包进 extraResources
  - `scripts/fetch-runtime.mjs`（优先 npmmirror 镜像）
  - installer 优先用自带 npm（`resources/runtime/<platform>/bin/npm.cmd`），回退系统 → 彻底解决"用户没装 node 就装不了插件"
- **ctx.systemPrompt.section()**：插件注册提示词段，合并进系统提示词（`src/main/dsh/prompt-sections.js`）
- **ctx.fs 服务**：文件服务（resolve/readText/writeText/listDir/editText），`src/main/dsh/fs-service.js`
- **event-bridge**：把 LingYa AI 事件转成 DSH 标准事件广播给插件（`src/main/dsh/event-bridge.js`）

### Notes
- 全量测试 361/361
- 移植自 cuckoo-code 0.8.16 的 DSH 兼容层（3 个 ctx 服务 + 自带运行时）
- exe 体积从 78MB → ~156MB（含 node 运行时）

## [0.6.51] - 2026-10-16

### Added
- **DSH 兼容层扩充 ctx.skills 服务 + agent session.header**：让 skill 类插件也能执行
  - `src/main/dsh/skills-service.js`：ctx.skills（list/get/snapshot，复用 LingYa skill-store）
  - Agent 加 `session.header.cwd`（dsh-tool-skill 依赖）
  - stub 命名导出扩充（isSkillName / assertNever / createUserMessage 等）

### Verified
- **3 个已装 DSH 插件全部可执行**：
  - `dsh-tool-goal`：get_goal / create_goal / update_goal ✅
  - `dsh-tool-web`：web_search / web_fetch ✅
  - `dsh-tool-skill`：skill ✅（运行时接口全通，返回"技能不存在"属正常业务逻辑）

### Notes
- 全量测试 361/361

## [0.6.50] - 2026-10-15

### Fixed
- **DSH 插件市场安装后列表被清空**（关键）：市场里点「安装」后，市场列表整个消失，需手动刷新才重新出现
  - 根因：安装触发 `lingya-tools-changed` 广播 → `mountPluginViews()` 检测到"当前在插件视图"就强制重渲染整个面板 → 市场状态（函数内局部变量 marketItems/marketCat）被重置 → 市场列表清空
  - 修复：市场状态提到**模块级**（dshMarketItems/dshMarketCat），面板重渲染时用缓存**立即重绘**市场列表（不再清空）
  - 附带：市场安装后用返回值里的 plugins 直接刷新已装列表（不再二次异步拉取，避免竞态）

### Notes
- 全量测试 361/361

## [0.6.49] - 2026-10-15

### Added
- **最小 DSH Agent 运行时**：让依赖 agent 生命周期的 DSH 插件（goal 等）**真正能执行**
  - `src/main/dsh/agent-runtime.js`：Agent + AgentRegistry + SessionLog（事件流）
    - `agent.session.events`（turn/start、user/message 等事件）
    - `ctx.agents.get(id)` / `currentInitiator()` / `roots()`
    - `openTurn()` / `closeTurn()`（工具执行时开一个 model turn）
  - `src/main/dsh/goals-service.js`：ctx.goals（get/create/edit/pause/resume/complete/block）
  - loader 在工具执行时注入 `exec.agent`（含真实 agent + turn）

### Verified
- **`@deepseek-ai/dsh-tool-goal` 真正可执行**：
  - `get_goal` → `{"goal":null}` ✅
  - `create_goal` → 创建目标成功 ✅
  - `update_goal` → 更新成功（revision++）✅
- 修复：loader 的 agentRuntime 未正确传给 wrapAsLingYaTool

### Notes
- 全量测试 361/361
- DSH 兼容层能力大幅提升：从"无状态插件"（web/todo）扩展到"agent 生命周期插件"（goal）

## [0.6.48] - 2026-10-15

### Fixed
- **打包版 DSH 插件加载失败（esbuild 二进制路径）**：关键修复
  - 根因：打包后 esbuild 二进制在 `app.asar.unpacked`（真实存在），但 esbuild 去 `app.asar` 内找 → **Electron 不重定向 spawn 的二进制路径** → ENOENT → 所有 DSH 插件加载失败
  - 修复：loader 在打包环境（路径含 app.asar）下自动探测 unpacked 里的 esbuild 二进制，设 `ESBUILD_BINARY_PATH`
  - 多候选路径（require.resolve / __dirname / resourcesPath 上溯）

### Notes
- 全量测试 361/361

## [0.6.47] - 2026-10-15

### Fixed
- **DSH 工具与内置重名 → 改为覆盖（而非跳过）**：装了 DSH 插件就该用它
  - 覆盖时记录被覆盖的内置工具，**卸载插件时自动恢复**
  - 修复：`web_search`/`web_fetch`/`todo_write` 被 DSH 插件覆盖后真正生效

### Verified
- **DSH 插件真正可用（完整验证）**：
  - `@deepseek-ai/dsh-tool-web` → `web_fetch` 抓取 example.com ✅、`web_search` 真实搜索 ✅
  - `@deepseek-ai/dsh-tool-todo` → `todo_write` 更新列表 ✅

### Notes
- 全量测试 361/361
- 已知：`dsh-tool-todo` 的 Config（allowParallelInProgress 必填）解析告警，但不影响工具注册执行

## [0.6.46] - 2026-10-15

### Added
- **DSH 兼容层 `ctx.web` 服务**：实现 `ctx.web.search` / `ctx.web.fetch`（复用 LingYa 的抓取 + Exa/Bing 搜索能力）
  - 让依赖 `ctx.web` 的 DSH 插件（如 `@deepseek-ai/dsh-tool-web`）**真正能执行**，不再返回 stub 空数据

### Verified
- **`@deepseek-ai/dsh-tool-web` 真正可用**：
  - `web_search` → 真实搜索结果（Exa 结构化）
  - `web_fetch` → 真实网页内容（example.com 抓取成功）
- 这是首个**执行也跑通**的 DSH 官方插件

### Fixed
- **DSH 工具与内置工具重名**：改为跳过重名（内置优先），避免卸载 DSH 插件时误删内置工具

### Notes
- 全量测试 361/361

## [0.6.45] - 2026-10-15

### Fixed
- **DSH 插件加载 esbuild 互操作修复**：命名导入（`import { HarnessError } from '@deepseek-ai/dsh-llm'`）拿到 undefined
  - 根因：esbuild 在 `platform=node` 下用 `__toESM`/`__copyProps` 只遍历模块的 **ownKeys**；stub 模块用函数做 Proxy target 时无法提供合规的 `ownKeys`/`getOwnPropertyDescriptor`（函数 target 有 invariant 约束）
  - 修复：stub 模块级 Proxy 改用**普通对象**做 target + 提供 `ownKeys` + `getOwnPropertyDescriptor` trap（覆盖 HarnessError/Context/Service/defineTool 等常见命名导出）
  - 效果：`HarnessError` 等命名导出可正常取到，插件能跑到业务逻辑层

### Known limitations
- DSH 官方工具（goal/todo/subagent 等）依赖 DSH 的 **agent 运行时**（session event log + active turn + driver），LingYa 无此运行时 → **能加载、能注册、AI 可见，但执行时受限于运行时状态**。这是兼容层的本质边界，除非移植整个 dsh-agent 运行时。

### Notes
- 全量测试 361/361

## [0.6.44] - 2026-10-15

### Fixed
- **打包版 DSH 插件安装失败（空壳）根因修复**：开发模式正常、打包后安装不了
  - **根因 1**：双击 exe 运行时 **PATH 里没有 node/npm**（开发时 `npm start` 才有）→ npm.cmd 找不到 → 只写了空壳 package.json
    - 修复：installer 主动探测 node 目录（环境变量 NODE_ROOT/NODE_HOME + PATH + 常见位置 D:\\NodeJS 等），把 node 目录注入子进程 PATH
  - **根因 2**：`asarUnpack` 没解包 esbuild → 打包后 esbuild 二进制无法 spawn
    - 修复：asarUnpack 加 `**/node_modules/esbuild/**` + `**/node_modules/@esbuild/**`
  - **加固**：安装后校验 node_modules 非空；npm 未找到时给出明确指引；UI 加持久安装状态栏（不再只靠短暂 toast）

### Notes
- 全量测试 361/361

## [0.6.43] - 2026-10-15

### Fixed
- **DSH 插件"未加载"根因修复**：npm 安装失败（peer 依赖 404）+ schemastery shim 不完整
  - **installer 加 `--legacy-peer-deps`**：DSH 插件的 peer 依赖（`@deepseek-ai/dsh-*`）多为 workspace 内部包，未发布到 npm → 严格解析 peer 依赖会 404
  - **installer 改用 ComSpec /c** 执行 npm.cmd（避免 shell:true 弃用警告与注入风险）
  - **schemastery shim 重写**：实现真能解析默认值的极简 schemastery（object/number/string/boolean/array/union + default/required/step/min/max 等链式方法 + natural/integer/date 等类型别名）
  - **esbuild CJS 互操作修复**：platform=node 下 __toESM 总是令 default=整个模块 → 把 z 的方法展开到 module.exports 顶层，兼容 `import z from` 默认导入
  - **loader 用插件 Config 解析默认值**：apply 前调 `Config(config)` 合并默认

### Verified
- **官方插件 `@deepseek-ai/dsh-tool-goal` 加载成功**（注册 get_goal / create_goal / update_goal）
- **官方插件 `@deepseek-ai/dsh-tool-web` 加载成功**（注册 web_search / web_fetch）
- `@deepseek-ai/dsh-tool-subagent` 仍失败：依赖未发布的框架内部运行时包 `@deepseek-ai/dsh-subagent`，stub 无法提供其真实函数（本质限制）

### Notes
- 全量测试 361/361

## [0.6.42] - 2026-10-15

### Fixed
- **插件面板看不到 DSH 市场**：`renderPluginsView` 的 `draw()` 在"本地插件为空"时提前 `return`，导致后面的 DSH 外部插件区块 + 市场 HTML 永远不渲染
  - 修复：空插件提示改为拼进 `html` 变量，不提前返回

### Notes
- 全量测试 361/361

## [0.6.41] - 2026-10-15

### Added
- **插件系统（PluginHost）**：LingYa 支持像装 App 一样扩展能力 —— 放文件夹即装、删除即卸、零残留
  - **工具插件**：插件可通过 `ctx.registerTool()` 贡献工具，AI 工具清单自动包含（白名单动态化）
  - **IPC 插件**：`ctx.registerIpc(channel, handler)` 注册自有 IPC 通道，渲染进程用 `pluginInvoke()` 调用
  - **视图插件**：`ctx.registerView({id,icon,label,render})` 贡献侧栏面板；视图统一收进「插件」入口，不单独占活动栏图标
  - **preload 插件**：`ctx.registerPreload(script)` 向 AI 网页注入脚本
  - **依赖声明**：manifest `depends` 支持插件间依赖，拓扑排序加载、检测循环依赖
  - **热重载**：监听插件目录，改代码自动 reload（300ms 防抖），无需重启
  - **导入/导出**：插件打包成 `.lingya-plugin.zip` 分享；零依赖 ZIP 读写（store/deflate + CRC32 + 防路径穿越）
  - **可逆注册**：所有注册返回 disposer，卸载时按逆序回滚，实现零残留
  - 示例插件：`plugins/hello`（工具）、`plugins/demo-panel`（面板+IPC+依赖）
  - 侧栏「🧩 插件」面板：启用开关 / 重载 / 导出 / 删除 / 导入插件包 / 打开目录 / 刷新
  - 随应用播种内置插件到 `<userData>/plugins/`（不覆盖用户已有）
- **插件标准统一（DSH 超集）**：本地插件与 DSH 插件用同一套写法（`export function apply(ctx)` + `ctx.tools.register`），经 esbuild 打包（支持 ESM + `@deepseek-ai/*` import 劫持）
- **DSH 兼容层**：可安装/运行 DeepSeek Harness 生态的 npm 插件（"鸿蒙兼容 Android"思路——自己实现同名 API，不依赖 DSH 代码）
  - `src/main/dsh/`：shim（defineTool 转换 + 万能 stub）、runtime（内存会话+投影）、loader（esbuild 劫持）、paths/state/installer
  - ctx 提供 DSH 标准 API：`ctx.tools.register` / `ctx.settings` / `ctx.sessions` / `ctx.on` 等
- **DSH 插件市场**：从 npm registry 分页拉取**全部 357 个** `@deepseek-ai/dsh*` 包
  - 自动分类（工具 27 / 组合包 7 / 界面 69 / 实验 36 / 服务 218）+ 关键词搜索 + 一键安装
  - 中文描述映射表（覆盖 40+ 官方插件，列表优先显示中文）
- **插件主动发现**：`listPlugins()` 工具（返回可直接调用的工具签名）+ 系统提示词「## 插件能力」注入块，让 AI 主动发现并使用插件
- **AI 自动命名对话**：`nameConversation(title)` 工具，AI 在对话开始时自动命名，会话列表实时刷新（对齐 cuckoo-code）
- **服务端中断自动续跑修复**：服务端"已停止"/流断开时自动续跑，不再"断了就死"
  - 根因：`if (!raw) return` 挡在中断检查之前 → "一开始就断"直接卡死
  - 修复：中断分支提前 + 新增无条件兜底续跑 `continueOnInterruptFallback`

### Fixed
- **服务端已停止导致任务卡死**：中断（`interrupted`）时优先处理，即使回复文本为空也走续跑（三层兜底：自动续写 → 计划续跑 → 无条件兜底）
- **插件配置不持久化**：`ctx.settings.set` 现落盘到插件记录（重启保留）
- **热重载未捕获 promise**：非递归 watch 分支的 reload 加 catch，避免 unhandledRejection
- **死代码清理**：移除废弃的 `bundlePluginSync`（esbuild.buildSync 不支持 plugins）

### Notes
- 借鉴 DeepSeek Harness 的 Cordis 插件思想（可逆副作用、服务上下文、依赖注入），未引入其框架
- 新增依赖 `esbuild`（DSH 兼容层的模块劫持）
- 打包 extraResources 新增 `plugins/`，内置插件随包分发
- 全量测试 361/361 通过
- 全项目审计：语法 0 错误、IPC 107↔107 对齐、preload API 三层对齐、事件对齐

## [0.6.40] - 2026-10-14

### Fixed
- **便携版满屏乱码（根因修复）**：便携版每次启动解压到 %TEMP%\<hash>\，可能解压不完整（缺 resources.pak / chrome_*.pak / locales\*.pak），导致 Blink UA 默认样式表加载失败、所有元素回落到 CSS 初始值，<style> 里的 CSS 被当文本渲染成满屏乱码
  - 症状：窗口显示原始 CSS 源码，页面高度撑到 9 万 px
  - 铁证：运行目录 debug.log 报 resource_bundle.cc Failed to load resources.pak

### Changed
- **便携版解压机制改造（根治乱码）**：portable 模板由"每次启动 RMDir /r 全删再解压、退出后再删"改为"已完整解压则复用"
  - 首启解压 500MB 后写 `.lingya-ready` 标记；之后启动检测到标记直接秒起，不再全量解压
  - 多开时共用同一份已解压目录，杜绝"实例 B 删除实例 A 正在使用的 pak"导致的乱码
  - `unpackDirName` 固定为 `LingYa-runtime-0.6.40`（随版本变化，跨版本不冲突）
  - 退出后保留解压目录（原 RMDir /r 会误删他人正在用的文件）

### Notes
- 便携版（portable）已修复，可放心使用；数据目录仍固定在 <exe目录>\LingYa-Data
- 构建前如执行过 npm install，需先跑 `npm run prep:portable` 重新应用 portable.nsi patch

## [0.6.39] - 2026-10-14

### Added
- **侧边栏功能完整性核对脚本** `npm run check:sidebar`（`scripts/verify-sidebar-parity.js`）：校验 shellAPI 三层、IPC 通道、26 个面板功能点、事件对齐

### Fixed
- **侧边栏设置不持久化**：发送延迟/自动注入/自动压缩保存后重启回默认值
  - 侧边栏设置面板不回显 + localStorage 跨 origin 隔离，改为保存时写侧边栏自己的 localStorage 并在打开时回显
- **点保存无提示**：toast 用 left:50% 落在窗口中间（AI 视图区）被 WebContentsView 盖住，改为侧栏左下角显示

### Notes
- 全量测试 361/361 通过
- 全项目审计：语法/API/IPC/事件/DOM 全对齐

## [0.6.38] - 2026-10-14


### Added
- **隔离实例目录自动清理**：启动时清理超过 7 天的 `instances/auto-*` 目录（多开残留），新增单测

### Fixed
- **点击侧边栏图标无反应**：拖拽 `pointer-events:none` 在 pointerdown 时立即加导致 click 被吞，改为移动超阈值后才加
- **活动栏拖拽不能任意换位**：拖拽元素遮挡 `elementFromPoint`，加 `pointer-events:none` 让检测穿透；并从 DOM 实际顺序持久化（原来被旧 abOrder 还原）
- **设置弹窗 2 栏时不可见**：点齿轮先展开侧栏 + 弹窗位置 clamp 到窗口内
- **启动检测更新失败弹窗**：禁用启动时自动检查更新
- **初始化项目按钮过大**：改小为 `lingya-btn-sm`
- **首次提示浮窗**：整体移除（底部/侧边栏已有初始化按钮）

### Changed
- 清理 2 个废弃事件（`page-loaded`/`session-restored`，无监听方）
- `_shouldQuit`（单实例模式未拿到锁）时提前退出，跳过无用初始化

### Audit
- 全项目审计：103 个 JS 文件语法 0 错误；renderer↔preload / overlay↔api API 缺失 0；IPC 通道 handle↔invoke 无孤儿；事件 11 send/11 on 全对齐；DOM id 无悬空

### Notes
- 全量测试 361/361 通过

## [0.6.37] - 2026-10-14


### Added
- **侧边栏活动栏图标网格 + 拖拽排序**：图标支持 1/2/3 列显示，拖动图标自定义顺序（持久化）
- **活动栏图标小名称标签**（图标下方中文小字，VSCode 风格）
- **底部齿轮设置弹窗**（SVG 图标），内含列数选择 + 拖拽提示
- **悬浮元素可开关**：悬浮球/覆盖层面板/计划悬浮卡可在设置里显示或隐藏

### Fixed
- **侧边栏「任务计划」面板不显示 + 不同步进度**：
  - 根因 1：`resolveSessionId` 用侧边栏（壳窗口）的 sender 解析不出 sessionId → 改为始终用 AI 视图 URL
  - 根因 2：`lingya-todos-updated` 广播只发 AI 视图，壳窗口收不到 → 广播同时发给壳窗口
- **计划长文本撑破卡片**：文字加 min-width:0 + 换行，卡片加 overflow 约束
- **设置弹窗双栏时被活动栏盖住**：left 改 calc(var(--sh-ab-w)+10px) 动态跟随
- **活动栏图标不居中**：emoji 包固定容器 + line-height:1
- **活动栏与面板无缝贴一起**：加实色分隔线 + 投影
- **shell-preload 漏暴露飞书 6 个 API + saveSkill**（群列表静默不加载、技能保存失败）

### Notes
- 全量测试 359/359 通过

## [0.6.36] - 2026-10-14


### Added
- **侧边栏多面板系统（12 面板，功能对等覆盖层）**：
  - 活动栏图标：项目文件 / 任务计划 / 长期记忆 / 技能库 / 安全增强 / 定时任务 / 飞书同步 / 会话列表 / 执行日志 / MCP 工具 / 窗口管理 / 设置
  - 记忆：类型筛选 · 搜索 · 新建/编辑/删除 · 插入/全部插入到聊天 · 导入/导出
  - 技能：搜索 · 新建/编辑/删除 · 启停 · 插入 · 本地导入
  - 安全：全部字段（CTF注入/AI改写/自动续写/停滞监督等）+ 重置 + 立即注入
  - 定时：列表 · 立即执行 · 编辑 · 启停 · 删除 · 新建（每天/每周/cron 三模式）
  - 飞书：连接状态 · 配置 · 5 推送选项 · 群绑定 · 重连/断开/刷新
  - 会话/MCP/窗口：列表 · 跳转 · 启用禁用 · JSON 配置 · 打开/改名/删除
  - 设置：Agent 模式 · 自动压缩 · 生成文档 · 压缩上下文 · 导出对话 · 沉浸式 · 手动解析 · 停止 · 自动注入 · 发送延迟 · 悬浮元素开关
- **5 个跨上下文通道**（侧边栏 ↔ AI 视图）：insert-to-chat / new-chat / run-action / set-setting / report-history
- **活动栏图标 1/2/3 列网格 + 拖拽排序**（自定义列数 + 顺序，持久化）
- **活动栏图标小名称标签**（图标下方中文小字）
- **底部齿轮设置弹窗**（SVG 图标，含列数选择）
- **悬浮元素可开关**：悬浮球/覆盖层面板/计划悬浮卡可在设置里显示或隐藏

### Fixed
- 修复 shell-preload 漏暴露飞书 6 个 API + saveSkill（导致群列表静默不加载、技能保存失败）
- 修复设置弹窗双栏时被活动栏盖住（left 改 calc 动态跟随）
- 修复活动栏图标不居中（emoji 包固定容器 + line-height: 1）
- 侧边栏活动栏加实色分隔线 + 投影（原无缝贴一起）

### Changed
- 侧边栏右缘渐变发光边（与 AI 网页区分）

### Notes
- 全量测试 359/359 通过

## [0.6.35] - 2026-10-14


### Added
- **多实例支持（多开）**：同一个 LingYa.exe 可同时运行多个独立实例
  - 默认允许多开：第二个及后续实例自动使用隔离数据目录 `<数据目录>/instances/auto-<pid>`，互不干扰
  - 具名实例：设环境变量 `LINGYA_INSTANCE=<名>` → 使用固定目录 `<数据目录>/instances/<名>`，配置可持久、可复现
  - 恢复单实例：设环境变量 `LINGYA_SINGLE=1` → 第二次启动直接退出（回到旧行为）
  - `src/main/data-dir.js` 新增 `sanitizeInstanceName()` / `resolveInstanceDir()`（含路径穿越防护）
  - `src/main/index.js`：单实例锁重构 —— 先 setPath 基础目录（锁基于真实数据目录）→ 请求锁 → 未拿到锁则切隔离目录
  - 新增单测 `test/main/data-dir-instance.test.js`（5 用例）
- 全量测试 359/359 通过

## [0.6.34] - 2026-10-14


### Reverted
- **回滚 v0.6.33 的界面视觉重设计**：移除 144 行 CSS 覆盖层（360px 面板、毛玻璃、渐变标题、下划线页签、卡片化区块等），界面恢复 0.6.32 的墨鸦原风格
- 保留 v0.6.32 的功能性改动：工具调用卡片、计划卡片进度条
- 全量测试 354/354 通过

## [0.6.33] - 2026-10-14


### Changed
- **界面整体视觉重设计（仿 DeepSeek Harness 视觉语言）**：
  - 面板加宽 300px → **360px**，最大高度 60vh → 74vh
  - 大圆角（16px）+ 深阴影 + **毛玻璃背景**（backdrop-filter blur + saturate）
  - 标题 **渐变文字**（青碧渐变，background-clip: text）
  - 页签从"块状"改为 **下划线指示器风**（dsh 风格）
  - 所有区块 **卡片化**（每个 section 变独立卡片，圆角 + 边框 + 内边距）
  - 主按钮 **渐变填充**（135deg 青碧渐变），次级按钮 hover 变主色边框
  - 快捷操作网格 hover **上浮 2px** + 主色边框
  - 输入框/选择器统一圆角，focus 时主色边框
  - 滚动条美化（hover 变主色）
  - 全部通过 CSS 覆盖层实现，**不改 HTML 结构、不改元素 id**，零回归风险
- 全量测试 354/354 通过

## [0.6.32] - 2026-10-14


### Added
- **架构决策笔记体系（Agent Note，借鉴 DeepSeek Harness）**：
  - 新建 `.lingyaCode/notes/{proposed,implemented,rejected}/{feature,bug-fix,simplification,architecture,process,testing}/` 三态目录结构
  - `notes/README.md` 规范说明 + `_template.{proposed,implemented,rejected}.md` 三态模板
  - `scripts/check-notes.js` 校验器（纯 Node 零依赖）：校验生命周期/状态一致、类别封闭、`## Problem` 开头、`## Alternatives considered` 必需、文件名格式、implemented 禁提案用语
  - `npm run check:notes` 一键校验
  - 强制「改代码前先想清楚为什么」：非平凡改动必须留下决策笔记（Problem → Decision → Alternatives → Consequences）
- **工具调用卡片（仿 dsh ui-tool）**：
  - `src/preload/overlay/tool-card.js`：`renderToolCard()` + `TOOL_CARD_CSS` + `injectToolCardCSS()`
  - 工具执行结果从纯文本升级为卡片：工具名 + 参数摘要 + 状态徽标（成功/失败/执行中）+ 可折叠输出
  - 接入 `tool-executor.js` 渲染流程，结果区新增 `#lingya-tool-cards` 容器
  - 防 XSS 转义，最多保留 20 张卡片
- **计划卡片进度条**：`plan-panel.js` 加 `progressHtml()`，页签面板和悬浮卡显示完成进度条

### Changed
- `.lingyaCode/LINGYA.md` 新增第十章「协作规范（移植自 DeepSeek Harness）」：改动原则、验证闭环、分层纪律
- `docs/UI-REDESIGN-PLAN.md`：仿 dsh UI 布局改造方案

### Notes
- 借鉴对象：DeepSeek Harness（dsh，TypeScript + React 独立 Web 应用）。dsh 无法直接移植到 LingYa（CommonJS 注入式浮层），仅借鉴其设计语言与工程规范。
- 全量测试 354/354 通过。

## [0.6.30] - 2026-10-12


### Added
- **文件树完整编辑能力**：
  - **新建文件 / 新建文件夹**：目录右键 → 弹输入框 → 创建（名称合法性校验，防路径穿越）
  - **重命名**：文件/目录右键 → 弹框预填原名 → 重命名
  - **编辑文件内容**：预览区新增编辑按钮 → textarea 编辑 → 保存（Ctrl+S）/ 取消（Esc）
    - 首次保存自动生成 `.lingya-bak` 备份
    - 保存后同步更新预览区
- **文件树显示完整项目**：`IGNORE_DIRS` 从 30+ 项收缩到 5 项（仅 `node_modules`/`.git`/`.svn`/`.hg`/`__pycache__`/`venv` 等必然卡死的），`dist`/`build`/`out`/`.vscode` 等现在都显示
  - 实测：项目顶层 457 节点，`dist` 可见，`node_modules` 仍隐藏

### Security
- 所有写操作走统一 `_resolveInProject()`：`realpathSync` 校验目标必须在项目目录内（防越权）
- 文件名校验：拒绝 `.`/`..`/`/`/\\/`:`/`*`/`?`/`"`/`<`/`>`/`|`

## [0.6.29] - 2026-10-12

### Added
- **文件树右键菜单**：右键文件/目录可
  - **复制绝对路径** —— 一键复制完整路径到剪贴板（配合 AI 的 read/edit 工具使用）
  - **移到回收站** —— 删除文件（可恢复，默认）
  - **永久删除** —— 不可恢复（红色警示）
  - 目录只提供「复制绝对路径」（不支持删目录）
  - 主进程侧安全：`realpathSync` 校验必须在项目目录内、禁止删目录根、弹原生确认框（防 renderer 伪造）
  - 新增 IPC `shell-delete-file`（用 Electron `shell.trashItem` 移回收站）/ `shell-copy-text`（`clipboard.writeText`）

## [0.6.28] - 2026-10-12

### Added
- **架构改造：壳窗口 + WebContentsView 双视图**（侧栏与 AI 网页原生分离，对齐 cuckoo-code）
  - `BrowserWindow`（壳）承载左侧栏，`WebContentsView`（AI 网页）独立渲染 —— 两者是**不同的 webContents**，互不干扰
  - 展开侧栏：窗口 +280px + AI view 右移 280px → **AI 可用宽度完全不变**（Electron 实测 1186px 恒定）
  - 新增 `src/ui/shell.html` + `src/preload/shell-preload.js` + `src/preload/shell-renderer.js`
  - `windowState` 新增 `view` 字段 + `getViewWebContents()`；`getContextByWebContents` 同时匹配壳窗口与 AI view
  - 兼容层：`ctx.win` 用 Proxy 代理，`.webContents`/`loadURL`/`loadFile` 自动转发到 AI view，85 处旧调用无需改动
  - 新增 IPC `shell-sidebar-toggle`（按 event.sender 路由，支持多窗口）
- **项目文件树（只读）**：左侧栏浏览当前项目目录并预览文件内容
  - **推挤布局 + 窗口加宽**：展开时窗口宽 +280px，同时给 `body` 加 `padding-left: 280px` —— 侧栏占用**新增空间**，**AI 对话区净宽不变**（1200 → 1480 窗口 / 净宽仍 1200）
  - 新增 IPC `sidebar-resize-window`：主进程负责窗口加宽/收窄，含屏幕工作区边界与最大化保护
  - 交互：点屏幕左边缘的 📁 竖条按钮展开/收起；或按 `Esc`、点侧栏右上角 ×
  - 状态持久化到 `localStorage['lingya-sidebar-open']`，下次打开保持
- **深色 / 浅色主题切换**：主页「快捷操作」新增「主题」按钮（🌙/☀️）
  - 浅色主题用 `html.lingya-theme-light` 覆盖全套 CSS 变量（背景/文字/边框/主色/code 底色等 16 项）
  - 状态持久化到 `localStorage['lingya-theme']`
  - 批量颜色替换为 CSS 变量（40+ 处硬编码色 → `var(--ck-*)`），使主题可整体切换
  - `src/main/file-tree.js`（新增）：递归构建目录树，忽略 `node_modules`/`.git`/`dist`/`venv`/`__pycache__` 等 30+ 目录；节点上限 5000、深度上限 12，超限标记 `truncated`
  - `src/main/ipc.js`：新增 `get-file-tree`（从 `sessionStore.state.selectedProjectDir` 取根目录）与 `read-file-preview`（**路径越权防护**：`realpathSync` 解析后校验必须在项目目录内；限 512KB）
  - `src/preload/overlay/file-tree-panel.js`（新增）：渲染 + 搜索过滤（保留匹配节点及祖先）+ 目录折叠 + 文件预览；40+ 扩展名映射配色（VSCode 风格）
  - `src/preload/overlay/template.js`：新增「文件」页签 + 面板 HTML + 18 条 CSS
  - `src/preload/api.js` / `overlay/events.js`：暴露 API 与事件绑定
  - 只读设计：不支持编辑/新建/删除（改文件仍由 AI 的 `write`/`edit` 工具完成）
  - 未引入 monaco-editor（预览用 `<pre>` 纯文本，避免 +60MB 依赖）

### Removed
- **限流防护整体移除**（0.6.26 引入，按用户要求删除）：悬浮球的「限流冷却中 mm:ss」倒计时不再显示
  - 删除 `src/preload/dom/rate-limiter.js` 及其测试
  - `src/providers/deepseek.js`：删 `dispatchRateLimit()` / `RL_WORDS` / `looksRateLimitedText()` / fetch+XHR 的 429 检测
  - `src/preload/dom/chat-input.js`：删 `rateLimiter` 依赖、`waitMs`/`totalDelay` 叠加、`markSent()`
  - `src/preload/overlay/ui.js`：删 `updateRateLimitUI()` 与冷却状态守卫
  - `src/preload/overlay/template.js`：删 `.lingya-state-cooling` 样式
  - `src/preload/index.js`：删限流防护启动块
  - `src/preload/dom/supervisor.js`：删冷却期跳过判断
  - 对话导出功能不受影响（`dispatchUserMessage` 与 `lingya-user-message` 事件保留）

### Fixed
- **对话导出跨来源重复记录**：同一条用户消息可能同时来自 `onUserMessageSent`（LingYa 发送）与 `lingya-user-message`（hook 从请求体提取），导致导出重复
  - `src/preload/dom/conversation-log.js` 新增 5 秒窗口 + 单向包含去重
  - 关键：只判定「新消息是旧消息的包装版本」（如 旧=`你好`、新=`用户消息：你好`），**不做双向包含** —— 否则「帮我看看代码」与「帮我看看代码里的 bug」会被误判为重复而丢失
  - 新增 5 个测试用例（跨来源去重 / 不同消息不误删 / 短文本不误杀 / 延伸内容不误判）

### Added
- **todo 单项即时同步**：要求 AI 每完成一项就立刻单独调用一次 `todoWrite`，禁止攒批（此前会做完 2-3 项才一起更新，导致计划面板长时间停在同一项）
  - `tools/TodoWriteTool.js` `getPromptSection()` 新增「强制规则二 · 单项即时同步」+ 错误示范 + 正确节奏示例
  - 工具 `description`、`tools/lingya-tools.d.ts`、4 个提示词模板同步强化措辞

## [0.6.26] - 2026-10-12

### Added
- **技能渐进式披露**：修复技能注入的顺序截断问题 —— 原实现按数组顺序拼「name + description + instructions 全文」，超 4000 token 预算即 break，导致装了 119 个技能时 AI 实际只看得见排最前的 2 个（117 个被静默丢弃）
  - `src/main/skill-store.js` `buildSkillSection()` 改为渐进式披露：有本地 SKILL.md 的技能只注入「name + 首句描述 + 路径」，AI 任务相关时用 read 读取全文；无本地文件的内联全文
  - 新增 `firstSentence()`：中文按 。！？ 断句，英文只在 ". " 或行尾断句（避免 e.g./v1.0 被误截）
  - 4 个提示词模板（deepseek/default/chatgpt/claude）「## 技能」章节后加规则：任务相关时**必须先用 read 读 SKILL.md 全文**再执行
  - 实测效果：可见技能 **2 → 119**（全覆盖），注入体积 2716 → 5024 tokens（对比全文注入 248425 tokens 省约 50 倍）
  - 对照测试 10/10 通过
- **导出对话为 Markdown**：会话面板新增「导出对话 (.md)」按钮，把本窗口累积的对话写成 Markdown 文件
  - 背景：LingYa 不持久化对话内容（session-store 只存「会话ID→项目目录」），网页 IndexedDB 也只有 message_id/role 元数据（实测无正文），故只能在运行时累积
  - 新增 `src/preload/dom/conversation-log.js`：三来源累积 —— ① AI 回复（onInterceptedResponse）② LingYa 发送的用户消息（onUserMessageSent，过滤系统消息）③ 用户手动发送（主世界 hook 从请求体提取后派发 `lingya-user-message`）
  - 导出内容含元信息（导出时间/平台/会话链接/会话 ID/项目目录/消息数），AI 回复默认剥离 lingya/js 工具代码块
  - 自动过滤系统消息（自动续写、监督续跑、压缩摘要、工具回传等 20+ 种 tag）
  - 新增 IPC `conversation-export-md`（弹保存框写盘）+ `window.electronAPI.conversationExportMd`
  - 新增 `test/preload/conversation-log.test.js`（12 用例，纯 Node）
- **限流防护（三层）**：恢复丢失的 DeepSeek 限流防护，避免 Agent 循环高频回传触发账号级限流（页面提示「消息发送过于频繁」，冷却约 10 分钟，任务直接卡死）
  - **A 预防**：新增 `src/preload/dom/rate-limiter.js` —— `getWaitMs()` 统一计算需等待时长（冷却剩余 与 自适应最小间隔 取最大值），`sendToChat` 发送前叠加该等待
  - **B 检测**：`src/providers/deepseek.js` 主世界 hook 新增 `dispatchRateLimit()` —— 识别 HTTP 429（fetch/XHR）、4xx 响应体限流关键词，派发 `lingya-ai-ratelimited` 事件；rate-limiter 另用 MutationObserver 监听页面短提示文本兜底（仅发送后 15s 窗口内、文本 ≤120 字符，避免误判 AI 回复正文）
  - **C 恢复**：命中后进入冷却（默认 10 分钟），冷却期内发送自动排队等待，结束自动续跑；最小间隔每次命中 +3s，上限 30s
  - 悬浮球新增 `cooling` 状态 + 每秒倒计时「限流冷却中 mm:ss」
  - 新增 `test/preload/rate-limiter.test.js`（7 用例，纯 Node 不依赖 electron）
  - 限流初始化独立于 `init()` 主 try 块 —— 避免别处抛异常导致限流静默失效
  - 测试：全量 330 通过；Electron 环境实测（事件→冷却→UI 倒计时）通过

## [0.6.25] - 2026-10-12

### Fixed
- **新建窗口源码文本泄漏（"乱码"）**：portable 版运行时解压到 `%TEMP%` 时若 `resources.pak` 加载失败，Chromium UA 样式表丢失，导致 `<style>`/`<script>` 源码被当作可见文本渲染
  - `src/preload/overlay/template.js`：`OVERLAY_CSS` 顶部加 `style, script { display: none !important; }` 作者级兜底
  - `src/ui/platform-select.html`：同步加同规则
  - 已用「隐藏 resources.pak」对照实验验证：无防御时 script 计算样式为 `inline`（文本可见），加防御后为 `none`（正常隐藏）

## [0.6.11] - 2026-10-05

### Added
- **计划（Plan）页签**：新增独立页签，实时渲染 AI 通过 `todoWrite` 维护的任务计划
  - 每项显示序号 + 状态图标（○ 待办 / ◐ 进行中 / ✔ 已完成），已完成项自动置灰加删除线
  - 页签标题带进度角标（如 "3/5"），不展开也能看到当前进度
  - `todoEvents` 变更事件通过 IPC 推送（`lingya-todos-updated`），面板订阅后实时刷新，无需手动刷新
  - 新增 `src/preload/overlay/plan-panel.js`（渲染 + 订阅）与单测 `test/preload/plan-panel.test.js`
  - 新增 API：`window.electronAPI.getTodos()` / `onTodosUpdated(cb)`

### Changed
- `tools/TodoWriteTool.js` 导出 `todoEvents` 与 `getTodos(profileId)`，按 profile 隔离待办列表
- `src/main/ipc.js` 新增 `get-todos` 处理与 `lingya-todos-updated` 广播

## [0.6.10] - 2026-10-04

### Fixed
- **记忆检索看不到"有哪些记忆"**：注入块只给被选中的记忆正文，未选中条目仅以"另有 N 条"抽象数字提示，模型无法联想到具体条目（如"GitHub Token 也在记忆里"）。
  - `buildMemorySection` 现在**始终附带全部记忆索引**（仅 id/类型/名称，不含正文），让模型明确知道有哪些记忆可用
  - 追加判断标准句，绑定到凭证/token/路径/配置等具体场景，提示"先调用 memoryList() 取全文再动手"
  - `MemoryListTool` 检索场景补充"需要凭证/token/密钥/路径/配置/端口/账号时"
  - 4 个提示词模板同步强化措辞

## [0.6.9] - 2026-10-04

### Added
- **便携数据目录**：新增 `src/main/data-dir.js`，便携版（electron-builder 便携版 / exe 旁放 `portable.txt`）数据写入 `<exe目录>/LingYa-Data`，记忆、技能、安全配置、Agent、MCP、profile、登录态全部随程序目录走，换电脑整体拷贝即可
  - 首次便携运行自动从旧 AppData 迁移一次（`LINGYA_NO_MIGRATE` 可禁用）；便携目录已有数据时不覆盖
  - `LINGYA_USER_DATA_DIR` 环境变量可显式指定数据目录
- **`viewImage` 多模态看图**：读取本地图片（png/jpg/jpeg/gif/webp/bmp，≤5MB）并作为附件发送给多模态模型查看
- **后台任务工具** `bashBackground` / `bashOutput` / `bashKill`：长任务（编译、起服务、爬虫、fuzz）后台运行，不阻塞脚本；支持等待完成、查询输出、终止进程树
- **`webFetch` 支持 POST/自定义请求头/请求体**：`webFetch(url, { method, headers, body })`，覆盖 API 调试、认证请求场景
- **`webSearch` 接入 Exa AI**：结构化搜索结果（标题/URL/发布时间/正文高亮片段），无需 API key；Exa 不可用时自动降级 Bing 抓取

### Changed
- **记忆主动检索**：提示词明确"注入的记忆只是子集，不完整"，新增记忆检索规则；`MemoryListTool` 补充 promptSection；`buildMemorySection` 截断时提示"另有 N 条未显示，请主动 memoryList()"

### Fixed
- 修复换电脑/重装后记忆与配置丢失的问题（数据目录跟随程序）

## [0.6.8] - 2026-10-01

### Added
- **飞书 `/say <ID>` 切换会话**：手机可直接切回历史会话继续对话
  - `/list` 现在显示会话 ID 并提示用 `/say` 切换
  - `/say` 支持**完整 ID 或唯一前缀**（手机输入前几位即可）
  - 前缀不唯一时提示候选；找不到时提示用 `/list` 查看
  - 复用 provider 的 `sessionUrlBase` 拼会话 URL 并导航
  - 别名：`/switch`、`/to`


## [0.6.7] - 2026-09-30

### Fixed
- **飞书私聊无响应**：原逻辑用「chat_id 是否为空」区分群/单聊，但飞书**单聊也有 chat_id**，导致私聊消息被当成"未绑定的群消息"丢弃，只能在群里 @ 机器人
  - 改用 `message.chat_type` 区分：`p2p`（单聊）→ 回退最近活跃窗口；`group`（群聊）→ 按 chatId 精确路由到绑定窗口
  - `client.js` 新增 `extractChatType`，事件回调透传 chatType
- **私聊的 AI 回复串到群里**：AI 回复上报时只按"窗口绑定的群"推送，忽略消息来源，导致私聊提问的回复被发到群里
  - 新增来源记录 `lastFeishuSource`（per-profile）：记住最近一条飞书消息的来源（chatId + chatType）
  - `feishu-report` 推送目标改为 `resolveReportTarget`：**优先回来源**（私聊→私聊、群→群），无来源时才回退绑定群

## [0.6.4] - 2026-09-30

### Added
- **`/new` 自动建项目并注入能力**：手机发 `/new` 现在会
  1. 在**桌面新建项目文件夹**（默认名 `LingYa项目_时间戳`，可自定义：`/new 我的项目`）
  2. 导航到平台首页开新会话
  3. 自动注入完整初始化提示词（工具能力 + 项目目录上下文），让新对话**立即具备访问电脑的能力**（读写文件/执行命令/搜索等）

### Fixed
- **飞书斜杠命令在群里失效**：群里 @ 机器人时消息文本含 `@_user_1` 前缀（如 `@_user_1 /new`），导致 `startsWith('/')` 判断失败、命令被当普通文本转发给 AI
  - `extractText` 剥离 `@_user_N` 占位符与 `@机器人名`（依据 `msg.mentions`）
  - `handleFeishuCommand` 增加兜底：剥离行首残留 `@xxx`
  - 接收消息增加内容日志，便于排查

## [0.6.3] - 2026-09-30

### Added
- **飞书斜杠命令**：手机在飞书里可直接控制对话
  - `/new` — 开新对话（导航到当前平台首页，下一条消息进入新会话）
  - `/list` — 列出当前窗口的历史会话（含绑定的项目目录，标记当前会话）
  - `/stop` — 停止当前任务（中断 AI 生成 + kill 工具子进程 + 置停止标志，复用面板「停止」按钮同一逻辑）
  - `/help` — 显示可用指令
  - 命令在 `forwardUserMessage` 转发前拦截，不进入 AI 对话；未识别的 `/xxx` 回提示
  - 实现方式：走 provider 的 `homeUrl` 导航（跨平台通用，不依赖各平台"新对话按钮"选择器）

## [0.6.2] - 2026-09-30

### Added
- **飞书同步（手机收发对话）**：把手机变成 AI 的远程遥控器
  - 推送方向（LingYa → 飞书）：用户经 LingYa 发送的消息、AI 文本回复、工具调用状态（仅"调用中/完成"两条，默认不带工具名/参数/结果）
  - 接收方向（飞书 → LingYa）：手机发文本 → 转发到绑定的窗口 → 发给 AI（等同本机输入）
  - 连接方式：飞书官方 SDK 长连接（无需公网 IP、无需回调地址）
  - 覆盖层新增「📱 飞书」面板：App ID/Secret、启用开关、连接状态、群绑定下拉、推送选项
  - 多窗口路由：每个窗口 profile 可绑定一个飞书群，消息按群精确路由；未绑定的窗口不推送
  - 依赖：`@larksuiteoapi/node-sdk` ^1.74.0

### Changed
- `src/preload/dom/intercept-observer.js` 新增并导出 `onToolCall` / `emitToolCall`（工具调用 start/end 事件）
- `src/preload/dom/chat-input.js` 新增并导出 `onUserMessageSent`（用户消息发出回调）
- `profile-manager.js` profile 结构新增 `feishuChatId` / `feishuChatName` 字段

### Notes
- 飞书功能默认关闭，需在面板配置凭证并绑定群后启用
- 配置存储：`<userData>/feishu.json`

## [0.6.1] - 2026-09-27

### Added
- **自动续写**：DeepSeek 生成中途被中断（“对话已停止”）时，本地自动检测并发送“继续”，无需手动恢复
  - hook 层检测：SSE 流结束/断开时若未收到 FINISHED 状态，或收到 INTERRUPTED/BROKEN/FAILED 状态帧，即判定中断
  - preload 层处理：读安全配置后自动回传续写指令；中断内容不可信，其中的工具调用一律丢弃
  - 防无限循环：连续中断最多自动续写 5 次（2 分钟窗口），用户主动停止时不触发
  - 安全增强面板新增开关「自动续写」+ 可自定义续写指令文本

### Changed
- **发送延迟上限放宽**：`10000ms` → `600000ms`（10 分钟），支持设置 12000-15000ms 等更大间隔
  - template.js 的延迟输入框 max 属性、events.js 的保存校验同步放宽

### Tests
- 新增 test/main/security-store.test.js（6 用例）：自动续写配置默认值、更新、持久化、重置

## [0.6.0] - 2026-09-25

### Added
- **Agent 系统 + Plan/Build 双模式**（移植自 opencode）
  - 内置 build / plan 两个 agent，各有独立权限集与系统提示词 section
  - Home 页新增 Plan/Build 切换按钮，状态按窗口 profile 独立持久化（lingya-agents.json）
  - 系统提示词注入 {{AGENT_SECTION}}，并按当前 agent 过滤工具清单与使用指导
    （plan 模式下 write / edit / deleteFile 不再出现）
- **Plan 模式只读守卫（方案 B）**：拦截 shell 通道的写操作
  - 检测并拒绝：输出重定向（> / >>）、文件增删改（rm/cp/mv/mkdir/del/copy/move...）、
    PowerShell 写 cmdlet（Set-Content/Out-File/Remove-Item...）、git 写操作
    （add/commit/push...）、包安装（npm/pip install）、交互式编辑器等
  - 放行纯只读命令：ls/cat/dir/type/grep/find/git status/log/diff 等
  - 忽略 fd 合并（>&2）、null 设备（>nul）与 cmd 转义（^>）
- 执行层三重防线：工具调用（JsRunner / execute-tool）+ shell（BashTool / PwshTool）
  均按 agent 权限硬拒绝

### Changed
- ToolRegistry.getFormattedJsApiForPrompt / getFormattedPromptSections 支持按排除集过滤
- JsRunner.run 新增 options.deniedTools 与 options.readonlyShell
- 4 个平台提示词模板（deepseek/default/claude/chatgpt）加入 {{AGENT_SECTION}} 占位符

### Tests
- 新增 test/tools/agent.test.js（11 用例）：agent 定义、工具过滤、agent-store 持久化、
  执行层拒绝、只读守卫判定

## [0.5.1] - 2026-09-15

### Fixed
- 修复打包后系统提示词中 ts 代码围栏为空的问题：electron-builder 默认排除
  `*.d.ts` 不进 asar，导致 `tools/lingya-tools.d.ts` 缺失、`{{TOOL_API_TYPES}}`
  被替换为空。改用 `extraResources` 复制到 `resources/tools/`，运行时优先从
  `process.resourcesPath` 读取并回退到源码路径

## [0.5.0] - 2026-09-15

### Fixed
- 修复系统提示词中工具类型定义（lingya-tools.d.ts）注释里的 ``` 反引号破坏 ts 代码围栏的问题

## [0.4.0] - 2026-09-15

### Added
- **上下文压缩（手动 + 自动）**：当对话 token 过大时，生成摘要并只保留最近
  20% 对话，通过 DeepSeek 分享功能在新会话继续
  - 纯 API 实现：读 IndexedDB 全量消息，直接调用分享接口，不依赖 DOM 点击
  - 面板「压缩」按钮手动触发；「自动压缩」可配置阈值（默认 80 万 token）
  - 压缩后自动跳转新会话并初始化项目，末尾追加「请继续你之前的工作」

## [0.3.10] - 2026-09-14

### Fixed
- 修复选择平台时闪退：切换平台会先销毁旧窗口再重建，
  window-all-closed 期间窗口数短暂为 0 导致应用误退出
- 修复 userData 目录不存在时启动崩溃：app.setPath('userData') 前兜底创建目录

## [0.3.9] - 2026-09-14

### Added
- 面板显示 DeepSeek 服务端对话 token（读取 SSE 流的 accumulated_token_usage，
  过万自动简写为 x.xx万）

### Changed
- 彻底移除 DOM 抓取 AI 回复路径，仅保留网络请求拦截
  - 删除 observer / ai-response / detector 等 DOM 抓取模块
  - 抽出工具执行逻辑到 tool-executor，拦截与 DOM 共用
  - 手动解析改为复用拦截缓存文本，不再依赖 DOM
- 注释 provider 中已废弃的 DOM 抓取方法（isResponseComplete / getMessageCandidates /
  getMessageMarkdown / isUserMessage / getCodeBlockLanguage）
- 移除 token 本地估算，仅保留服务端权威数据

## [0.3.8] - 2026-09-11

### Changed
- **DeepSeek / Claude / ChatGPT 三个平台的 AI 回复获取，从 DOM 抓取改为网络请求拦截**
  - 在页面主世界（main world）注入拦截器，被动观察平台自身的 completion SSE 流，
    直接解析回复文本，不再依赖 MutationObserver + DOM 稳定性轮询
  - 仅旁路读取（response.clone / responseText 快照），不修改请求与响应
  - 正文提取区分并排除 THINK / reasoning 片段
  - DeepSeek：解析 response/fragments 的 THINK / RESPONSE 分片
  - Claude：解析 content_block_delta 的 text_delta（忽略 thinking_delta）
  - ChatGPT：解析 /backend-api/f/conversation 的裸 v 追加、patch 批量操作、
    message 快照（仅采纳 assistant）与 message/status 结束信号
  - 工具执行结果回传仍沿用原有模拟输入框发送方式

## [0.3.6] - 2026-09-08

### Fixed
- 添加标准编辑菜单，修复 macOS 无法在 DeepSeek 输入框复制/粘贴的问题

## [0.3.5] - 2026-09-08

### Fixed
- glob/grep 工具打包后 ripgrep ENOENT，通过 asarUnpack 解包二进制并修正运行路径
- 恢复 README 中 Codecov 覆盖率徽章

## [0.3.4] - 2026-09-07

### Fixed
- pwsh 工具改用 execFile，避免管道符被 cmd 预解析导致命令残缺
- 主窗口 UA 改为 Chrome 130 普通标识，避免 DeepSeek 提示隐私风险
- openBrowserWindow 工具窗口同步设置 Chrome 130 UA，不再暴露 Electron 标识
- XML invoke 检测不再要求必须位于文本开头，并避免提示语自触发循环
- 渲染进程可通过 --lingya-user-data 参数加载自定义 Provider

### Added
- Provider 发送扩展接口（provider.triggerSend），支持站点原生发送
- 流式稳定性双通道校验（mutation 快照 + interval 兜底）
- 完成检测兜底轮询（每 2s 主动复查），覆盖后台/最小化漏触发场景
- MCP 工具调用识别（await mcpXxx / log(await xxx））
- 无 pre 的 .md-code 代码容器兜底

### Changed
- 会话 ID 提取与跳转 URL 改为 Provider 方法，不再硬编码 DeepSeek 格式

## [0.3.0] - 2026-09-07

### Added
- 多平台 Provider 框架：支持 DeepSeek 与 Claude，按平台区分输入框/发送按钮/用户信息/消息解析
- 平台选择页：新窗口未指定平台时展示卡片式选择页（含官方品牌 logo）
- 提示词模板化：每平台独立模板，支持 `{{PLATFORM_INFO}}` `{{TOOL_API_TYPES}}` `{{TOOLS_LIST}}` `{{TOOL_SECTIONS}}` `{{PROJECT_DIR}}` `{{PROJECT_INTRO_SECTION}}` `{{MCP_SECTION}}` 占位符
- 自定义 Provider 功能：用户可通过平台选择页导入 JS 文件，支持复制到 userData、重名替换、删除前窗口占用检查
- 自定义 Provider 类型声明与模板：`src/providers/custom/provider.d.ts` + `provider.template.js`
- Provider 方法化：平台差异全部下沉到 Provider 方法（findInput/findSendButton/isResponseComplete/getMessageCandidates 等）
- Claude 自动解析：基于停止按钮边沿触发完成检测，跳过空消息，避免重复触发
- 按平台分文件记录渲染日志到 `wyp/log/{providerId}.log`
- 新增 Provider 单元测试

### Changed
- 系统提示词由单文件改为多平台模板，运行时按 providerId 选择并替换占位符
- 工具 API 类型定义从 `tools/lingya-tools.d.ts` 动态读取，避免多处维护
- 平台 logo 从首字母占位改为官方 SVG

### Fixed
- Claude 自动解析重复触发/漏触发问题
- 多个 `{{PROJECT_DIR}}` 占位符只替换第一个的问题
- 导入自定义 Provider 后源文件被删导致失效的问题

---

## [0.2.5-beta.1] - 2026-09-02

### Added
- 新增 MCP（Model Context Protocol）按需查询能力
  - mcpListServers() 查看已配置的 MCP server（名称/类型/状态/工具数/工具名）
  - mcpGetTools(serverName) 查看指定 server 的工具详情（描述+参数）
  - mcpCall(server, tool, args) 调用 MCP 工具
- MCP 启动时自动连接已启用的 server，初始化项目时等待连接（8 秒超时）
- MCP 配置保存前完整 JSON 结构校验（错误时明确提示且不覆盖输入）
- MCP 配置保存后弹确认框，由用户决定是否通知 AI（避免打断 AI 操作）
- showConfirmDialog 扩展支持确认/取消双按钮 + Promise 返回（向后兼容）
- 新增 McpCallTool、McpQueryTools 单元测试

### Changed
- MCP 提示词改为按需查看模式，不再全量注入工具列表（节省 token）
- MCP 保存后的自动通知改为简短格式，引导 AI 按需查询
- 移除 .lingyaCode/LINGYA.md 作为全局项目介绍（避免干扰其他项目场景）

### Fixed
- 修复 connectEnabledServers 从未被调用导致 MCP 启动后未连接的问题
- 修复 initProject 同步逻辑中 MCP 连接时序竞态（改为 async + 等待）

---

## [0.2.0] - 2026-08-27

### Breaking Changes
- 主进程重构：main.js 拆分为 src/main/ 模块（应用生命周期、IPC、项目上下文、会话存储分离）
- preload 重构：preload.js 拆分为 src/preload/ 模块（DOM 监测、overlay UI、工具解析分离）
- 移除 MySQLTool.js（已无维护，提示词中不再暴露）
- 移除旧版工具桥接实现（ToolBridge.js、UnifiedToolManager.js、WebContentCapturer.js）
- bash/pwsh 不再强制要求 description 参数（改为可选）

### Added
- 新增 5 个对标 dsh 的工具实现：
  - read（offset/limit 分段读取，替代 readFile）
  - write（全量覆盖，替代 writeFile）
  - edit（精确替换，替代 editFile）
  - glob（ripgrep 引擎，替代旧 GlobTool）
  - grep（ripgrep JSON 输出，替代旧 GrepTool）
- 新增 todoWrite 工具（全量任务列表，对标 dsh todo_write）
- 新增 pwsh 工具（PowerShell 执行，对标 dsh tool-pwsh）
- 新增 webFetch 工具（HTML 转 Markdown，对标 dsh web_fetch）
- 新增 openBrowserWindow / injectJS 工具（打开调试窗口并注入 JS）
- 工具系统支持 section 机制（对标 dsh systemPrompt.section），每个工具有独立的 prompt section
- 系统提示词全面改版：中文 dsh 风格 + 动态平台检测（Windows/macOS/Linux）
- 发送延迟可配置（UI 设置 + localStorage 持久化）
- UI 全面改版：悬浮球模式（48px 右下角 FAB + 小面板），不再占用全高侧边栏
- 跨平台启动脚本 start.js（Windows/macOS/Linux 通用）
- 完整单元测试覆盖（tools / main / preload）

### Changed
- package.json start 脚本改为 node start.js（修复 macOS chcp: command not found）
- start.js 自动根据平台选择 UTF-8 编码设置
- 工具返回格式统一为 dsh 风格（纯文本 envelope / marker）
- 错误提示统一为英文 dsh 风格
- package.json 增加 allowScripts 配置（npm 新版本 electron postinstall 被阻止问题）

### Fixed
- edit 工具 CRLF 适配（LF 的 old_string 能匹配 CRLF 文件）
- bash/pwsh 非零退出不再报错，改用 [exit code: N] 标记
- glob 路径去掉 ./ 前缀
- Windows 平台信息动态生成（不再硬编码）
- Electron postinstall 被 npm allowScripts 阻止导致二进制缺失的问题
- JS 脚本无输出时提示使用 log()

### Security
- bash/pwsh 危险命令黑名单保留（Windows + PowerShell 特有命令）
- 命令执行超时限制保持 30 秒
- 输出缓冲 1MB 限制保持

### Dependencies
- 新增 @vscode/ripgrep（glob/grep 底层引擎）
- 新增 turndown + @joplin/turndown-plugin-gfm（webFetch HTML 转 Markdown）

---

## [1.0.0] - 2026-08-11

### Added
- 初始版本发布
- Electron 桌面应用，嵌入 DeepSeek 网页版
- 自动检测 AI 回复中的 cmd/powershell 代码块，弹窗确认后执行
- 工具调用系统：支持 file_write、file_read、file_edit、file_glob、file_grep、bash、file_delete 等工具
- 会话级项目目录绑定，工具操作以项目目录为基础
- 侧边覆盖层面板，显示命令预览、执行结果和历史记录
- Ctrl+Shift+C 快捷键切换覆盖层
- 项目初始化功能，自动生成目录树并注入系统提示词
- 支持危险命令检测与额外警告
- 会话持久化（cookies/localStorage 保存到 %APPDATA%/lingya-session）

### Security
- 命令执行前必须用户确认
- 危险命令（rm -rf /、format、shutdown 等）触发额外警告
- 30 秒命令执行超时限制
- 1MB 命令输出缓冲区限制


