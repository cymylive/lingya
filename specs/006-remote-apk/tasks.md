# Tasks: 手机远程 APK

## 依赖顺序

```
T1 (package.json) → T2 (capacitor.config.json) → T3 (npm install)
  → T4 (cap add android) → T5 (AndroidManifest) → T6 (build.gradle)
  → T7 (版本同步脚本) → T8 (图标) → T9 (android.yml)
  → T10 (本地 cap sync 验证) → T11 (推送 + CI 验证)
```

---

## T1: package.json 加依赖和脚本

**Files:** `package.json`

- [ ] Step 1: `dependencies` 加 `@capacitor/core` / `@capacitor/android` / `@capacitor/local-notifications` / `@capacitor-mlkit/barcode-scanning`
- [ ] Step 2: `devDependencies` 加 `@capacitor/cli`
- [ ] Step 3: `scripts` 加 `cap:sync` / `cap:build:android` / `android:version`
- [ ] Step 4: 验证 `package.json` 语法正确

---

## T2: capacitor.config.json

**Files:** `capacitor.config.json`

- [ ] Step 1: 写配置（appId / appName / webDir / android 配置）
- [ ] Step 2: 验证 JSON 语法

---

## T3: npm install

- [ ] Step 1: 用内置 npm 装依赖
- [ ] Step 2: 验证 `node_modules/@capacitor/core` 存在

---

## T4: npx cap add android

- [ ] Step 1: 生成 `android/` 工程
- [ ] Step 2: 验证 `android/app/build.gradle` 存在
- [ ] Step 3: 验证 `android/app/src/main/AndroidManifest.xml` 存在

---

## T5: AndroidManifest

**Files:** `android/app/src/main/AndroidManifest.xml`

- [ ] Step 1: 加权限（INTERNET / POST_NOTIFICATIONS / CAMERA / FOREGROUND_SERVICE）
- [ ] Step 2: 加 4 个 activity-alias（default / glass / gold / sticker）
- [ ] Step 3: 确认 MainActivity 配置正确

---

## T6: build.gradle

**Files:** `android/app/build.gradle`

- [ ] Step 1: `applicationId = com.lingya.lingya`
- [ ] Step 2: 签名配置（release 用 `lingya-release.keystore`，debug 复用 release 签名）
- [ ] Step 3: `versionCode` / `versionName` 从 `package.json` 读取（通过 `scripts/sync-android-version.js` 注入）

---

## T7: 版本同步脚本

**Files:** `scripts/sync-android-version.js` + `test/scripts/sync-android-version.test.js`

- [ ] Step 1: 写单测（版本转换逻辑：`0.6.206` → versionCode `6206`，versionName `0.6.206`）
- [ ] Step 2: 跑测试确认失败
- [ ] Step 3: 实现脚本（读 `package.json` 的 version，写 `android/app/build.gradle` 或 `android/gradle.properties`）
- [ ] Step 4: 跑测试确认通过

---

## T8: 图标

**Files:** `android/app/src/main/res/mipmap-*/ic_launcher_{default,glass,gold,sticker}*.png`

- [ ] Step 1: 从 `icons/icon.png` 生成 4 套图标（用 Node 脚本或在线工具；无 sharp 时用纯色占位）
- [ ] Step 2: 放入对应 mipmap 目录（mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi）
- [ ] Step 3: 验证 AndroidManifest 的 alias 引用的图标名匹配

---

## T9: android.yml 重写

**Files:** `.github/workflows/android.yml`

- [ ] Step 1: 触发条件：`android/**` / `capacitor.config.json` / `src/main/remote/pwa/**` / tag `v*` / dispatch
- [ ] Step 2: JDK 17 + Node 20 + Android SDK 验证
- [ ] Step 3: `npm ci` + `node scripts/sync-android-version.js` + `npx cap sync android`
- [ ] Step 4: `./gradlew assembleDebug`（每次）+ `assembleRelease`（tag 时）
- [ ] Step 5: 上传 Artifacts；tag 时挂 Release
- [ ] Step 6: 密钥用 `::add-mask::` 防泄露

---

## T10: 本地 cap sync 验证

- [ ] Step 1: 用内置 npx 跑 `cap sync android`
- [ ] Step 2: 验证 `android/app/src/main/assets/public/index.html` 存在
- [ ] Step 3: 验证 PWA 文件全部拷贝

---

## T11: 推送 + CI 验证

- [ ] Step 1: `git add` 所有改动
- [ ] Step 2: `git commit`（消息：`feat: 006 手机远程 APK（Capacitor + CI）`）
- [ ] Step 3: 循环重试 push 到 `cymylive/lingya` main
- [ ] Step 4: 等 CI 跑完，验证 Artifacts 有 APK
- [ ] Step 5: 首次 CI 生成 keystore 后，下载并提交到仓库（若 Secrets 未配置）

---

## T12: 手工验收（用户执行）

- [ ] 下载 APK 安装
- [ ] 打开填地址 + Token
- [ ] 验证历史/流式/工具/停止/多窗口/桌宠
- [ ] 验证扫码填 Token
- [ ] 验证后台通知
