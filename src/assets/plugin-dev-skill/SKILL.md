# LingYa 插件开发 Skill (v1.0)

本 Skill 用于辅助 AI（如 Claude, ChatGPT, DeepSeek 等）为你开发 LingYa 桌面客户端的插件。

LingYa 插件系统支持通过插件扩展工具、注入系统提示词、拦截 AI 回复、挂载侧边栏 UI 等。

## 一、开发前必读

请仔细阅读同目录下的 `PLUGIN-DEV.md`。这是与当前 LingYa 客户端版本绝对匹配的底层 API 契约。

**如果文档描述不清或有冲突，请直接阅读 `source/` 目录下的核心源码：**
- `source/plugin-api.js`：看 preload 脚本能拿到什么能力（如发消息、拦截回复）。
- `source/plugin-host.js`：看宿主如何加载插件、如何暴露 `ctx` 对象。重点看 `createContext()` 函数。

## 二、目录结构

一个标准的 LingYa 插件包含以下文件：
```text
my-plugin/
├── manifest.json      # 插件元数据（必填）
├── index.js           # 入口文件（必填）
└── README.md          # 插件说明（可选）
```

## 三、manifest.json 示例

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "描述插件的用途",
  "icon": "🔌",
  "entry": "index.js",
  "apiVersion": 1
}
```

## 四、index.js 标准结构

```javascript
export function apply(ctx) {
  ctx.log('插件已加载')

  // 1. 注册工具（给 AI 用）
  ctx.tools.register({
    name: 'myTool',
    description: '工具描述',
    parameters: { text: { type: 'string' } },
    execute(args) {
      return '结果'
    }
  })

  // 2. 注册侧栏面板
  ctx.registerView({
    id: 'main',
    icon: '🔧',
    label: '面板',
    title: '我的插件',
    render() {
      return '<div>配置界面</div>'
    }
  })

  // 3. 注册配置读写
  ctx.registerIpc('getConfig', async () => ctx.config)
  ctx.registerIpc('saveConfig', async (patch) => {
    ctx.config = Object.assign({}, ctx.config, patch)
    if (ctx.settings && ctx.settings.save) ctx.settings.save()
    return { success: true }
  })
}
```

## 五、工作流

1. 让 AI 根据上述规范和 `PLUGIN-DEV.md` 生成代码。
2. 将代码保存到本地任意目录。
3. 打开 LingYa 侧边栏「插件」-> 顶部「导入插件包」。
4. 如果还没有打包，可以要求 LingYa 帮你把本地目录打包成 `.lingya-plugin.zip`，然后再导入。

## 六、安全检查

- manifest.json 必须是合法的 JSON，不能有注释。
- id 只能包含小写字母、数字、连字符。
- 不要尝试访问文件系统（除了通过 ctx 暴露的方法），插件运行在受限沙箱中。
