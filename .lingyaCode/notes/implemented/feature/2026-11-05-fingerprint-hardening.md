# Agent Note: 浏览器指纹伪装的四项加固

Status: implemented

## Problem

灵鸦在 `src/main/user-agent.js` 用 JS 层补丁伪装浏览器指纹（UA / Client Hints / navigator.userAgentData / window.chrome / permissions / Notification），但存在四个可被检测的破绽：

1. **getter 的 toString 暴露补丁痕迹**：`Object.defineProperty(navigator, "webdriver", { get: function() { return false; } })` 之后，`navigator.webdriver.toString()` 返回 `"function(){return false;}"`，而真实浏览器返回 `"function get webdriver() { [native code] }"`。CreepJS / FingerprintJS Pro 都直接检查这一项。
2. **OS 段硬编码 Windows**：`buildChromeUserAgent()` / `buildUserAgentDataFix()` / `buildClientHintsHeaders()` 三处写死 `Windows`。在 macOS / Linux 上运行时，会出现「Chrome 130 + Windows UA + macOS platform」的自相矛盾组合。
3. **鼠标点击瞬移**：`trusted-click` handler 在同一坐标连续发 `mouseMove` / `mouseDown` / `mouseUp`，没有移动轨迹，行为特征明显。
4. **（误判）chrome.loadTimes 被怀疑多余**：原以为新版 Chrome 已移除该成员，删除它可以消除破绽。

目标是在**不更换 Chromium 内核**的前提下（Electron 无法替换预编译内核），修补 JS 层能修补的部分。

## Decision

四项改动，全部集中在 JS 层，不改 IPC 协议、不改主流程：

- **P1-b getter toString 修复**：新增 `buildNativeMask()`，注入主世界且**最先执行**。它保存原始 `Function.prototype.toString`，用 `WeakMap` 记录被 patch 的函数到伪造标签的映射，改写 `Function.prototype.toString` 优先查 `WeakMap`；并把改写后的 toString 自身也标记为 native，防止 `toString.toString()` 二次暴露。通过 `Symbol.for("lyNativeMask")` 暴露 `mark()` 句柄（Symbol 不可枚举，不污染 `Object.keys`）。`buildUserAgentDataFix()` 中的 `userAgentData` / `webdriver` getter 改为命名函数并调用 `mark()`。
- **P2-b OS 段动态生成**：新增 `detectOS()`，按 `process.platform` + `process.arch` 返回 `{ uaSegment, platform, arch, bitness, mobile }`，覆盖 win32(x64/ia32/arm64) / darwin(arm64/x64) / linux(x64/arm64)，未知平台回退 Windows x64。三个 build 函数统一调用它，替换所有硬编码。
- **P2-a chrome.loadTimes 保留**：**核验后决定不改**。用 Chrome headless 实测 `Object.keys(window.chrome)` 返回 `["loadTimes","csi","app"]`，`loadTimes` 仍是 function。真 Chrome 有这个成员，删掉反而是新破绽。新增测试断言守护，防止未来被误删。
- **P3 贝塞尔点击**：`trusted-click` handler 引入 `_bezierPath(x0,y0,x1,y1,steps)`（二次贝塞尔，控制点沿垂直方向随机偏移 10-40% 距离，每点 ±1px 抖动）、`_sleep()`、以及模块级 `_lastMousePos: Map<webContentsId, {x,y}>`。首次点击从窗口中心起算，之后从上次位置起算；距离 < 5px 时直接走终点；沿途 8-15 个中间点，每点间隔 8-28ms 随机；终点精确 move → down → up。

注入顺序很关键：`buildNativeMask()` 必须在 `src/preload/index.js` 的 `fixes` 数组**首位**，否则后续 fix 调用 `mark()` 时 `lyNativeMask` 句柄还不存在。

## Alternatives considered

**改 Chromium C++ 内核（参照 CloakBrowser 的 71 个源码级补丁）** —— 落选原因：Electron 使用预编译的 Chromium，无法替换内核。fork electron 并重编译的成本是当前项目体量的数倍，而收益只覆盖 TLS / Canvas / WebGL 这几个窄场景。架构上不可行。

**引入 CloakBrowser 或 playwright-stealth 等第三方库** —— 落选原因：CloakBrowser 是给 Playwright/Puppeteer 用的独立浏览器进程，无法嵌入 Electron 的 `BrowserWindow`；playwright-stealth 是外挂 JS 注入，与项目现有的注入机制重叠且会引入新依赖与新破绽。

**P2-a 直接删除 chrome.loadTimes** —— 落选原因：核验发现真 Chrome 仍有该成员。删除会使灵鸦的 `window.chrome` 比真实浏览器少一个键，反而更容易被 `Object.keys` 对比识别。

**P1-a 输入分片（逐字打字）** —— 落选原因：用户明确表示不需要。输入仍走 CDP `Input.insertText` 一次性插入，虽然行为特征上「秒填」不像人，但目标平台（DeepSeek/ChatGPT/Claude 网页版）很少检查输入节奏。

**直接改写 Function.prototype.toString 而不做二级标记** —— 落选原因：只改一层时 `Function.prototype.toString.toString()` 会返回 `"function(){...}"`，暴露「toString 本身被改过」。必须连这一层也包，否则 CreepJS 一眼看穿。

**给 permissions 映射表做完整版本适配** —— 落选原因：Chrome 每个版本对 permissions 的默认策略都在变（例如 MIDI 在 124+ 无手势时返回 denied），硬编码表注定随版本失配。本次不扩大范围，留作后续。

## Consequences

**收益**：

- `navigator.webdriver.toString()` 返回 `"function get webdriver() { [native code] }"`，且 `toString.toString()` 也不再暴露
- macOS / Linux 上 UA 与 `navigator.userAgentData.platform` 不再自相矛盾
- 点击有轨迹、有节奏，能过基础行为检测
- 新增 8 条测试（`test/main/user-agent-fingerprint.test.js`）锁定四项行为，其中一条专门守护「不得删除 loadTimes」
- 全量测试 1266/1267 通过（唯一失败是改造前就存在的 redaction-store 导入校验问题，与本次无关）

**代价**：

- `Function.prototype.toString` 被改写后，所有依赖真实 toString 行为的库都会受影响。缓解：`WeakMap` 未命中的函数回落原生 toString，只有显式 `mark()` 过的才被伪造。但如果某个库用 `toString.call(fn)` 或 `Reflect.apply` 绕过，仍能看到原始行为。
- P3 每次点击增加约 8-15 次 `sendInputEvent` + 每点 8-28ms 延迟，最坏约 420ms。用户可感知，但在可接受范围。
- 首次点击从窗口中心起算，视觉上「鼠标从中心飞来」。符合人类首次移动鼠标的常见行为，不违和。
- 仍无法修补 TLS / Canvas / WebGL / Audio / 字体枚举——这些需要内核级改造，是 JS 层补丁的能力边界。
- OS 段动态化后，如果目标平台对特定 OS 的 UA 有白名单规则（例如某些站点只对 Windows UA 放行），跨平台行为可能不一致。需要三平台回归验证。

## 备注

- 指纹逻辑：`src/main/user-agent.js`（`detectOS` / `buildNativeMask` / 三个 build 函数）
- 注入顺序：`src/preload/index.js` 的 `fixes` 数组，`nativeMask` 在首位
- 贝塞尔点击：`src/main/ipc.js` 的 `trusted-click` handler + `_bezierPath` / `_sleep` / `_lastMousePos`
- 测试：`test/main/user-agent-fingerprint.test.js`（8 条）
- 备份：三个被改文件均有 `.bak-fingerprint-20261105` 副本（本机 git 不可用时的回滚手段）
