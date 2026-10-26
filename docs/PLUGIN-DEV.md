# LingYa 插件开发文档

> 适用版本：LingYa 0.6.124+
> 权威来源：`src/main/plugin-host.js`。本文与代码不一致时，以代码为准。

本文目标：**照着写完，装得上、跑得起来。** 每一节末尾的「坑」都是实际踩过的。

---

## 0. 三十秒上手

最小可用插件只有两个文件：

```text
plugins/my-plugin/
├── manifest.json
└── index.js
```

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "icon": "🔧",
  "entry": "index.js"
}
```

```js
export function apply(ctx) {
  ctx.log('插件已加载')
  ctx.tools.register({
    name: 'myHello',
    description: '返回一句问候。',
    parameters: { name: { type: 'string', description: '名字' } },
    execute(args) {
      return 'Hello, ' + ((args && args.name) || 'World')
    },
  })
}
```

把目录放进 `<userData>/plugins/`（开发期直接放项目根 `plugins/`，启动时自动播种），重启 LingYa，在侧栏「插件」面板确认已启用。

---

## 1. 目录与 manifest

### 1.1 两个插件目录

| 目录 | 用途 |
|---|---|
| 项目根 `plugins/<id>/` | 开发位置。应用启动时**播种**到用户目录 |
| `<userData>/plugins/<id>/` | 运行时实际加载位置 |

**播种规则**（`seedBundledPlugins`）：遍历项目根 `plugins/` 下的每个子目录，若 `<userData>/plugins/<同名>` **不存在**才复制。已存在则跳过 —— 尊重用户已安装/修改的版本。

> **坑 1**：改完项目根 `plugins/` 里的代码，如果用户目录已有同名插件，**改动不会生效**。开发期要么删掉 `<userData>/plugins/<id>`，要么直接在用户目录里改。

> **坑 2**：`<userData>` 在便携版是程序同目录下的 `LingYa-Data`（详见 `data-dir.js`），非便携版是 `%APPDATA%\lingya-ai-pro-session\`。

### 1.2 manifest.json 字段

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `id` | **是** | — | 唯一标识。**仅允许 `[A-Za-z0-9._-]`**，导入 ZIP 时会校验 |
| `name` | 否 | 同 `id` | 显示名称 |
| `version` | 否 | `"0.0.0"` | 版本号 |
| `description` | 否 | `""` | 面板上的说明文字 |
| `icon` | 否 | `"🔌"` | emoji 或短文本 |
| `entry` | 否 | `"index.js"` | 入口文件（相对插件目录） |
| `config` | 否 | `{}` | 配置默认值，会合并进 `ctx.config` |
| `depends` | 否 | `[]` | 依赖的插件 id 数组，按拓扑序加载 |

> **坑 3**：`manifest.json` 必须是 **UTF-8 无 BOM** 的合法 JSON。注释、尾逗号都会导致「解析 manifest 失败」被静默跳过（只在控制台报错，面板上根本不显示这个插件）。

> **坑 4**：`id` 含空格、中文、斜杠 → 导入 ZIP 时直接被拒；直接放目录虽然能扫到，但插件配置存储、IPC 通道名都可能出问题。**统一用小写字母 + 连字符**。

---

## 2. 入口文件与加载流程

### 2.1 导出的三种形态

插件入口必须导出一个 `apply(ctx)` 函数，支持三种写法：

```js
// 形态 A：ESM 具名导出（推荐，示例插件都用这个）
export function apply(ctx) { /* ... */ }

// 形态 B：CommonJS
function apply(ctx) { /* ... */ }
module.exports = { apply }

// 形态 C：default 对象
export default { apply(ctx) { /* ... */ } }
```

### 2.2 加载流程（决定你的代码在什么环境跑）

```text
scanPlugins()
  └─ 读 manifest.json → 缺 id / 解析失败 → 跳过（控制台报错）
       ↓
loadPlugin()
  ├─ 检查 entry 文件存在 → 不存在 → 失败
  ├─ esbuild 打包（支持 ESM + @deepseek-ai/* 映射到 stub）
  │    └─ 打包失败 → 回退 require()
  ├─ 取 mod.apply（兼容 function / {apply} / {default:{apply}}）
  ├─ 没有 apply → 失败「插件未导出 apply(ctx) 函数」
  ├─ createContext() 构造 ctx
  ├─ 执行 apply(ctx)，支持返回 Promise
  │    └─ 抛异常 → **回滚所有已注册副作用**，插件标记失败
  └─ 记入 loaded
```

**关键事实**：

- `apply()` 在**主进程**执行，与内置工具**同权限**（本地信任模型，无沙箱）
- `apply()` 里抛异常 → 该插件本次所有注册全部回滚，插件不加载。**用 try/catch 包住可能失败的部分**
- `apply()` 可以返回 Promise，宿主会等它完成
- 支持热重载：插件目录文件变化 → 300ms 防抖后自动卸载再加载

> **坑 5**：`apply()` 里不要做长时间同步阻塞操作（比如同步读大文件、同步网络请求），会卡住主进程启动。

> **关于 `export const inject`**：你会在示例插件里看到 `export const inject = ['tools']`。
> **这是 DSH 兼容层的历史写法，LingYa 本地插件宿主并不读取它** —— 写不写都不影响加载。
> 示例插件保留它是为了与 DSH 插件规范保持形状一致。**新插件可以不写**；
> 写了也不会报错，别指望它产生任何「依赖注入」效果。真正的依赖声明用 manifest 的 `depends`。

---

## 3. ctx API 全表

`ctx` 是你唯一的能力入口。**所有注册方法都返回 disposer**，卸载时按注册逆序调用。

### 3.1 基础属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `ctx.pluginId` | string | 当前插件 id |
| `ctx.pluginDir` | string | 插件目录绝对路径 |
| `ctx.config` | object | `manifest.config` 与持久化配置的合并结果 |
| `ctx.log(...args)` | function | 带 `[插件id]` 前缀的 console.log |

### 3.2 注册工具

```js
// DSH 风格（推荐，parameters 用简写格式）
ctx.tools.register({
  name: 'toolName',            // 必填，不能与内置工具重名
  description: '给 AI 看的说明',  // 越具体 AI 越会用
  parameters: {                 // 属性简写，每个属性可选 type/description
    path: { type: 'string', description: '文件路径' },
  },
  execute(args) {              // 可以是 async
    return '结果文本'           // 返回字符串或 { success, data }
  },
})

// 等价的标准写法
ctx.registerTool({
  name: 'toolName',
  description: '...',
  parameters: { type: 'object', properties: { /* JSON Schema */ } },
  execute: async (args) => { /* ... */ },
})
```

**参数格式**：`parameters` 既接受 DSH 简写（`{ path: {type:'string'} }`），也接受标准 JSON Schema（`{ type:'object', properties:{...} }`）。宿主会自动判断并转换。

**返回值**：
- 返回字符串 → 包装成 `ToolResult.success(字符串)`
- 返回 `{ success, data }` / `{ success, error }` → 原样使用
- 抛异常 → 包装成 `ToolResult.error`

> **坑 6**：工具名**全局唯一**。与内置工具或别的插件重名时，`ToolRegistry.register` 只打 warning 并**静默覆盖**，先注册的被顶掉。命名建议加插件前缀，如 `tw_check`。

> **坑 7**：工具在**主进程**执行，返回内容会作为工具结果发给 AI。别返回超长文本（建议 < 20000 字符），也别返回带 ```lingya` 代码块围栏的字符串 —— 会被 AI 误认为新的工具调用。

### 3.3 注册 IPC 通道

渲染进程（侧栏壳窗口 / AI 页面）通过 IPC 调用主进程的插件逻辑。

```js
ctx.registerIpc('getData', async (args, event) => {
  return { hello: 'world' }   // 会被包装成 { success:true, data:{...} }
})
```

调用方：

```js
// 侧栏壳窗口
const r = await window.shellAPI.pluginInvoke('my-plugin', 'getData', {})
// r = { success: true, data: { hello: 'world' } }

// AI 页面（preload 脚本里）
const r2 = await window.electronAPI.pluginInvoke('my-plugin', 'getData', {})
```

**返回契约**：

| handler 行为 | 调用方收到 |
|---|---|
| `return data` | `{ success: true, data }` |
| `throw new Error('x')` | `{ success: false, error: 'x' }` |
| 通道不存在 | `{ success: false, error: '插件通道不存在: id:channel' }` |

> **坑 8**：channel 名不需要自己加插件前缀，宿主内部会拼成 `pluginId:channel`。但同一插件内 channel 不能重复，重复注册会覆盖前一个。

### 3.4 注册侧栏视图

往侧栏活动栏加一个图标 + 面板。

```js
ctx.registerView({
  id: 'main',              // 插件内唯一
  icon: '🔧',              // 活动栏图标
  label: '工具',            // 活动栏文字
  title: '我的插件',         // 面板标题
  render() {               // 返回 HTML 字符串
    return '<div class="sh-panel-head">...</div>'
  },
})
```

**`render()` 的重要约束**：

1. **在主进程执行**，拿不到 `window` / `document` / `localStorage`
2. 返回的 HTML 直接插入侧栏容器，**不经过任何转义**
3. 用户配置在 render 时就要拼进 HTML（因为 render 只调用一次，不是响应式的）
4. 想放交互脚本，用 `<script>` 标签内联，但注意转义 `</script>`

```js
// 在 render 里内联脚本的安全写法
const SCRIPT = [
  '(function(){',
  '  document.getElementById("btn").addEventListener("click", function(){',
  '    window.shellAPI.pluginInvoke("my-plugin", "doThing", {}).then(function(r){',
  '      console.log(r);',
  '    });',
  '  });',
  '})();',
].join('\n')

ctx.registerView({
  id: 'main',
  icon: '🔧',
  label: '工具',
  title: '我的插件',
  render() {
    return '<button id="btn">点我</button><script>' + SCRIPT + '</' + 'script>'
  },
})
```

> **坑 9**：`render()` 抛异常 → 面板显示红色错误文本，插件本身仍算加载成功。所以 render 里的数据读取要 try/catch。

> **坑 10**：内联 `<script>` 时，字符串里出现 `</script>` 会提前闭合标签。**必须拆成 `'</' + 'script>'`**，这也是上面写法的原因。

> **坑 11**：`render()` 只在插件加载时调用一次。要让面板显示动态数据，靠内联脚本调 `pluginInvoke` 拉取后自己改 DOM。

### 3.5 注册 preload 脚本（最需要注意的部分）

把一段脚本注入到 **AI 网页的渲染进程**，用于挂钩 DOM / 网络 / 读取页面状态。

```js
ctx.registerPreload(scriptText)   // scriptText 是一整段字符串
```

注入时机：AI 页面 preload 初始化后，逐个用 `setTimeout(0)` 执行。

**执行环境**：

- 通过 `new Function(scriptText)()` 执行，是**裸脚本**
- **不能 `require`** 项目内部模块（拿不到 `sendMessageToChat`、`state`、`task-state`）
- 能访问 `window`、`document`、`localStorage`、`window.electronAPI`
- 能访问 `window.__lingyaPluginAPI`（LingYa 0.6.124+ 提供，见 3.6）

**必须自己处理的三件事**：

1. **幂等**：页面可能重复注入，用全局标记兜住
2. **异常隔离**：整段包 try/catch，别让一处报错拖垮全部
3. **状态不持久**：页面刷新 / 切会话 → 定时器和内存变量全部丢失

```js
const SCRIPT = `
(function () {
  if (window.__myPluginInstalled) return;
  window.__myPluginInstalled = true;

  try {
    // ... 你的逻辑
  } catch (e) {
    console.warn('[my-plugin] 注入脚本异常:', e && e.message);
  }
})();
`

ctx.registerPreload(SCRIPT)
```

> **坑 12**：preload 脚本里**不能用 ESM `import`**，也不能用 `require`。它就是一个普通函数体。

> **坑 13**：脚本里访问 `window.electronAPI` 前要判空 —— 非 AI 平台页面（用户开的普通网页标签）不注入完整 API。

> **坑 14**：`setInterval` 在页面刷新后消失。需要跨刷新保持的东西，要么存 `localStorage`，要么交给主进程（见 3.6）。

### 3.6 给插件的运行时 API：`window.__lingyaPluginAPI`

LingYa 0.6.124 起，preload 脚本执行**之前**会先安装这个对象，解决「裸脚本拿不到内部能力」的问题。

```js
const api = window.__lingyaPluginAPI
if (!api) return   // 老版本 LingYa 没有，必须判空

// 1) 发消息给 AI（走完整发送链路，含平台兼容）
await api.sendMessage('请继续', '我的插件')
// 返回 true = 进入发送流程；false = 用户已停止 / 参数为空
// 内部强制 auto 模式：用户点停止后发不出去

// 2) 读运行时状态（只读快照）
const st = api.getRuntimeState()
// {
//   sessionId: string|null,
//   stopped: boolean,              用户是否点了停止
//   awaitingUserInput: boolean,    AI 是否在等用户回答
//   awaitingNextInitialChunk: boolean,  是否在分批发送初始化提示
//   taskDeclaredDone: boolean,     AI 是否声明过任务完成
//   lastActivityAt: number,        最后一次活动的时间戳（ms）
// }

// 3) 读当前会话待办
const { todos, archived } = await api.getTodos()
// todos: [{ id, content, status: 'pending'|'in_progress'|'completed' }]
// archived: true = 全部完成并已归档
```

**这就是写「定时催促」类插件的正确姿势**：不要自己找输入框、合成按键事件，直接用 `api.sendMessage`。

### 3.7 配置读写

```js
ctx.settings.get('key')        // 读，未设置返回 undefined
ctx.settings.set('key', value) // 写，立即落盘到 <userData>/lingya-plugins.json
```

> **注意**：`ctx.settings.set` 每次调用都同步写整个 JSON 文件。**高频写入要自己节流**，别在定时器里每秒调用。

### 3.8 事件与副作用

```js
ctx.on('eventName', handler)   // 返回 disposer
ctx.emit('eventName', ...args)
ctx.effect(() => {             // 返回 disposer 的函数，或返回一个清理函数
  return () => { /* 清理 */ }
})
```

---

## 4. 三种典型插件形态

### 4.1 纯工具插件（最简单）

只给 AI 加工具，没有 UI。

```js
export const name = 'my-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'myEcho',
    description: '把输入原样返回。',
    parameters: { text: { type: 'string', description: '要回显的文本' } },
    execute(args) { return String((args && args.text) || '') },
  })
}
```

### 4.2 带配置面板的插件

工具 + 侧栏视图 + IPC 读写配置。

```js
export const name = 'my-panel'
export const inject = []

const DEFAULTS = { greeting: 'Hello', enabled: true }

export function apply(ctx) {
  const readCfg = () => Object.assign({}, DEFAULTS, ctx.config || {})

  ctx.registerIpc('getConfig', async () => readCfg())

  ctx.registerIpc('saveConfig', async (patch) => {
    const next = Object.assign(readCfg(), patch || {})
    next.greeting = String(next.greeting || DEFAULTS.greeting)
    ctx.config = next
    return next
  })

  ctx.tools.register({
    name: 'myGreet',
    description: '按面板配置的问候语打招呼。',
    parameters: {},
    execute() { return readCfg().greeting },
  })

  const SCRIPT = [
    '(function(){',
    '  window.shellAPI.pluginInvoke("my-panel","getConfig",{}).then(function(r){',
    '    var d=(r&&r.success&&r.data)||{};',
    '    var e=document.getElementById("g"); if(e) e.value=d.greeting||"";',
    '  });',
    '  var b=document.getElementById("save");',
    '  if(b) b.addEventListener("click",function(){',
    '    var e=document.getElementById("g");',
    '    window.shellAPI.pluginInvoke("my-panel","saveConfig",{greeting:e?e.value:""});',
    '  });',
    '})();',
  ].join('\n')

  ctx.registerView({
    id: 'main',
    icon: '⚙️',
    label: '设置',
    title: '我的插件',
    render() {
      const c = readCfg()
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">我的插件</span></div>',
        '<div class="sh-panel-body">',
        '  <input id="g" value="' + c.greeting + '" />',
        '  <button id="save">保存</button>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })
}
```

### 4.3 带定时监听的插件（最容易出错）

需要 preload 注入 + 定时器 + 主进程裁决状态。

**核心原则：**
- 定时器跑在渲染进程（preload 脚本里）
- 需要跨刷新持久化的状态，**交给主进程 IPC 裁决**
- 发送消息用 `window.__lingyaPluginAPI.sendMessage`

完整参考实现：`plugins/task-watcher/`（任务守望者插件）。它的结构是：

```text
主进程 apply()
  ├─ registerIpc('getConfig')      拉配置
  ├─ registerIpc('saveConfig')     存配置（保护内部状态字段）
  ├─ registerIpc('bumpNudgeCount') 计数裁决 + 落盘 + 24h TTL 清理
  ├─ registerPreload(脚本)          注入定时器
  └─ registerView(...)             配置面板

preload 脚本
  ├─ 每 15 秒检查一次
  ├─ 读 window.__lingyaPluginAPI.getRuntimeState()
  ├─ 四道闸门：stopped / awaitingUserInput / awaitingNextInitialChunk / taskDeclaredDone
  ├─ 调主进程 bumpNudgeCount 拿「能不能催」的裁决
  └─ allowed 才 api.sendMessage()
```

> **坑 15**：不要在 preload 脚本里自己维护计数对象然后指望它持久 —— 页面刷新就归零。计数、限流这类状态一律放主进程。

---

## 5. 渲染进程调用速查

| 场景 | API |
|---|---|
| 侧栏面板调主进程 | `window.shellAPI.pluginInvoke(pluginId, channel, args)` |
| AI 页面 preload 调主进程 | `window.electronAPI.pluginInvoke(pluginId, channel, args)` |
| 获取所有插件视图 HTML | `window.shellAPI.pluginViews()` |
| 发消息给 AI（preload 脚本内） | `window.__lingyaPluginAPI.sendMessage(text, tag)` |
| 读运行时状态（preload 脚本内） | `window.__lingyaPluginAPI.getRuntimeState()` |
| 读待办（preload 脚本内） | `await window.__lingyaPluginAPI.getTodos()` |

---

## 6. 常见失败原因对照表

| 现象 | 最可能的原因 | 怎么查 |
|---|---|---|
| 插件面板里根本看不到 | manifest.json 解析失败 / 缺 `id` / 不在 `<userData>/plugins/` 下 | 看主进程控制台的 `[PluginHost]` 日志 |
| 显示但「已加载」为否 | 入口文件不存在 / 没导出 `apply` / apply 抛异常 | 看 `[PluginHost] 插件 apply 失败` 日志 |
| 加载成功但工具用不了 | 工具名与内置工具重名被覆盖 / AI 不知道该工具 | 看 `[ToolRegistry] 注册工具` 日志确认名字 |
| 面板空白 | `render()` 返回空 / 抛异常 | 看面板是否显示红色错误文本 |
| 面板有按钮但点了没反应 | 内联脚本没执行 / channel 名写错 | F12 打开 DevTools 看 console |
| preload 脚本没生效 | 脚本语法错误 / 在非 AI 页面 | 看 AI 页面 DevTools 的 `插件 preload 执行失败` |
| 修改代码后没变化 | 用户目录已有同名插件，播种被跳过 / 热重载失败 | 删 `<userData>/plugins/<id>` 重试 |
| IPC 返回「通道不存在」 | channel 名拼错 / 插件未加载 | 检查 `registerIpc` 的 channel 与调用方一致 |
| 插件导入 ZIP 失败 | id 含非法字符 / 包里找不到 manifest.json | 看导入返回的 error |

---

## 7. 自查清单（提交前逐条过）

- [ ] `manifest.json` 是合法 JSON（无注释、无尾逗号、UTF-8 无 BOM）
- [ ] `id` 只含小写字母 / 数字 / `-` / `_` / `.`
- [ ] `entry` 指向的文件真实存在
- [ ] 导出的是 `apply(ctx)` 函数（不是 `apply` 对象、不是异步工厂）
- [ ] `apply()` 内可能失败的部分包了 try/catch
- [ ] 工具名全局唯一，加了插件前缀
- [ ] 工具返回值不含 ```lingya` 围栏，长度合理
- [ ] `render()` 里的数据读取包了 try/catch
- [ ] 内联 `<script>` 的闭合标签拆成了 `'</' + 'script>'`
- [ ] preload 脚本有幂等标记（`window.__xxxInstalled`）
- [ ] preload 脚本整段包了 try/catch
- [ ] preload 脚本里访问 `window.__lingyaPluginAPI` / `window.electronAPI` 前判空
- [ ] 跨刷新需要保留的状态放在了主进程（`ctx.config` / `ctx.settings`）
- [ ] `ctx.settings.set` 调用有节流，不在高频定时器里裸调
- [ ] 插件目录名与 `manifest.id` 一致

---

## 8. 参考实现

| 插件 | 演示了什么 | 路径 |
|---|---|---|
| `hello` | 最小工具插件（两个工具） | `plugins/hello/` |
| `demo-panel` | 工具 + IPC + 侧栏视图 + `depends` 依赖声明 | `plugins/demo-panel/` |
| `deepseek-archive` | 纯 preload 注入（DOM 挂钩，无 UI） | `plugins/deepseek-archive/` |
| `task-watcher` | 定时监听 + 主进程状态裁决 + 配置面板 | `plugins/task-watcher/` |

写新插件时，**从最接近你需求的示例复制改名**，比从空白开始快得多。
