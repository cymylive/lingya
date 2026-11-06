# Tasks: 输入/发送拟人化改造（过 DeepSeek 数美风控检测）

**Feature**: 006-humanize-input-send
**Plan**: [plan.md](./plan.md)
**Date**: 2026-11-06

## 依赖图

```
T1 (security-store disableGpu) ──┐
                                  ├──> T2 (index.js 条件禁用 GPU) ──> T6 (UI 开关)
T3 (trusted-mouse-move IPC) ─────┼──> T4 (api.js 暴露) ──> T5 (chat-input P1+P3)
                                  └──> T7 (IPC 测试)
T8 (security-store 测试)
T9 (P3 降级测试)
T10 (P1 不重复测试)
```

## 任务清单

### T1 [P] security-store 新增 disableGpu 字段
- **文件**: `src/main/security-store.js`
- **改动**: `DEFAULT_CONFIG` 加 `disableGpu: false`；`updateConfig` 加 boolean 归一化分支
- **验证**: `node --test test/main/security-store.test.js`（T8）
- **依赖**: 无

### T2 [P] index.js 按配置决定是否禁用 GPU
- **文件**: `src/main/index.js`（2655-2660 行）
- **改动**: 读 `security-store.getConfig().disableGpu`，为 true 才调 `disableHardwareAcceleration` + `disable-gpu`
- **验证**: 启动日志确认 `disableGpu=false` 时无 GPU 禁用；DeepSeek 页面 probe WebGL 渲染器非 SwiftShader
- **依赖**: T1

### T3 [P] 新增 trusted-mouse-move IPC handler
- **文件**: `src/main/ipc.js`（trusted-click 附近）
- **改动**: 新增 handler，复用 `_bezierPath` / `_lastMousePos` / `_sleep`，只发 mouseMove
- **参数**: 坐标校验、webContents 有效性校验、steps=8~15、间隔 8~30ms
- **返回**: `{ success, points }`
- **验证**: T7 单测 + 手动 probe mousemove 事件数
- **依赖**: 无

### T4 [P] api.js 暴露 trustedMouseMove
- **文件**: `src/preload/api.js`（trustedClick 附近）
- **改动**: `trustedMouseMove: (x, y) => ipcRenderer.invoke('trusted-mouse-move', { x, y })`
- **验证**: 无独立测试，随 T5 验证
- **依赖**: T3

### T5 chat-input.js 接入 P1 + P3
- **文件**: `src/preload/dom/chat-input.js`
- **改动**:
  1. 新增 `trustedMouseMoveTo(el)` 辅助函数
  2. `setInputContent`：P3 优先 `trustedClickElement(input)`，失败走 `focus() + trustedMouseMoveTo(input)`
  3. `fallbackSend` 的 Enter 路径前调 `trustedMouseMoveTo(input)`；点击路径不补（trustedClick 已含轨迹）
  4. 历史面板新增 `[鼠标轨迹]` 记录
- **验证**: T9 + T10 单测；手动发消息观察历史面板
- **依赖**: T4

### T6 [P] 设置面板 UI
- **文件**: `src/preload/shell-renderer.js`（发送延迟分类）
- **改动**: 新增「性能」卡片含 `disableGpu` 复选框；回填 + 保存逻辑
- **提示**: 保存后 toast「需重启应用生效」
- **验证**: 手动打开设置，切换开关，重启确认 GPU 状态变化
- **依赖**: T1（配置字段存在）

### T7 [P] trusted-mouse-move IPC 单测
- **文件**: `test/main/ipc-trusted-mouse-move.test.js`（新建）
- **覆盖**: 坐标非法 / webContents 不可用 / 正常路径（mock `sendInputEvent` 计数）
- **验证**: `node --test test/main/ipc-trusted-mouse-move.test.js`
- **依赖**: T3

### T8 [P] security-store disableGpu 单测
- **文件**: `test/main/security-store.test.js`（追加）
- **覆盖**: 缺省值 false / 传 true / 传 'true' 字符串（应归一化为 true）/ 传 1（应归一化为 true）/ 传非 boolean 对象
- **验证**: `node --test test/main/security-store.test.js`
- **依赖**: T1

### T9 [P] P3 聚焦降级单测
- **文件**: `test/preload/chat-input-set-input.test.js`（新建或追加）
- **覆盖**: trustedClick 成功时不调 focus / trustedClick 失败时 fallback focus / 元素无尺寸时跳过点击
- **验证**: `node --test test/preload/chat-input-set-input.test.js`
- **依赖**: T5

### T10 [P] P1 不重复发送单测
- **文件**: `test/preload/chat-input-send-p1.test.js`（新建）
- **覆盖**: Enter 路径前调 trustedMouseMoveTo / 点击路径前不调（避免与 trustedClick 轨迹叠加）
- **验证**: `node --test test/preload/chat-input-send-p1.test.js`
- **依赖**: T5

### T11 全量测试
- **命令**: `npm test`
- **验证**: 1310 + 新增用例全绿
- **依赖**: T1-T10 全部完成

### T12 手动验收
- **步骤**:
  1. 启动应用，打开 DeepSeek 页面
  2. 注入 probe：确认 WebGL 渲染器非 SwiftShader（P2 生效）
  3. 发一条消息：观察输入框聚焦前有鼠标轨迹（P1/P3）
  4. 检查历史面板出现 `[鼠标轨迹]` 行
  5. 设置面板切换 disableGpu，重启确认生效
- **依赖**: T11

## 并行执行建议

- **第一批（可并行）**: T1, T3, T7, T8
- **第二批（依赖第一批）**: T2, T4
- **第三批（依赖第二批）**: T5, T6
- **第四批（依赖 T5）**: T9, T10
- **最后**: T11, T12

## 完成标准

- [ ] T1-T10 全部完成
- [ ] `npm test` 全绿
- [ ] T12 手动验收通过
- [ ] 无顺手改的无关代码（对照 plan.md 文件清单）
