# Agent Note: 代码块识别漏掉 js 围栏 + 无 todo 兜底导致任务提前结束

Status: implemented

## Problem

0.6.197 修复了「脱敏把 lingya 围栏换成占位符导致识别不到」的问题，但用户实测仍有「任务提前结束」。

新日志（`chat.deepseek.com-1793887958411.log`）分析：

- 346 / 362 / 378 / 397 / 422 行：代码块**成功识别并执行**（证明 0.6.197 的 unredact 修复有效）
- **415 行**：805 字符回复，识别失败 → reset IDLE
- **447 行**：17765 字符回复（60s 超时），识别失败 → reset IDLE

**两个独立缺口**：

### 缺口 1：js 围栏的 `onlyFences` 限制

`js-detector.js` 的 `extractJsToolBlocks` 对 `js` / `javascript` 围栏有一个硬条件：

```js
} else if ((l === 'js' || l === 'javascript') && onlyFences && looksLikeToolScript(code)) {
```

`onlyFences`（由 `hasOnlyFences()` 计算）要求整条回复**只包含代码块**，不能有任何正文。

问题场景：AI 回复「我来查一下，代码如下：」+ ```js 代码块。因为有正文，`onlyFences=false`，代码块被完全忽略。

**为什么 AI 会用 `js` 围栏**：系统提示词里的 ```lingya 被脱敏成 ```lingya，AI 看到不认识的围栏语言，可能改用自己熟悉的 `js`。0.6.197 修复了「照抄占位符」的情况（unredact 能还原），但没覆盖「AI 主动改用 js」的情况。

### 缺口 2：reset 前不查 todo

`intercept-observer.js:548` 的收尾逻辑：

```js
// 计划已完成 / 本就无计划 → 收尾
console.log('[LingYa][拦截] 正常文本回复，未检测到工具调用，且无未完成计划');
...
taskState.reset('一轮循环正常收尾');
```

**「且无未完成计划」只是日志字符串，代码根本没查 todo 列表。** 推理链是：

```
本轮没有工具调用代码块
  → 假设「任务已经完了」
  → reset IDLE
```

只要代码块识别失败（缺口 1），任务就会被误判完成。

## Decision

### 修复 1：js 围栏放宽 + 严格判定

新增 `looksLikeRealToolScript(code)`：要求代码块**第一行实质内容**（跳过空行和 `//` / `/*` / `*` 注释）就是工具调用：

```js
if (/^await\s+[A-Za-z_$][\w$]*\s*\(/.test(t)) return true;
if (/^(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+[A-Za-z_$][\w$]*\s*\(/.test(t)) return true;
```

`extractJsToolBlocks` 的判定改为：

```js
// 原：只认 onlyFences
} else if ((l === 'js' || l === 'javascript') && onlyFences && looksLikeToolScript(code)) {

// 改：纯代码块用宽松判定，正文混合用严格判定
} else if (l === 'js' || l === 'javascript') {
  if ((onlyFences && looksLikeToolScript(code)) || looksLikeRealToolScript(code)) {
    blocks.push(code);
  }
}
```

**为什么不直接去掉 `onlyFences`**：会让文档示例代码（`const x = 1; console.log(x)`）被当成工具脚本执行，造成误伤。加 `looksLikeRealToolScript` 这道更严格的门槛，既放宽了工具调用场景，又保住了示例代码的边界。

### 修复 2：reset 前真的查 todo

在收尾日志之前插入：

```js
try {
  const api = (typeof window !== 'undefined' && window.electronAPI) || {};
  if (typeof api.getTodos === 'function') {
    const r = await api.getTodos();
    const todos = (r && Array.isArray(r.todos)) ? r.todos : [];
    const pending = todos.filter(t => t && t.status !== 'completed');
    if (pending.length > 0) {
      console.log('[LingYa][拦截] 还有 ' + pending.length + ' 个未完成 todo，不结束任务，发催促继续');
      // 不 reset，主动发催促
      const { sendToChat } = require('./chat-input');
      sendToChat('任务还没完成，请继续执行未完成的步骤。', '继续任务', undefined, undefined, { auto: true }).catch(() => {});
      return;
    }
  }
} catch (_) { /* 查 todo 失败则退回原逻辑 */ }
```

**为什么用 `window.electronAPI.getTodos()` 而不是直接 require IPC**：preload 的隔离世界里 `window.electronAPI` 是 `api.js` 暴露的完整对象（含 `getTodos`），可以直接调用。不需要再走 `ipcRenderer.invoke`。

**为什么用 `status !== 'completed'` 而不是 `status === 'pending'`**：todo 有三种状态 `pending` / `in_progress` / `completed`。`in_progress` 也是未完成。用「不等于 completed」覆盖两种。

## Alternatives considered

**直接去掉 `onlyFences` 限制** —— 落选原因：会误伤文档示例代码。AI 在回答「JavaScript 怎么写」时输出 ```js 示例，如果被当成工具脚本执行，轻则报错，重则产生副作用（比如示例里有 `writeFile` 就把文件写了）。必须保留「不是所有 js 代码块都执行」的边界。

**用 `looksLikeToolScript` 而不是新增 `looksLikeRealToolScript`** —— 落选原因：`looksLikeToolScript` 只要求代码块**任意位置**出现 `await read(...)`，示例代码里也可能有。`looksLikeRealToolScript` 要求**第一行实质内容**就是工具调用，门槛更严，误判率更低。

**修复 2 用 `getTodos` 的返回值直接判断，不区分 pending / in_progress** —— 落选原因：如果 todo 全部 completed 但不清理（用户没点「清空」），会被误判为「还有任务」。必须精确过滤。

**修复 2 里发催促用 `watchdogPrompt`（默认「请继续」）** —— 落选原因：太模糊。用「任务还没完成，请继续执行未完成的步骤」更明确，AI 更容易理解上下文。

**修复 2 里 reset 前查 todo，但查失败时不 reset** —— 落选原因：查 todo 可能失败（IPC 异常 / 规则表异常）。查失败应该退回原逻辑（reset），否则会卡死在 RESPONDED 无限等。所以用了 `catch (_) { /* 退回原逻辑 */ }`。

## Consequences

**收益**：

- **修复「正文 + js 代码块」场景**：AI 说「我来查一下」+ ```js 代码块不再被漏掉
- **修复「无代码块但 todo 未完成」场景**：即使代码块识别全失败，只要 todo 里有 pending/in_progress，就不 reset，主动发催促
- **边界测试 8/8 通过**：覆盖 lingya 围栏 / js 围栏 + 正文 / const x = await / 注释开头 / 纯示例代码 / 普通函数定义 / 纯 js / 无代码块
- **单测 16/16 通过**：更新了「js 块仅当只有代码块」测试，改为断言新行为
- **全量测试 1298/1298 零失败**

**代价**：

- `looksLikeRealToolScript` 只看第一行，如果 AI 在工具调用前写了 2 行以上说明性注释（非 `//` 格式，比如多行字符串），可能仍识别不到。极端场景，可接受
- 修复 2 每次收尾多一次 IPC 调用（`getTodos`）。实测 < 1ms，可忽略
- 修复 2 在 todo 未完成时发催促，如果 AI 连续不响应，可能形成循环催促。目前依赖 watchdog 的 `watchdogCount` 上限（默认 10 次）兜底
- `looksLikeRealToolScript` 的「第一行实质内容」判定对换行符敏感（Windows `\r\n` vs Unix `\n`）。代码里用 `String.fromCharCode(10)` 分割，兼容两种

## 备注

- 修复 1：`src/preload/dom/js-detector.js` 的 `looksLikeRealToolScript`（新增）+ `extractJsToolBlocks` 的 js 判定条件
- 修复 2：`src/preload/dom/intercept-observer.js` 的收尾日志之前（约 548 行）
- todo 接口：`src/preload/api.js` 的 `getTodos: () => ipcRenderer.invoke('get-todos')`
- 测试更新：`test/preload/js-detector.test.js` 的「js 块仅当只有代码块」
- 备份：两个文件的 `.bak-jsfence-20261105`
- 全量测试：1298 / 1298 通过
