# LingYa 注入痕迹与可检测性分析报告

> 分析时间：2026-10-31
> 目标：LingYa 开发版（0.6.162）嵌入 https://chat.deepseek.com/
> 方法：静态代码审查（src/preload、src/providers、src/main）+ 运行时实测（injectJS 三轮探测）
> 结论对象：**页面侧脚本能观察到哪些痕迹**（不涉及绕过手段）

---

## 一、实测原始数据

### 1.1 全局 API 暴露

| 探测项 | 结果 |
|---|---|
| `typeof window.electronAPI` | **object** |
| `electronAPI` 方法数 | **130** |
| 其中可执行危险操作 | `executeCommand` / `executeJs` / `executeTool` / `readFilePreview` |
| `window.__lingyaPluginAPI` | undefined（本轮未装插件脚本） |
| `Object.keys(window).filter(/lingya/i)` | **[]**（说明注入的名字都在 DOM/id 上，不在 window 自有可枚举属性） |

> `electronAPI` 由 `contextBridge.exposeInMainWorld` + `window.electronAPI = electronAPI` 双保险暴露（src/preload/api.js:406-413）。**前者在隔离世界，页面读不到；后者直接挂在主世界 window 上，页面任何脚本一行 `typeof window.electronAPI` 即可命中。**

### 1.2 DOM 注入

| 探测项 | 结果 |
|---|---|
| `#lingya-root` 存在 | **是** |
| `[id^="lingya-"]` 元素数 | **30+**（tool-card-style、overlay、tabbar、plan-tab-count、agent-switch…） |
| `[class*="lingya-"]` 元素数 | **460** |
| 页面总节点数 | 802 |
| LingYa 相关节点 | **529（占 66%）** |
| `#lingya-root` 尺寸 | 0×0，position: static，zIndex: auto（容器本身不可见，子元素浮层定位） |
| body 末尾子元素 | `root, lingya-root, lingya-fab-token, DIV, DIV` |
| 注入 `<style>` 数 | 7 个（其中 `lingya-tool-card-style`、`lingya-archived-css` 带 id，其余无 id） |
| 注入 `textarea` 数 | **6 个**（lingya-utodo-input / lingya-mcp-json / lingya-skill-ed-instructions / lingya-memory-ed-content / lingya-security-ctf-prompt / lingya-schedule-prompt） |

> 页面只要执行 `document.querySelectorAll('[id^="lingya-"]')` 或 `document.querySelectorAll('textarea').length` 就能立刻发现异常——DeepSeek 原生首页只有 1 个输入 textarea。

### 1.3 网络层

| 探测项 | 结果 |
|---|---|
| `String(window.fetch)` | `function fetch() { [native code] }` |
| `fetch.hasOwnProperty('toString')` | **false**（0.6.30 已移除 spoofNative，见 deepseek.js:44-49） |
| `XMLHttpRequest.prototype.open/send` | 均为 native |
| 属性描述符 | fetch/open/send/setRequestHeader 全部 writable+configurable+enumerable=true，value 为 native 函数 |

**结论：当前走 CDP 路径（`useCdp: true`），页面主世界的 fetch/XHR 未被 hook。** 这是 0.6.x 相对旧版最大改进——从"改写页面函数"变成"主进程旁路监听"。

但副作用是：

| 探测项 | 结果 |
|---|---|
| `navigator.webdriver` | false（正常） |
| `navigator.userAgentData.brands` | `[{Not?A_Brand/99}, {Chromium/130}]`，**缺少 Google Chrome 品牌** |
| `window.chrome.runtime` | undefined，`Object.keys(window.chrome)` 为 **[]** |
| `process` / `require` | undefined（contextIsolation 生效） |

> Chrome 130 的 UA-CH 标准品牌列表应该是 `Not_A Brand; Chromium; Google Chrome`。这里少了 **Google Chrome**——这是 Electron 应用的默认特征，**任何反爬指纹库（如 fingerprintjs、creepjs）都会命中 "Electron detected"**。

### 1.4 事件通道

| 探测项 | 结果 |
|---|---|
| 自定义事件名存活 | `lingya-ai-start / lingya-ai-response / lingya-hook-ready / lingya-user-message / lingya-ds-headers` **5 个全部可派发并被接住** |
| `lingya-ai-start` 手动派发 | 有监听器响应（customEventAlive=true） |

> 页面只要 `window.addEventListener('lingya-ai-response', ...)` 就能监听 LingYa 截获的 AI 回复全文——**这些事件名是明文常量，未做任何混淆**。

### 1.5 存储

| 探测项 | 结果 |
|---|---|
| localStorage 中 lingya 键 | **6 个**：`lingya-theme`、`lingya-ds-headers`、`lingya-fab-pos`、`lingya-plan-float-pos`、`lingya-hide-plan-float`、`lingya-plan-float-minimized` |
| `lingya-ds-headers` 内容 | **存在，len=586，含 authorization: "Bearer TwskR..."、x-device-id: "eada975c-3..."、x-request-encryption-key、x-ds-compression** |

> **这是本轮最严重的问题。** 代码注释（deepseek.js:168-172）明确写了"0.6.30 不再写 localStorage['lingya-ds-headers']"，但实测该键**仍然存在且包含完整 Bearer token 与设备指纹**。
>
> 页面任意脚本一行 `JSON.parse(localStorage['lingya-ds-headers'])` 即可窃取用户 DeepSeek 的 authorization token。同时键名前缀 `lingya-` 本身就把工具身份暴露给页面。

### 1.6 输入模拟

| 路径 | 实现 |
|---|---|
| 文本输入 | **CDP `Input.insertText`**（src/main/ipc.js:1649），产生 `isTrusted=true` 的 input 事件 |
| 回车发送 | `chat-send-enter` IPC → 主进程 dispatchKeyEvent |
| 剪贴板路径 | `document.execCommand('selectAll'/'delete')`（file-upload.js:62-63）——**只用于清空，不用于写入** |

> CDP Input 属于浏览器内核级输入，`isTrusted=true`，与真人键入在事件层面**不可区分**。这是比 `element.value=xxx + dispatchEvent` 更干净的方案。**结论：输入层不构成可检测特征。**

### 1.7 调试连接

| 探测项 | 结果 |
|---|---|
| CDP debugger attach | **是**（`CDP 捕获已启用 (deepseek)` 已落日志） |
| `debugger;` 语句耗时 | 0ms（无调试器暂停，说明 **DevTools 前端未连接**，只是 debugger 协议被 attach） |
| `console.log.toString()` | native |
| `window.addEventListener` | native |

> `webContents.debugger.attach` 是 Electron 主进程 API，**页面 JavaScript 无法直接感知**（无 `window.__debugger` 之类标志）。唯一可能暴露的是 CPU 侧信道（CDP 会增加 IPC 开销），但灵敏度极低，不实用。

### 1.8 其他指纹

| 项 | 值 |
|---|---|
| UA | Chrome/130 Windows，标准 |
| plugins | 5（Chrome 正常值） |
| languages | zh-CN, zh-Hans-CN |
| hardwareConcurrency | 4 |
| deviceMemory | 8 |
| screen.colorDepth | 24 |
| iframe 数 | 0 |
| `window.chrome` 自有键 | []（缺 runtime/loadTimes/csi —— 属于 Electron 默认，见上文 UA-CH） |

---

## 二、可检测性评级

按"页面脚本只需几行代码即可命中"排序。

| # | 痕迹 | 检测成本 | 危害 | 评级 |
|---|---|---|---|---|
| 1 | `window.electronAPI`（130 个方法，含 executeCommand） | **1 行** | 极高——页面可反向调用 LingYa 的工具链 | 🔴 **致命** |
| 2 | `localStorage['lingya-ds-headers']` 含 Bearer token | **1 行** | 极高——token 泄露 | 🔴 **致命** |
| 3 | `[id^="lingya-"]` 30+ 个元素、460 个 class、66% 节点占比 | **1 行** | 高——直接判定为已注入 | 🔴 高 |
| 4 | 6 个 `lingya-*` textarea（首页原生仅 1 个） | **1 行** | 高 | 🔴 高 |
| 5 | `window.chrome.runtime` 缺失 + UA-CH 无 Google Chrome 品牌 | 指纹库自动命中 | 中——判定为 Electron/自动化 | 🟠 中 |
| 6 | `lingya-ai-response` 等 5 个明文 CustomEvent 名 | 1 行（遍历常见名） | 中——可监听 AI 回复 | 🟠 中 |
| 7 | 6 个 `lingya-*` localStorage 键 | 1 行 | 低——只暴露工具存在 | 🟡 低 |
| 8 | 7 个注入 `<style>`（2 个带 lingya id） | 1 行 | 低 | 🟡 低 |
| 9 | CDP debugger attach | 无法从 JS 感知 | 无 | ⚪ 不可测 |
| 10 | CDP Input.insertText | isTrusted=true，无法区分 | 无 | ⚪ 不可测 |
| 11 | fetch/XHR 未 hook | — | 无（已是正确做法） | ⚪ 已规避 |

---

## 三、关键发现与改进建议

### 🔴 问题 1：electronAPI 被双路暴露到主世界

**证据**：`src/preload/api.js:406-413`

```js
try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) { ... }
// 无论 contextBridge 是否成功，都直接挂载到 window 作为备选
window.electronAPI = electronAPI;   // ← 这一行绕过 contextBridge，直接给页面
```

`contextBridge.exposeInMainWorld` 本身已经把 API 暴露给页面（这是它存在的意义），但**它是隔离世界代理对象，页面拿到的函数会抛 "An object could not be cloned"**——不能任意传参。而 `window.electronAPI = electronAPI` 这一行把**真正的对象**（含 executeCommand 等）挂到主世界 window 上，页面可以直接：

```js
await window.electronAPI.executeCommand('whoami')
await window.electronAPI.executeJs('任意代码')
```

**这相当于给 DeepSeek 页面开了一个任意命令执行入口。** 虽然是用户自己的机器，但一旦 DeepSeek 页面被 XSS（第三方广告、富文本注入），攻击者就能直接拿到系统命令执行权限。

**建议（按优先级）**：
1. 立即删除 `window.electronAPI = electronAPI` 的兜底赋值（contextBridge 在 Electron 33 从未失败过；即便失败，应该报错而不是降级到"全权限暴露"）
2. `executeCommand` / `executeJs` / `executeTool` 这类高危方法，从 `electronAPI` 里拆分到单独的 internal bridge，只暴露给注入的 LingYa 覆盖层脚本（隔离世界），不暴露给页面

### 🔴 问题 2：Bearer token 落在 localStorage

**证据**：`src/providers/deepseek.js:158-176`

代码注释明确说"不再写 localStorage"，但实测该键存在。原因：**当前走 CDP 路径（useCdp=true），deepseekHookInstaller 不执行**，那么是谁写的？

需要定位。可能是历史版本残留（key 未清理），或 cdp-wiring 里有另一条写入路径。建议：
1. 在 CDP 路径下 `localStorage.removeItem('lingya-ds-headers')` 一次性清理
2. 排查 `src/main/cdp-wiring.js` 是否也写 localStorage

### 🔴 问题 3：DOM 注入量过大，66% 节点是 LingYa

529 / 802 节点。虽然不影响功能，但：
- 页面性能受影响（每次 DeepSeek 重渲染都要遍历这批节点）
- 任何 `document.body.children.length` 或 DOM 深度统计的检测都会命中

**建议**：
1. 把覆盖层挂到 **Shadow DOM**（`#lingya-root.attachShadow({mode:'closed'})`）里，页面 `querySelectorAll` 看不到内部
2. 但注意：Shadow DOM 无法完全隐藏 `document.getElementById('lingya-root')` 本身——容器节点仍在。至少可以把 460 个 class 和 30 个 id 藏掉

### 🟠 问题 4：UA-CH 缺 Google Chrome 品牌

这是 Electron 默认值。可在主进程 `session.setUserAgent` 时注入完整的 `userAgentData`：

```js
// 主进程
app.commandLine.appendSwitch('user-agent-client-hints',
  'brand: "Google Chrome", version: "130"');
```

或者用 `webContents.debugger.sendCommand('Network.setUserAgentOverride', { userAgent, userAgentMetadata })` 覆盖。

### 🟠 问题 5：CustomEvent 名明文

`lingya-ai-start` / `lingya-ai-response` / `lingya-hook-ready` / `lingya-user-message` / `lingya-ds-headers` 都是明文常量。任何检测脚本遍历 `['lingya-ai-response', 'cuckoo-ai-response', ...]` 都能命中。

**建议**：加一层事件名混淆（如基于 sessionId 的哈希），或改用 `window.postMessage` 的 messageChannel 私有端口。

### 🟡 问题 6：textarea 混入页面

6 个 LingYa textarea 会干扰 DeepSeek 自己的 `textarea` 选择器。代码已有 `isLingyaInjected` 守卫（deepseek.js:19-28），但**这是 LingYa 防自己，不是防页面检测**。页面 `document.querySelectorAll('textarea').length > 1` 即可判定。

---

## 四、结论

**LingYa 在"模拟人工输入"层面做得很好**：

- ✅ 输入走 CDP `Input.insertText`（isTrusted=true，不可区分）
- ✅ 发送走内核级 dispatchKeyEvent
- ✅ 不 hook 页面 fetch/XHR（0.6.30 起改用 CDP 旁路监听）
- ✅ contextIsolation + sandbox:false（进程隔离正常）
- ✅ 不伪造 fetch.toString（已移除 spoofNative）
- ✅ CDP debugger attach 页面无法从 JS 感知

**但"注入痕迹"层面暴露严重**：

- ❌ `window.electronAPI` 130 个方法全量挂主世界（含 executeCommand 任意命令执行）
- ❌ `localStorage['lingya-ds-headers']` 存 Bearer token + 设备指纹
- ❌ 66% DOM 节点是 LingYa 的，30+ 个 lingya id、460 个 lingya class
- ❌ UA-CH 缺 Google Chrome 品牌，`window.chrome` 空（指纹库直接判定 Electron）
- ❌ 5 个明文 CustomEvent 名

**一句话总结**：**LingYa 模拟"人打字"没问题，但模拟"人的浏览器"差得远。** 页面若只是风控（人机验证、行为分析），当前方案大概率能过；页面若做指纹识别（creepjs 级别），一行代码就会被判定为 Electron + 注入。

---

## 五、优先级建议（按风险/成本比）

| 优先级 | 动作 | 成本 | 收益 |
|---|---|---|---|
| P0 | 删除 `window.electronAPI = electronAPI` 兜底赋值 | 1 行 | 消除任意命令执行入口 |
| P0 | 清理 `localStorage['lingya-ds-headers']`，排查写入源 | 几行 | 消除 token 泄露 |
| P1 | 覆盖层迁入 Shadow DOM | 中 | 隐藏 460 class / 30 id |
| P1 | 加 UA-CH 完整品牌 + window.chrome 补全 | 小 | 消除 Electron 指纹 |
| P2 | CustomEvent 名加会话级盐 | 中 | 消除明文通道名 |
| P2 | 6 个 textarea 迁入 Shadow DOM | 小 | 消除 textarea 数量异常 |
