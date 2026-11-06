# 手机远程 APK 实现计划

**Goal:** 用 Capacitor 把 005 的 PWA 包进安卓原生壳，GitHub Actions 构建 APK，产物推送到 lingya 仓库。

**Architecture:** PWA（已有）→ Capacitor 壳（新增）→ 原生插件（通知/扫码）→ GitHub Actions（构建）

**Tech Stack:** Capacitor 8 / Android Gradle 8.x / JDK 17 / Node 20 / GitHub Actions ubuntu-latest

**Spec:** `specs/006-remote-apk/spec.md`

---

## Constitution Check

### I. 外科手术式修改 ✅
- **新增为主**：`android/`（Capacitor 生成）、`capacitor.config.json`、`scripts/sync-android-version.js`、改写 `.github/workflows/android.yml`
- **改动最小**：`package.json` 只加依赖和 2 个脚本；PWA 代码**零改动**（已有 `window.Capacitor` 检测）
- **不改**：005 的 remote/server/manager/pwa 业务逻辑

### II. 先思考后编码 ✅
已完成 spec + clarify（6 项决策）+ 本地环境盘点。

### III. 验证闭环与测试驱动 ✅
- 现有 1565 测试不回归
- 新增 `scripts/sync-android-version.js` 写单测（版本同步逻辑）
- APK 功能靠手工验收（无 Android 测试环境）

### IV. 架构分层与沙箱安全 ✅
- APK 只是壳，不碰主进程/沙箱
- 签名密钥：本地 keystore 提交仓库（Cuckoo 同款），CI 优先用 Secrets（`ANDROID_KEYSTORE_BASE64`）
- 不引入新的网络暴露面（APK 连的还是用户填的电脑地址）

### V. 零 Token 与扩展性 ✅
- 不调用任何 API
- 依赖可控：`@capacitor/core` / `@capacitor/android` / `@capacitor/cli` / `@capacitor/local-notifications` / `@capacitor-mlkit/barcode-scanning`

---

## 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| Capacitor 版本 | 8.x | 与 Cuckoo 一致，最新稳定 |
| 配置格式 | `capacitor.config.json` | 项目是 CommonJS JS，避免 TS 依赖 |
| webDir | `src/main/remote/pwa` | 直接复用 005 产物，零拷贝 |
| 签名 | 本地 keystore 提交 + CI Secrets 优先 | 兼容本地构建和 CI |
| 图标 | 4 套 mipmap + activity-alias | 对齐 Cuckoo |
| 通知 | `@capacitor/local-notifications` | 本地通知，无需 FCM |
| 扫码 | `@capacitor-mlkit/barcode-scanning` | Google ML Kit，离线可用 |
| CI 触发 | paths 过滤 + tag + dispatch | 省额度 |

---

## 文件改动清单

### 新增
- `capacitor.config.json`
- `android/`（Capacitor 生成，约 50 个文件）
- `android/app/lingya-release.keystore`（CI 首次生成后提交）
- `scripts/sync-android-version.js`
- `test/scripts/sync-android-version.test.js`
- `specs/006-remote-apk/{spec,plan,tasks}.md`

### 修改
- `package.json`：+5 依赖，+2 脚本（`cap:sync` / `cap:build:android`）
- `.github/workflows/android.yml`：整体重写（指向真实 `android/`）
- `android/app/src/main/AndroidManifest.xml`：权限 + 插件 + 4 alias
- `android/app/build.gradle`：签名 + applicationId + 版本
- `android/variables.gradle`：SDK 版本

### 不改
- 005 的 remote/server/manager/pwa 全部业务代码

---

## 测试策略

| 层 | 方式 |
|---|---|
| 版本同步脚本 | 单测（`node --test`） |
| Capacitor 配置 | CI 构建即验证（`cap sync` 失败会红） |
| APK 功能 | 手工验收（装 APK 连电脑） |
| 现有回归 | `npm test` 1565 用例全绿 |

---

## Review Focus

1. **签名一致性**：CI 和本地构建必须用同一 keystore，否则覆盖安装失败
2. **webDir 路径**：`cap sync` 后 `android/app/src/main/assets/public` 必须有 PWA 文件
3. **版本同步**：`versionCode` 单调递增，`versionName` 与 package.json 一致
4. **权限最小化**：只申请必要权限（INTERNET/NOTIFICATIONS/CAMERA/FOREGROUND_SERVICE）
5. **CI 日志不泄露密钥**：`echo` 任何密钥前先 `::add-mask::`
6. **PWA 缓存**：APK 内 PWA 更新需重新构建 APK（无热更新）
7. **不破坏 005**：PWA 在浏览器里仍能正常用
