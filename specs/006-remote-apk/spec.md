# Feature Specification: 手机远程 APK（Remote APK）

**Feature Branch**: `006-remote-apk`

**Created**: 2026-11-06

**Status**: In Progress

**Input**: User description: "Capacitor 打包安卓 APK，用 GitHub Actions 编译，推送到 lingya 仓库。"

**Reference**: Cuckoo Code `android/` + `capacitor.config.ts` + `.github/workflows/android.yml`

---

## 背景与目标

005 已完成手机远程 PWA（浏览器/添加到主屏）。本 feature 用 **Capacitor** 把同一份 PWA 资源包进安卓原生壳，产出可安装 APK，提供：
- 原生本地通知（AI 回复完成时）
- 扫码填 Token（省去手输 32 位令牌）
- 后台保活（切后台不断连）
- 桌面图标（4 套可选）

构建走 **GitHub Actions**（ubuntu-latest 自带 JDK 17 + Android SDK），产物上传 Artifact，打 tag 时自动挂 Release。本地无 JDK/SDK 不影响开发。

**不改 PWA 业务逻辑**：APK 加载的仍是 `src/main/remote/pwa`，Capacitor 只提供原生壳。PWA 已有 `window.Capacitor` 检测分支，登录页会要求手填电脑地址（APK 内 origin 是 `https://localhost`）。

---

## User Scenarios & Testing

### User Story 1 - 用户装 APK 连接电脑 (Priority: P1)

用户从 GitHub Release 下载 `lingya-android-release.apk`，装到安卓手机。首次打开看到登录页，填电脑地址（或扫码），填 Token，连接成功后和 PWA 功能一致：看历史、流式回复、发消息、停止、多窗口切换、桌宠。

**Independent Test**: 装 APK → 填地址 + Token → 能看到电脑上 AI 的历史对话。

**Acceptance Scenarios**:
1. **Given** 手机未装 APK，**When** 从 Release 下载并安装，**Then** 安装成功，桌面出现「灵鸦」图标
2. **Given** 首次打开，**When** 未填地址，**Then** 提示「请填写电脑地址」
3. **Given** 填了错误 Token，**When** 点连接，**Then** 提示令牌错误，停留登录页
4. **Given** 填了正确地址+Token，**When** 点连接，**Then** 进入对话页，显示历史

### User Story 2 - 扫码填 Token (Priority: P2)

用户在电脑端「设置 → 手机远程」看到令牌，点「显示二维码」（后续加），或直接复制。手机点登录页的「扫码」按钮，扫电脑屏幕上的二维码，自动填入 Token。

**Acceptance Scenarios**:
1. **Given** 手机在登录页，**When** 点扫码按钮，**Then** 打开相机
2. **Given** 扫到含 Token 的二维码，**When** 识别成功，**Then** Token 自动填入输入框

### User Story 3 - AI 完成通知 (Priority: P2)

手机切到后台，电脑 AI 生成完成时，手机收到本地通知「AI 回复完成」。点通知回到 App 看内容。

**Acceptance Scenarios**:
1. **Given** App 在后台，**When** 收到 `ai-reply` 事件，**Then** 弹出本地通知
2. **Given** App 在前台，**When** 收到 `ai-reply`，**Then** 不弹通知（避免打扰）

### User Story 4 - CI 自动构建 (Priority: P1)

开发者 push 到 main 或打 tag，GitHub Actions 自动构建 APK。Artifacts 可下载；打 tag 时自动挂 Release。

**Acceptance Scenarios**:
1. **Given** push 到 main，**When** CI 跑完，**Then** Artifacts 里有 `lingya-android-debug.apk`
2. **Given** 打 tag `v0.6.206`，**When** CI 跑完，**Then** Release 页面有 `lingya-android-release.apk`

---

## Requirements

### Functional Requirements

- **FR-001**: 系统 MUST 提供 `capacitor.config.json`，`appId=com.lingya.lingya`，`appName=灵鸦`，`webDir=src/main/remote/pwa`
- **FR-002**: 系统 MUST 包含 `android/` 原生工程（提交到仓库），CI 可直接构建
- **FR-003**: APK MUST 支持手填电脑地址（Capacitor 壳内 origin 是 localhost，不能同源）
- **FR-004**: APK MUST 支持扫码填 Token（`@capacitor-mlkit/barcode-scanning`）
- **FR-005**: APK MUST 支持本地通知（`@capacitor/local-notifications`）
- **FR-006**: APK MUST 申请权限：INTERNET / POST_NOTIFICATIONS / CAMERA / FOREGROUND_SERVICE
- **FR-007**: AndroidManifest MUST 声明 4 个 activity-alias（default/glass/gold/sticker），默认只有 default enabled
- **FR-008**: `build.gradle` MUST 配置固定签名（本地 keystore + CI Secrets 优先），保证跨版本覆盖安装
- **FR-009**: `versionCode` / `versionName` MUST 与 `package.json` 版本同步（通过 `scripts/sync-android-version.js`）
- **FR-010**: CI workflow MUST 在 `android/**`、`capacitor.config.json`、`src/main/remote/pwa/**` 变更时触发
- **FR-011**: CI MUST 构建 debug APK（每次）+ release APK（打 tag 时）
- **FR-012**: CI MUST 上传 APK 到 Artifacts，打 tag 时挂 Release assets
- **FR-013**: APK 内 PWA MUST 能正常加载（`cap sync` 拷贝 webDir 到 `android/app/src/main/assets/public`）

### Non-Functional Requirements

- **NFR-001**: APK 体积应控制在 15MB 以内（Capacitor 壳 + PWA 资源）
- **NFR-002**: CI 单次构建时间 ≤ 10 分钟
- **NFR-003**: 签名密钥 MUST 不出现在 CI 日志
- **NFR-004**: 不引入 React/Vue 等大框架（宪法约束）

---

## Success Criteria

- **SC-001**: 用户从下载 APK 到成功连接电脑，≤ 3 分钟
- **SC-002**: APK 安装后能与 PWA 一样完整使用远程控制功能
- **SC-003**: CI 构建成功率 100%（无随机失败）
- **SC-004**: 现有测试套件全绿，无回归

---

## 明确不做的事

- 不做 iOS（Capacitor 支持但无 macOS 构建环境，后续独立 feature）
- 不做应用商店上架（只走 GitHub Release 侧载）
- 不重写 PWA 业务逻辑（复用 005 成果）
