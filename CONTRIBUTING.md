# Contributing to LingYa

感谢你考虑为 LingYa AI Pro 贡献力量！我们欢迎任何形式的贡献，包括但不限于：

- 报告 Bug
- 提交功能建议
- 改进文档
- 提交代码修复或新功能

## 开发环境设置

1. Fork 本仓库并克隆到本地
2. 安装依赖：`npm install`
   - 如果 npm 提示 electron postinstall 脚本被阻止（allowScripts），执行：
     - `npm install-scripts approve electron`
     - 再 `npm install`
   - 否则 electron 二进制不会下载，启动会报错
3. 启动应用：`npm start`

## 代码规范

- 使用 2 空格缩进
- 使用 `const` 和 `let`，避免 `var`
- 使用清晰、描述性的变量和函数命名
- 添加必要的注释，尤其是复杂逻辑部分
- 保持代码简洁，遵循"最少惊喜原则"

## 提交 Pull Request

1. 确保你的分支基于最新的 `main` 分支
2. 提交前测试你的改动：`npm start`
3. 提交信息使用清晰、简洁的描述，格式参考：
   - `feat: 添加新工具支持`
   - `fix: 修复命令执行超时问题`
   - `docs: 更新 README`
   - `refactor: 重构工具注册逻辑`
4. 提交 PR 时请描述改动内容和测试情况

## 报告 Bug

请在 Issue 中包含：
- 操作系统版本
- Node.js 版本
- 重现步骤
- 预期行为与实际行为
- 截图或日志（如适用）

## 添加新工具

如果你想添加新的工具支持，请参考 `tools/` 目录下的现有实现：

1. 在 `tools/` 中创建 `{ToolName}Tool.js`
2. 实现 `execute(params, context)` 方法
3. 在 `tools/index.js` 中导出
4. 在 `main.js` 中注册到 `ToolRegistry`
5. 更新 `tools/rules.md` 和 `README.md`

## 许可证

本项目使用 GPL-3.0 许可证，所有贡献都将遵循该许可证。
