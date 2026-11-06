# Feature Specification: 输入/发送拟人化改造（过 DeepSeek 数美风控检测）

**Feature Branch**: `006-humanize-input-send`
**Created**: 2026-11-06
**Status**: Draft
**Input**: 用户要求「lingya 模拟人工输入框输入和发送，强化 lingya 在 dom 下的拟人化，目标是过 DeepSeek 平台检测」

## 背景与依据

DeepSeek 加载了数美科技（shumei）风控脚本 `chat.deepseek.com/static/fp.min.js`（343KB）。经代码级逆向确认，该脚本采集以下指纹并上报到 `ishumei.com`：

| 采集项 | 实现位置 | lingya 当前状态 | 证据强度 |
|---|---|---|---|
| `mousemove` 轨迹 256 点 | `addEventListener('mousemove')`，每点 `(x+y)&0xff` | 仅点击时约 10 点/次 | 强（代码明确） |
| WebGL 渲染器 | `getParameter(UNMASKED_RENDERER_WEBGL)` + `toString().includes('[native code]')` 检查 | **SwiftShader（软件渲染）** | 强（代码 + 实测） |
| canvas 指纹 | `toDataURL()` + 自定义 hash | 正常生成 | 强 |
| audio 指纹 | `AudioContext` 的 sampleRate/maxChannelCount 等 | 正常生成 | 强 |
| plugins 指纹 | `navigator.plugins` 遍历 | 正常生成 | 强 |
| `cdp` 字段 | Error.stack getter + `console.debug`（检测 DevTools 是否打开） | 返回 0（通过） | 强 |
| `webdriver` / Phantom 痕迹 | 遍历 `__webdriver_evaluate` 等属性 | 未命中 | 强 |
| 窗口尺寸差 | `outerWidth - innerWidth > 170` | 386（侧栏导致） | 强 |
| 无痕模式 | WebSQL `openDatabase` 失败判定 | 失败（真实 Chrome 也失败） | 强 |

**关键结论**：
1. fp.min.js **不采集键盘事件**（已全文扫描确认 `keydown`/`keyup`/`keypress` 均无）→ 逐字符键入对过检测无直接收益
2. fp.min.js 有 WebGL `getParameter.toString()` native 检查 → **override 环境属性会被抓，是负收益**
3. lingya 的 CDP（`Network` / `Input` 域）不触发 `cdp` 字段（该字段实为 DevTools 检测）

## 用户故事（按优先级）

### P1：补足 mousemove 轨迹密度（最高优先级）
作为 lingya 用户，我希望在页面上的鼠标活动密度接近真人，使 fp.min.js 的 256 点 mousemove 采集能在正常使用中采满且轨迹分布自然，从而不因「mousemove 为 0 或极少」被识别为自动化环境。

**验收标准**：
- 输入框聚焦前，从当前鼠标位置到输入框中心产生一组 `mouseMove` 事件（不 down/up），约 8~15 点，间隔 8~30ms 随机
- 发送前若走点击按钮路径，已有贝塞尔轨迹（保持现状）
- 所有产生的 `mouseMove` 事件 `isTrusted === true`
- 不改变 `trustedClick` 现有的贝塞尔逻辑（它已工作正常，实测 10 点/次）

### P2：恢复硬件加速（WebGL 指纹修复）
作为 lingya 用户，我希望 WebGL 渲染器指纹是真实 GPU 而非 SwiftShader，从而与真实浏览器用户一致。

**验收标准**：
- 新增配置项 `disableGpu`（默认 false，即默认启用硬件加速）
- 配置为 true 时保持当前行为（`disableHardwareAcceleration` + `disable-gpu`）
- 配置为 false 时不调用上述两个禁用 API
- 配置持久化到 `lingya-security.json` 或新建 `lingya-performance.json`
- 侧栏提供开关（位置见 clarify）

### P3：输入框聚焦用真实鼠标点击
作为 lingya 用户，我希望输入框聚焦是通过真实鼠标点击完成的，而不是 JS 的 `input.focus()`，从而在聚焦时也产生 mousemove 事件。

**验收标准**：
- `setInputContent` 中 `input.focus()` 改为先尝试 `trustedClickElement(input)`，失败再 fallback 到 `focus()`
- 点击聚焦产生的 mousemove 与 P1 的轨迹合并，不重复发
- 失败时记 warn 日志，不阻断输入

## 边界场景

1. **非 AI 平台页面**（如普通网页标签）：不注入任何鼠标模拟逻辑（与现有 `currentProvider` 判断一致）
2. **Plan 模式**：只读守卫不影响鼠标模拟（鼠标移动不是写操作）
3. **多窗口**：鼠标事件只发到触发窗口的 `webContents`，不跨窗口
4. **用户停止任务**：`state.stopped` 为 true 时，P1/P3 的鼠标模拟应跳过
5. **页面重渲染**：输入框短暂消失时，P3 的点击聚焦失败应 fallback 到 `focus()`，不抛异常
6. **GPU 崩溃**：P2 开启硬件加速后若发生 GPU 崩溃，用户可通过配置项手动关闭

## 非功能需求

- **性能**：P1 的鼠标轨迹总耗时 ≤ 500ms/次（8~15 点 × 8~30ms），不显著拖慢任务
- **兼容性**：不改变现有 `trustedClick` / `trustedKey` / `trustedInsertText` 的调用签名
- **可观测性**：P1/P3 的鼠标模拟记入历史面板（新增 `[鼠标轨迹]` 行）
- **测试**：新增逻辑必须有单测覆盖（宪法 III）

## 明确不做的事

1. **不做逐字符键入**：fp.min.js 不采集键盘，无直接收益，只增加耗时
2. **不 override 任何环境属性**（`outerWidth` / WebGL `getParameter` / `Notification.permission`）：有 `toString().includes('[native code]')` 检查，override 会被抓
3. **不处理 WebSQL 失败**：真实 Chrome 同样失败，属正常降级
4. **不做中文 IME 组合态模拟**：风险高，且 fp.min.js 不采集
5. **不做打错字再修正**：噪音大于收益
6. **不改延迟分布**（均匀→对数正态）：无证据支持，本次不做
7. **不改发送方式**（Enter/点击混用）：无证据支持，本次不做
8. **不处理 `hif-dliq` 解析失败**：网络层问题，非 lingya 可控
