# Hello 示例插件

这是 LingYa 插件系统的最小示例。演示：
- `manifest.json`：插件元数据（id/name/version/entry）
- `index.js`：插件逻辑，导出 `apply(ctx)`

## 贡献的工具

| 工具 | 说明 |
|---|---|
| `helloWorld(name?)` | 返回问候语 |
| `pluginInfo()` | 返回当前插件元信息 |

## 如何卸载

- 在 LingYa 侧栏「插件」面板里禁用（保留文件，可随时再启用）
- 或直接删除 `<userData>/plugins/hello` 目录（重启后消失）
