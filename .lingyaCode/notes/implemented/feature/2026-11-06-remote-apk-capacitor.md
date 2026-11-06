# Agent Note: Capacitor APK 打包与移动端 UI 适配

Status: implemented

## Problem
虽然有 PWA，但安卓用户希望有原生 App 体验（如通知、更顺畅的操作、独立图标）。直接用 Android 原生重写代价太大，且与已有的 PWA 逻辑脱节。此外，在 WebView 中，不同安卓手机的状态栏高度不一致，经常遮挡 PWA 顶部栏，导致无法点击。

## Decision
1. 使用 **Capacitor** 将 PWA 直接包装为 Android 壳。`webDir` 指向 `src/main/remote/pwa`，实现同一套代码多端复用。
2. 在 PWA 中通过 `window.Capacitor` 判断是否在原生壳中运行，若是，则强制给 `html` 注入 `is-android` 类。
3. 在 CSS 中，针对 `html.is-android`，强制给 `--safe-t` 变量赋值为 `48px`，无视原生环境变量，暴力避开所有机型的顶部状态栏。
4. 移除所有多余的缩放箭头（textarea 的 `resize: none`）和花哨的桌宠，让移动端 UI 绝对清爽。
5. 发送和停止按钮常驻右下角，AI 生成时通过状态机控制停止按钮亮起，避免重叠。

## Alternatives considered
- **使用 React Native 或 Flutter 重写**：需要重写所有 UI 和通信逻辑，违背宪法中“原生 DOM 或轻量级模板”的原则。
- **使用 `@capacitor/status-bar` 插件动态获取高度**：插件的异步返回往往慢于页面渲染，依然会出现闪烁或遮挡。

## Consequences
- APK 构建依赖 GitHub Actions（本地没有 JDK 环境），每次打新包都需要推送触发 CI。
- 48px 的暴力安全区在极个别全面屏上可能留白偏多，但保证了 100% 可点击。
- 签名使用固定的 keystore 提交到仓库，确保了后续版本可以覆盖安装。