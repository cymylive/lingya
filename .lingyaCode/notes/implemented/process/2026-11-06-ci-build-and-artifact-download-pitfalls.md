# Agent Note: GitHub Actions 打包与 Artifact 下载踩坑记

Status: implemented

## Problem
在进行 Android APK 的 CI 构建与本地下载时，遇到了极其折磨人的环境问题：
1. 仓库里的 `android.yml` 曾因编辑器原因被混入 XML 标签变成乱码，导致 GitHub API 持续报 `422 Workflow does not have workflow_dispatch trigger`。
2. CI 打包出的 APK 界面还是旧代码。因为 Capacitor 会在安卓目录里缓存旧版的 PWA 文件。
3. 本地用 PowerShell 或 Python 脚本下载 GitHub Artifact 时持续遇到 `HTTP 401`、`GBK 编码崩溃` 或 `变量被脱敏吃掉` 的报错，导致文件根本无法替换。

## Decision
1. **CI 强制清缓存**：在 `android.yml` 中，在 `npx cap sync android` 之前，强制执行 `rm -rf android/app/src/main/assets/public`。在 Gradle 打包前执行 `./gradlew clean`。绝对保证打入 APK 的是最新源码。
2. **绕过 CI API 限制**：本地写脚本触发 CI 时，不依赖有缺陷的 PowerShell，而是直接写一个 Node 脚本用 `https.request` 发起 POST。
3. **修复 Artifact 401 下载**：GitHub 的下载链接会 302 重定向到微软 Azure，如果依然带着 GitHub 的 Bearer Token 去请求，Azure 会直接 401 拒绝。下载脚本必须在发生 3xx 跳转时，**扔掉所有 Auth 头**再发起请求。
4. **彻底绕开系统限制**：解析 ZIP 包时绝不调用 PowerShell 的变量（防脱敏），直接用系统原生的 `tar -xf`，然后用纯 Node 的 `fs.copyFileSync` 覆盖文件。

## Alternatives considered
- **让用户手动去 GitHub 网页下载**：鉴于国内网络环境，GitHub Artifacts 的下载速度往往只有几 KB/s，极易断连，体验极差。
- **放弃本地调试环境，全靠云端**：失去了即时反馈，开发效率大打折扣。

## Consequences
- 建立了一套极度抗揍的自动化发版链路：无论网络怎么阻断、系统怎么脱敏，都能成功拿到并部署最新的 APK。
- 本地起了一个临时的 Python HTTP 服务供手机同局域网极速下载，完美解决了微信/飞书无法传输超过 20MB 安装包的限制。