# Playbook：UI 反馈消失类问题的排查

> 起因：用户报「工具在调用但面板没有任何提示」。排查发现是三条独立缺陷叠加，
> 每一条单独都足以让反馈消失。这里把排查路径固化成清单，下次遇到同类问题直接照做。

## 一、先分类：反馈链路有哪几段

任何「界面没反应」都要先定位断在哪一段，不要直接读代码：

```
业务事件发生
   ↓ ①
状态被记录（state / store）
   ↓ ②
渲染函数被调用
   ↓ ③
DOM 元素存在且可见
   ↓ ④
样式让它看得见
```

四段任一处断掉，用户看到的都是「什么都没发生」。**逐段验证**，不要凭直觉只查一处。

## 二、逐段验证清单

### ① 业务事件真的发生了吗

看日志确认，不要假设。例：

```
[LingYa][拦截] 检测到 JS 工具代码块（1 个），开始执行
[LingYa] 执行工具: bash
```

没有这行 → 问题在事件捕获层（拦截器 / hook / DOM 观察），不是 UI。

### ② 状态有没有被记录

如果代码里有状态机或 store，直接打印快照验证。LingYa 的做法：

```js
require("./src/preload/dom/task-state").snapshot()
// { state: "EXECUTING", enteredAt: 1729..., round: 3 }
```

状态正确但 UI 不动 → 渲染没订阅它（见 ③）。

### ③ 渲染函数被调用了吗

搜调用点，**注意调用时机**：

- 只在成功路径调？→ 失败时 UI 无变化
- 只在结束后调？→ 执行期间零反馈
- 容器初始带隐藏类？→ 有内容也看不见

LingYa 这次的三个问题分别命中：容器 `lingya-hidden`、只在 `await` 后调一次、失败路径也有卡片。

### ④ 样式真的生效了吗

**这是最容易漏的一段。** 验证方法：

```js
// 1. 元素存在吗
document.getElementById("lingya-tool-cards")?.children.length

// 2. 计算样式是什么（关键！）
getComputedStyle(document.querySelector(".lingya-tool-card")).border
// 返回 "0px none rgb(0, 0, 0)" = 样式没生效

// 3. 样式表注入了吗
document.getElementById("lingya-tool-card-style")
// null = 从未注入
```

本次根因：`tool-card.js` **定义并导出了** `TOOL_CARD_CSS`，还写了 `injectToolCardCSS()` 辅助函数，
但**全项目没有任何地方调用它**。卡片渲染成了裸 div，在深色页面上与普通文字无异。

> 教训：**「定义了」≠「被使用了」**。导出符号后必须 grep 确认有调用点。
> 检测命令：`grep "injectToolCardCSS" src/` → 只在定义和导出里出现 = 死代码。

## 三、高频陷阱

| 陷阱 | 表现 | 检测方法 |
|---|---|---|
| 样式定义了没注入 | 元素在但看不见 | `getComputedStyle` + 查 style 标签 |
| 容器默认 `hidden` | 要手动展开才见 | 查模板 HTML 的 class |
| 只在成功后渲染 | 执行期间无反馈 | 查调用点是否在 `await` 之后 |
| 每次追加不更新 | 同一条刷屏 | 需要 `cardId` + 原地替换 |
| Promise 永不 settle | 界面卡在上一个状态 | 所有外部调用加超时 |

## 四、超时：静默挂死必须显式失败

`await someExternalCall()` 在目标不可达时可能**永不 resolve**，整个处理链停摆且无任何提示。

LingYa 实例：`browser-window-manager.injectJS()` 裸 `await wc.executeJavaScript()`，
目标 webContents 卡死时 Agent 循环彻底停摆，用户只看到 AI 说「tool call seems to not be returning」。

标准写法：

```js
const TIMEOUT_MS = 60 * 1000;
let timer = null;
const timeout = new Promise((_res, rej) => {
  timer = setTimeout(() => rej(new Error("操作超时（60 秒无响应）")), TIMEOUT_MS);
});
let result;
try {
  result = await Promise.race([actualCall(), timeout]);
} finally {
  if (timer) { clearTimeout(timer); timer = null; }
}
```

**宁可显式失败让流程继续，也不要静默挂死。**

## 五、状态显示：单一真相源原则

如果 UI 状态由多处 `setXxx(true/false)` 拼成，必然出现「某条路径忘了调」的失明。

正确做法：

1. 一个状态机/store 做**唯一真相源**
2. 提供 `onChange(cb)` 订阅
3. 所有 UI 只订阅、不主动判断
4. 任何业务路径只负责 `transition()`

这样新增任何检测机制都自动同步 UI，不存在漏调。

详见 `.lingyaCode/notes/implemented/architecture/2026-10-22-task-state-as-single-source-of-truth.md`。

## 六、验证：从干净状态复现

改完后必须能回答：

1. 正常路径能看到反馈吗（执行中 → 成功）
2. 失败路径能看到反馈吗
3. 挂死场景会超时失败而不是卡住吗
4. 长时间运行反馈会消失吗

LingYa 的做法是加秒级心跳，让「已用时」持续走动——**用户能看到时间在走，就知道系统还活着**。
