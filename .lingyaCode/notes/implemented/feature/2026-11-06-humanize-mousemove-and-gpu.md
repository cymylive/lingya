# Agent Note: 拟人化输入/发送 — mousemove 密度与硬件加速

Status: implemented

## Problem

用户的目标是让灵鸦驱动 DeepSeek 网页版时不被平台风控识别。DeepSeek 加载了数美科技的指纹脚本 `chat.deepseek.com/static/fp.min.js`（343KB），上报到 `ishumei.com`。

对 fp.min.js 做了代码级逆向（解混淆后定位到模块 83 的 `getFinalCollectFields` 字段表），确认它采集：

- `nw` / `rg` / `nm`：plugins 指纹、userAgent、platform
- `cdp`：**实为「DevTools 是否打开」检测**（模块 89，Error.stack getter + console.debug）
- `maxTouchPoints` / `connectionRtt` / `cpucount` / `battery` / `incognito`
- 扩展字段 `dy` / `kt` / `xj` / `pd` / `dt` / `fn` / `pw` 等（含 outerWidth/innerWidth/outerHeight/innerHeight）
- **256 个 mousemove 点的 `(x + y) & 0xff`**（预填 crypto 随机字节，逐个覆盖）
- canvas `toDataURL` + 自定义 hash；WebGL `getParameter` + **`toString().includes('[native code]')` 检查**；AudioContext 参数

灵鸦当时的两个具体破绽：

1. **mousemove 密度极低**。实测 `trustedClick` 一次点击产生 10 个 mousemove（贝塞尔轨迹本身是对的），但页面加载后如果用户不操作，一个都没有。fp.min.js 要采满 256 点，按每次操作 10 点算需要 26 次操作——真实用户随便动动鼠标就采满了。
2. **WebGL 渲染器是 SwiftShader**。`src/main/index.js` 无条件调用 `app.disableHardwareAcceleration()` + `app.commandLine.appendSwitch('disable-gpu')`（注释写明是为了修复 Intel 核显的 GPU 驱动崩溃），代价是 WebGL 必然 fallback 到软件渲染，日志里反复出现 `Automatic fallback to software WebGL has been deprecated` 警告。真实 GPU 用户不会是这个值。

## Decision

三项改动，全部基于 fp.min.js 的代码证据，不做无证据的猜测性改造：

**P1 补足 mousemove 轨迹密度**

- `src/main/ipc.js` 新增 `trusted-mouse-move` handler，核心逻辑抽成模块级 `handleTrustedMouseMove(event, args, deps)` 以便单测（deps 可注入 `sleep` / `bezier`）。复用原有 `_bezierPath` / `_lastMousePos`，**只发 `mouseMove` 不发 down/up**，8~15 点，每点间隔 8~30ms。
- 原 `_bezierPath` / `_sleep` / `_lastMousePos` 从 `registerIpcHandlers()` 内部提到模块级，供两个 handler 共用，保证轨迹连续。
- `src/preload/api.js` 暴露 `trustedMouseMove(x, y)`。
- `src/preload/dom/chat-input.js` 新增 `trustedMouseMoveTo(el)`，在 Enter 发送前调用。**点击按钮路径不补**——`trustedClickElement` 已自带贝塞尔轨迹，再补会叠加成异常密集的移动。
- 历史面板新增 `[鼠标轨迹]` 行（点数 / 目标坐标 / 成败），供用户排查。

**P2 硬件加速改为配置项，默认开启**

- `src/main/security-store.js` 的 `DEFAULT_CONFIG` 新增 `disableGpu: false`，在 `updateConfig` 里走严格 boolean 归一化（非 true 一律 false）。
- `src/main/index.js` 原来无条件禁用 GPU，改为读 `security-store.getConfig().disableGpu` 决定。默认走「启用硬件加速」分支，WebGL 渲染器变为真实 GPU；`disableGpu=true` 时保持旧行为（兼容模式），保留 Intel 核显崩溃的逃生通道。
- `src/preload/shell-renderer.js` 在「设置 → 发送延迟」分类下新增「硬件加速」卡片，含兼容模式开关，保存后提示需重启生效。

**P3 输入框聚焦改用真实鼠标点击**

- `setInputContent` 原来的 `input.focus()` 改为：先尝试 `trustedClickElement(input)`（含完整贝塞尔轨迹 + down/up），元素无尺寸或点击失败才 fallback 到 `trustedMouseMoveTo(input)` + `focus()`。
- 顺序上先移鼠标再聚焦，符合真人「鼠标移过去 → 点击」的时序。

## Alternatives considered

**逐字符键入（dispatchKeyEvent 逐键模拟）** —— 落选原因：**数美风控完全不采集键盘指纹**。这是本次最重要的否决项——最初的直觉排序把「输入事件序列」排第一，逆向之后被证据推翻。

三层验证的证据链：

1. **fp.min.js 静态扫描（343KB）**：keydown / keyup / keypress / KeyboardEvent / keyCode / which / beforeinput / compositionstart / compositionend 全部 0 命中。（早先看到的 `charCode` 42 次命中经上下文确认全是 `charCodeAt`；`copy` / `cut` 来自 core-js 版权声明和 OpenSSL kdf。）用 indexOf 逐个枚举出 fp.min.js 的全部 6 处 addEventListener：`DOMContentLoaded` / `readystatechange` / `load` / `mousemove`（及两处 IE `attachEvent` 降级），**无一为键盘事件**。
2. **smcp.min.js（225KB）+ collect-rangers（281KB）**：键盘关键词同样 0 命中。smcp 有一个通用绑定工具 `bindEvent(target, eventType, handler)`，eventType 是变量传入，查调用点的字符串实参只有 `'mousedown'` 和 `'touchstart'`，无任何键盘事件。
3. **运行时 hook 验证**：在页面拦截 `EventTarget.prototype.addEventListener` 并记录所有含 key/input/composition 的注册，结果 6 条记录**全部是 hook 自身安装的**（时间戳相同、target 均为 window）。hook 用合成 keydown 自检返回 `hookWorks: true`，排除漏检。

补充说明：DeepSeek 自己的 `main.js`（1.6MB）确有 12 处 keydown，但逐一看上下文全是业务 UI——输入框的 Enter 发送 / Shift+Enter 换行、图片查看器的 Escape 与方向键导航、Ctrl+J 快捷键、用户活动检测、以及 F12 检测上报 tracker。这些是 DeepSeek 前端自己的交互逻辑，**不进入数美的指纹上报**，与「数美是否采集键盘指纹」是两个不同的问题。

结论：键盘事件序列根本不会离开浏览器，对过数美这套检测零收益，只增加任务耗时。

**override 环境属性（outerWidth / WebGL getParameter / Notification.permission）** —— 落选原因：fp.min.js 模块内明确有 `getParameter.toString().includes('[native code]')` 检查。override 之后 toString 返回值不含 native code，会被打上「被改写」标记，比保留真实异常值更糟。同理 `Object.getOwnPropertyDescriptor` 可查 getter 是否 native。结论：保留 386px 的窗口尺寸差（侧栏导致），不伪造。

**移除 GPU 禁用但不加配置项（直接删两行）** —— 落选原因：注释写明禁用 GPU 是为了修复 Intel 核显驱动崩溃。直接删等于把老 bug 还回去，且没有逃生通道。改为配置项后，默认开启硬件加速，崩溃用户勾选兼容模式即可恢复。

**处理 WebSQL 打开失败（日志中的 `sqlite_open returned null`）** —— 落选原因：该错误来自 fp.min.js 内部的 `window.openDatabase` 探测，用于判断无痕模式。真实 Chrome 用户访问 DeepSeek 也会触发同样的失败（WebSQL 全局已废弃）。这是 fp 的正常降级路径，不是灵鸦独有异常，无法也无需介入。

**`cdp` 字段加固** —— 落选原因：逆向确认该字段检测的是 DevTools 是否打开（Error.stack getter + console.debug），与 Chrome DevTools Protocol 无关。灵鸦的 CDP 只用 Network / Input 域，不碰 console，实测 `stackDebugFlag = 0` 已通过。无需改动。

**延迟分布改对数正态 / 发送方式混用 Enter 与点击** —— 落选原因：没有 fp.min.js 的采集证据支持。属于「听起来更拟人」的猜测性优化，不在有证据的范围内。

**中文 IME 组合态模拟** —— 落选原因：实现复杂（需要构造 compositionstart/update/end 序列），且 fp.min.js 不采集。风险高收益低。

**在页面空闲时持续低频微移动鼠标** —— 落选原因：需要常驻定时器，增加 CPU 开销和「可疑的自动活动」。当前方案（聚焦前 + Enter 发送前补轨迹）在任务型使用下已经足够让 256 点采满。

## Consequences

**收益**：

- DeepSeek 页面上每次操作产生的 mousemove 从「仅点击时 10 点」扩展到「聚焦前 8~15 点 + 点击自带轨迹 + Enter 前 8~15 点」，256 点采样能在正常使用中采满且轨迹连续（共享 `_lastMousePos`）
- 默认启动后 WebGL `UNMASKED_RENDERER_WEBGL` 为真实 GPU，不再是 SwiftShader
- 输入框聚焦产生真实的 mouseMove / mousedown / mouseup，而非纯 JS `focus()`（后者不产生任何鼠标事件）
- 新增 19 个测试用例：security-store 6 条（disableGpu 归一化）、trusted-mouse-move 6 条（参数校验 / 只发 move / 裁剪 / 中途销毁）、chat-input P1 4 条（Enter 路径补轨迹、点击路径不补）、chat-input P3 3 条（点击成功 / 降级 / 无尺寸）
- 受影响模块回归 23/23 通过，6 个改动文件 `node --check` 全部通过

**代价**：

- 每次 Enter 发送前多 8~15 次 `sendInputEvent` + 每点 8~30ms，最坏约 450ms。相比动辄 10~20 秒的发送延迟，占比很小。
- P3 让输入框聚焦多了一次完整的可信点击（含轨迹），约 300~500ms。
- 默认开启硬件加速后，Intel 核显用户可能重新遇到 GPU 驱动崩溃。缓解：设置面板有兼容模式开关，勾选后重启即恢复旧行为。
- 仍无法修补 TLS / Canvas / Audio / 字体枚举 / 386px 窗口尺寸差——这些是 JS 层补丁的能力边界。
- 无法量化「改造后检测率下降多少」：这需要真实账号的 A/B 测试，本次没有条件做，也没有编造数字。

## 备注

- IPC handler：`src/main/ipc.js` 的 `handleTrustedMouseMove`（模块级）+ `trusted-mouse-move` 注册
- preload API：`src/preload/api.js` 的 `trustedMouseMove`
- 输入发送链路：`src/preload/dom/chat-input.js` 的 `trustedMouseMoveTo` / `setInputContent` / `fallbackSend`
- GPU 开关：`src/main/security-store.js`（`disableGpu`）+ `src/main/index.js`（启动分支）+ `src/preload/shell-renderer.js`（设置 UI）
- 规格：`specs/006-humanize-input-send/`（spec.md / plan.md / tasks.md）
- 逆向记录：fp.min.js 模块 83 收集字段表、模块 89 为 DevTools 检测、模块 98 为 webdriver 痕迹检测
- 版本：本次改动随 v0.6.204 一起打包
