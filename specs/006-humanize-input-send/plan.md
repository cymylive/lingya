# Implementation Plan: 输入/发送拟人化改造（过 DeepSeek 数美风控检测）

**Feature**: 006-humanize-input-send
**Spec**: [spec.md](./spec.md)
**Date**: 2026-11-06

## Summary

三项拟人化改造，全部基于 fp.min.js 代码级证据：
1. **P1** 补足 mousemove 轨迹密度（输入前 + 发送前），复用现有 `_bezierPath` 逻辑，新增只发 `mouseMove` 的 IPC
2. **P2** 硬件加速恢复为默认开启（配置开关 `disableGpu` 默认 false），修复 WebGL SwiftShader 指纹
3. **P3** 输入框聚焦改用 `trustedClickElement`，失败 fallback `focus()`

## Technical Context

- **语言**: JavaScript (CommonJS)
- **框架**: Electron 33 / Chromium 130
- **涉及层**: 主进程（IPC handler / 启动参数）、preload（输入发送链路）
- **测试**: Node 内置 `node --test`（当前 1310 用例）
- **配置存储**: 复用 `src/main/security-store.js`（`lingya-security.json`）新增 `disableGpu` 字段

## Constitution Check

| 原则 | 本方案如何满足 |
|---|---|
| **I. 外科手术式修改** | 只动 3 个文件（`index.js` / `ipc.js` / `chat-input.js`）+ 1 个 store（security-store.js）+ 1 个 UI 文件（shell-renderer.js）。不改 `trustedClick` 现有贝塞尔逻辑，只新增并行路径。 |
| **II. 先思考后编码** | spec + plan + tasks 已出，等用户批准后才 implement |
| **III. 验证闭环与 TDD** | 每个 P 项先写测试（Red）再实现（Green）。P2 需测 security-store 的 `disableGpu` 归一化；P1/P3 需测主进程 IPC handler 的入参校验与降级路径 |
| **IV. 架构分层与沙箱安全** | 鼠标事件仍在主进程 `wc.sendInputEvent` 注入（不引入页面级合成事件）；preload 通过 `window.electronAPI` 调主进程 |
| **V. 零 Token 成本与扩展性** | 不引入任何 API 调用，不新增 NPM 依赖 |

## 文件改动清单

| 文件 | 改动 | 行数估计 |
|---|---|---|
| `src/main/security-store.js` | `DEFAULT_CONFIG` 新增 `disableGpu: false`；`updateConfig` 允许该字段（boolean） | +10 |
| `src/main/index.js` | 2658-2660 行改为条件判断：读 `security-store.getConfig().disableGpu` 决定是否禁用 GPU | +8 / -3 |
| `src/main/ipc.js` | 新增 IPC handler `trusted-mouse-move`，复用 `_bezierPath` / `_lastMousePos` / `_sleep`，只发 `mouseMove` 不发 down/up | +40 |
| `src/preload/api.js` | 暴露 `trustedMouseMove(x, y)` | +3 |
| `src/preload/dom/chat-input.js` | P3: `setInputContent` 的 `input.focus()` 改为先 `trustedClickElement(input)`；P1: 在 `doSendToChat` 的 `triggerSend` 前调 `trustedMouseMoveTo` 补轨迹 | +50 |
| `src/preload/shell-renderer.js` | 「设置 → 发送延迟」分类新增「性能」卡片，含 `disableGpu` 开关，走 `updateSecurityConfig` | +30 |
| `test/main/security-store.test.js` | 新增 `disableGpu` 归一化测试 | +20 |
| `test/main/ipc-trusted-mouse-move.test.js` | 新增 IPC handler 单测（坐标校验、降级路径） | +60 |

## 详细设计

### P1: mousemove 轨迹密度

**主进程新增 IPC handler**（`src/main/ipc.js`）：

```js
ipcMain.handle('trusted-mouse-move', async (event, args) => {
  // 校验坐标与 webContents
  // 复用 _lastMousePos 作为起点（与 trusted-click 共享）
  // _bezierPath(start, target, steps=8~15)
  // 只发 mouseMove，每点间隔 8~30ms 随机
  // 更新 _lastMousePos
  // 返回 { success: true, points: N }
});
```

**preload 调用**（`src/preload/dom/chat-input.js`）：
- 新增 `async function trustedMouseMoveTo(el)`：计算 el 中心坐标，调 `window.electronAPI.trustedMouseMove(x, y)`
- 在 `setInputContent` 的 `input.focus()` 之前调用
- 在 `doSendToChat` 的 `triggerSend` 之前，若走 `trustedClick` 路径（即 `fallbackSend` 的按钮点击分支），先调 `trustedMouseMoveTo(btn)`（注意：此处与 trustedClick 的贝塞尔轨迹会叠加，需去重——trustedClick 内部已有轨迹，所以发送前的 P1 只对「Enter 路径」补轨迹，点击路径不补）
- 修正：**发送前的 P1 只补「非点击路径」**（即 Enter 发送）。点击路径的 `trustedClick` 已自带轨迹，不重复。

**关键参数**：
- 轨迹点数：8~15（`8 + Math.floor(Math.random() * 8)`）
- 点间隔：8~30ms（`8 + Math.floor(Math.random() * 22)`）
- 总耗时：64~450ms
- 加 ±1px 抖动（与 `trustedClick` 一致）

### P2: 硬件加速开关

**security-store 新增字段**：

```js
const DEFAULT_CONFIG = {
  // ... 现有字段
  disableGpu: false,  // 默认开启硬件加速
};
```

**updateConfig 归一化**：

```js
if (key === 'disableGpu') {
  next[key] = patch[key] === true;  // 严格 boolean
  continue;
}
```

**index.js 启动参数**：

```js
// 2658-2660 行改为
let disableGpu = false;
try {
  const secStore = require('./security-store');
  disableGpu = !!secStore.getConfig().disableGpu;
} catch (_) { disableGpu = false; }
if (disableGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
```

**注意时序**：security-store 在 197 行已 init，2658 行读取是安全的。

**UI**（`shell-renderer.js`）：在「发送延迟」分类下新增一张「性能」卡片：

```html
<div class="sh-card">
  <div class="ly-set-field">
    <label class="ly-set-toggle">
      <input type="checkbox" id="sh-set-disable-gpu" />
      <span>禁用硬件加速（兼容模式）</span>
    </label>
    <div class="ly-set-desc">
      勾选后使用软件渲染，修复部分 Intel 核显的 GPU 崩溃问题；
      取消勾选则启用硬件加速（WebGL 指纹更接近真实用户）。
    </div>
  </div>
</div>
```

保存逻辑：读 `window.shellAPI.getSecurityConfig()` 回填，保存调 `window.shellAPI.updateSecurityConfig({ disableGpu })`，提示「需重启应用生效」。

### P3: 输入框真实点击聚焦

**`setInputContent` 改造**：

```js
async function setInputContent(input, msg) {
  // ...
  // 原：try { input.focus(); } catch (_) {}
  // 新：
  let focused = false;
  if (input && typeof input.getBoundingClientRect === 'function') {
    const r = input.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      focused = await trustedClickElement(input);  // 内部有贝塞尔轨迹 + mousedown/up
    }
  }
  if (!focused) {
    try { input.focus(); } catch (_) {}
  }
  // ... 后续 trustedInsertText
}
```

**注意**：P3 的 `trustedClickElement` 已自带完整轨迹，**不需要再调 P1 的 `trustedMouseMoveTo`**。所以 P1 和 P3 在输入框聚焦这一动作上互斥：P3 优先（真实点击），P3 失败才走 P1（只移动不点击）+ `focus()`。

## 数据流

```
【输入前】
setInputContent(input, msg)
  ├─ P3: trustedClickElement(input)  // 真实点击，含 8~15 点 mousemove + down/up
  │    └─ 失败 → focus() + P1: trustedMouseMoveTo(input)  // 只移动不点击
  ├─ selectAllContent(input)
  └─ trustedInsertText(msg)

【发送前】
doSendToChat → triggerSend(input)
  ├─ fallbackSend 的 Enter 路径：P1: trustedMouseMoveTo(input)  // 补轨迹
  └─ fallbackSend 的点击路径：trustedClickElement(btn)  // 已含轨迹，不补 P1
```

## 测试策略

| 测试 | 文件 | 覆盖点 |
|---|---|---|
| security-store disableGpu 归一化 | `test/main/security-store.test.js` | 缺省 false / 传 true / 传非 boolean 降级 |
| trusted-mouse-move IPC | `test/main/ipc-trusted-mouse-move.test.js` | 坐标校验 / webContents 不可用 / 正常路径（mock `_bezierPath`） |
| P3 聚焦降级 | `test/preload/chat-input-set-input.test.js` | trustedClick 失败时 fallback focus()；元素无尺寸时跳过点击 |
| P1 不重复发送 | `test/preload/chat-input-send-p1.test.js` | Enter 路径补轨迹；点击路径不补 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| P2 默认开启硬件加速后 Intel 核显崩溃 | 用户可在设置中勾选「禁用硬件加速」；崩溃后重启勾选即可 |
| P1 轨迹总耗时 450ms 拖慢任务 | 参数可调；默认 8~15 点 / 8~30ms，总耗时 ≤ 450ms |
| P3 点击聚焦失败导致输入失败 | 失败 fallback `focus()`，不阻断输入；记 warn 日志 |
| 多窗口时鼠标事件发错窗口 | 只发到 `event.sender` 的 webContents（与现有 trustedClick 一致） |

## 完成定义

- [ ] 三项改动全部实现
- [ ] `npm test` 全绿（1310 + 新增用例）
- [ ] 手动验证：DeepSeek 页面发一条消息，确认 WebGL 渲染器不再是 SwiftShader、mousemove 事件密度明显提升
- [ ] 设置面板开关可切换，重启后生效
