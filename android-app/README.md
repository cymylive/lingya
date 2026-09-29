# LingYa 安卓版（android-app）

> 独立子工程，**不修改** 仓库根目录的桌面版代码。桌面版仍走 Electron，本目录走 Capacitor + Android 原生插件。

## 架构

```
手机 WebView (www/)
  ├── ui/            手机端覆盖层 UI（精简版）
  ├── bridge.js      统一工具接口 —— 按平台路由
  │     ├─ desktop:  window.__hostBridge → Electron 主进程（本工程内不启用）
  │     └─ android:  Capacitor.Plugins.LingyaFs → 原生 Java 插件
  └── runner.js      AI 代码执行器（手机端无 Node vm，用受限 Function 作用域）
        ↓
  Android 原生插件 (android/app/.../LingyaFsPlugin.java)
        ├── SAF（Storage Access Framework）用户授权目录
        ├── DocumentFile 读写 / 列举 / 删除
        └── app 私有目录（getExternalFilesDir）
```

## 能力边界（重要）

安卓**非 root 应用**只能：
- 访问自己的私有目录（无需授权）
- 通过 SAF 访问用户**手动授权**的目录（Download/Documents/SD 卡等）
- 无法像桌面 shell 那样遍历整个文件系统、也无法执行任意二进制

因此 `bash` / `pwsh` / 直接 spawn `ripgrep` 在安卓端**不可用**，本工程不注册这些工具。
`glob` / `grep` 用 Java 遍历实现（仅限已授权目录内）。

## 环境要求（构建 APK）

| 组件 | 版本 | 说明 |
|------|------|------|
| JDK | 17 | Android Studio 自带 |
| Android SDK | API 34 | 含 build-tools 34.x |
| Gradle | 8.x | `android/gradlew` 会用 wrapper 自动下载 |
| Node.js | >=18 | 用于 Capacitor CLI |

推荐直接安装 **Android Studio**（一次装好 JDK17 + SDK + 平台工具），然后：

```bash
cd android-app
npm install
npx cap add android          # 首次：生成 android/ 原生工程
npx cap sync android
cd android && gradlew.bat assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

> 注意：`android/` 目录应由 `npx cap add android` 生成（含完整 Gradle wrapper）。
> 本仓库预置了原生插件源码与 MainActivity 片段，`cap add android` 后把它们放到位即可（见 `android/PATCH.md`）。

## 当前进度

- [x] 工程骨架、Capacitor 配置
- [x] 工具抽象层 bridge.js（平台分流）
- [x] Android 原生插件源码 LingyaFsPlugin.java
- [x] 手机端 UI 壳
- [ ] `npx cap add android` 生成原生工程（需 SDK）
- [ ] 真机验证 读/写/列举/删除
- [ ] AI 网页注入在移动 WebView 的适配
```
