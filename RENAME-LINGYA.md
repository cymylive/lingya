# 改名说明：Cuckoo Code → LingYa（灵鸦）

> 改名日期：2026-09-21
> 项目路径：C:\Users\Administrator\Desktop\cuckoo-code-mod-main
> 新名称：**LingYa（灵鸦）**
> 包名：`lingya`　appId：`com.lingya.lingya`

## 一、改了什么

全量改名，共 **69 个文件 / 1246 处**替换，另加物理文件重命名和数据迁移。

| 层级 | 变更前 | 变更后 |
|------|--------|--------|
| 产品名 | Cuckoo Code | **LingYa** |
| 包名 | cuckoo-code | **lingya** |
| appId | com.cuckoo.cuckoo-code | **com.lingya.lingya** |
| 安装包名 | cuckoo-code-win-v*.exe | **lingya-win-v*.exe** |
| 代码块围栏 | ```cuckoo | **```lingya** |
| 系统提示词身份 | "由 Cuckoo Code 驱动的 AI 编程助手" | "由 LingYa 驱动的 AI 编程助手" |
| 内部事件 | cuckoo-ai-start / cuckoo-ai-response | lingya-ai-start / lingya-ai-response |
| CSS 类名 | .cuckoo-* | .lingya-* |
| localStorage 键 | cuckoo-auto-inject 等 | lingya-auto-inject 等 |
| 工具类型文件 | tools/cuckoo-tools.d.ts | **tools/lingya-tools.d.ts** |
| 用户数据目录 | %APPDATA%/cuckoo-ai-pro-session | **%APPDATA%/lingya-ai-pro-session** |
| 记忆存储 | cuckoo-memory.json | **lingya-memory.json** |
| 技能存储 | cuckoo-skills.json | **lingya-skills.json** |
| 安全配置 | cuckoo-security.json | **lingya-security.json** |

## 二、数据迁移（已完成）

全改方案下数据目录也改了，已自动迁移，**登录态和记忆/技能/配置全部保留**：

```
旧：%APPDATA%\cuckoo-ai-pro-session\
新：%APPDATA%\lingya-ai-pro-session\
```

- 复制 3309 文件 / 782 目录（含 cookies、localStorage、会话缓存）
- 内部文件重命名 10 个（cuckoo-memory.json → lingya-memory.json 等）

**旧目录保留未删**，确认新版本运行正常后可手动删除：
```powershell
Remove-Item -Recurse -Force "$env:APPDATA\cuckoo-ai-pro-session"
```

## 三、GPL 合规（重要）

本项目是 [wangyongpeng90/cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code) 的 fork，遵循 **GPL-3.0-only**。

改名时**刻意保留**了以下上游归属，不得删除：

- `LICENSE` 文件原样未动
- `package.json` 的 `contributors` 字段标注上游原作者
- `README.md` / `README.en.md` 顶部声明二次开发关系与上游链接
- 所有指向 `github.com/wangyongpeng90/cuckoo-code` 的 URL

**可以换品牌，但不能抹掉原作者归属**——这是 GPL 的硬性要求。

## 四、备份位置

改动前的完整快照：

- 源码：`H:\cuckoo\_backup_rename_lingya\src-snapshot\`（147 文件）
- 用户数据：`H:\cuckoo\_backup_rename_lingya\userdata-snapshot\`（3312 文件 / 434MB）

回滚方式：用快照覆盖项目目录 + 恢复旧数据目录。

## 五、验证结果

- 核心文件 `node --check` 全部通过
- 测试套件 **246 tests / 246 pass / 0 fail**
- 协议令牌一致性核对：解析器 `lingya` ↔ 4 个提示词模板 ```lingya，无残留
- 确认无 ```cuckoo 围栏残留

## 六、后续待办

1. **GitHub 仓库**：当前仓库是 `cymylive/cuckoo-code-mod`，如需彻底独立可新建 `cymylive/lingya` 仓库。
2. **图标**：`logo/` 与 `assets/tray-icon.png` 仍是原图标，建议重做灵鸦主题图标。
3. **旧数据目录**：确认新版本正常后删除。
4. **首次运行**：因 localStorage 键名变了，部分界面偏好（发送延迟、自动压缩阈值等）需重新设置一次；记忆、技能、登录态不受影响。

## 七、运行

```powershell
$env:Path = "D:\NodeJS;" + $env:Path
cd C:\Users\Administrator\Desktop\cuckoo-code-mod-main
npm start
```
