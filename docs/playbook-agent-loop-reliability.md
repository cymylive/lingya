# Playbook：Agent 循环的可靠性设计

> 起因：LingYa 出现「AI 说在调工具，界面上什么都没有」。
> 深挖发现不是单个 bug，而是**事件驱动架构的静默失败**这一类问题。

## 一、Agent 循环的本质脆弱性

```
用户输入 → AI 生成 → 拦截回复 → 解析工具调用 → 执行 → 回传结果 → AI 继续
                ↑                                              ↓
                └──────────────── 依赖事件 ────────────────────┘
```

**每一个箭头都是事件或 Promise，每一个都可能静默断裂。**

断裂后用户看到的是「AI 不说话了」，没有任何错误提示——这才是最危险的。

## 二、四类断裂点与对策

### 类型 1：事件根本不来

**场景**：hook 注入失败、流没收尾、页面异常导致 `lingya-ai-response` 事件永不触发。

**对策**：**独立心跳监督者**，不依赖任何事件。

```js
// supervisor.js：纯定时器，每 30 秒检查一次
setInterval(() => {
  const idleMs = Date.now() - state.lastActivityAt;
  if (idleMs > STALL_THRESHOLD && hasUnfinishedWork()) {
    sendMessageToChat("【监督续跑】检测到你已 N 秒没动作…");
  }
}, 30000);
```

**关键设计**：
- 心跳独立于业务事件链（哪怕全挂也能跑）
- 有「已声明完成」标志，避免 AI 说完成后还被反复催
- 催促次数有上限 + 降频，避免死循环

### 类型 2：Promise 永不 settle

**场景**：`await wc.executeJavaScript()` 在目标 webContents 卡死时永不 resolve。

**对策**：**所有外部调用加超时**，显式失败优于静默挂起。

```js
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_r, rej) => {
    timer = setTimeout(() => rej(new Error(label + " 超时")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

**超时值选取**：必须**大于**内层自身的 deadline，否则会误杀正常的长任务。
例：JsRunner 内部 660s → 外层给 720s。

### 类型 3：状态显示与实际脱节

**场景**：UI 状态由 4 个模块各调 `setXxx()`，任一处漏调就停在上一个状态。

**对策**：**单一真相源 + 订阅**。

```
业务层 ──transition()──► 状态机 ──onChange()──► UI
                              │
                              └──► 监督者读快照判断停滞
```

业务代码**只负责报告状态**，不碰 UI。新增任何检测机制都自动同步。

### 类型 4：反馈只在成功路径出现

**场景**：卡片只在 `await` 返回后渲染，执行期间用户什么都看不到。

**对策**：**执行前先渲染 running 态，完成后原地更新**。

```js
const cardId = genId();
renderCard(cardId, name, "running");      // 先出现
try {
  const r = await execute();
  renderCard(cardId, name, "success", r); // 原地替换
} catch (e) {
  renderCard(cardId, name, "error", e);   // 失败也要有卡片
}
```

**要点**：`cardId` 让「同一件事」是一个条目而不是两条记录。

## 三、设计检查清单

给 Agent 类应用做可靠性审查时逐条过：

| # | 检查项 | 不合格的表现 |
|---|---|---|
| 1 | 有没有不依赖事件的监督者 | 事件一断就永远停 |
| 2 | 所有外部 await 都有超时吗 | 偶尔整机卡死无提示 |
| 3 | 状态是单一真相源吗 | 某条路径忘了调 UI 就不更新 |
| 4 | UI 有订阅机制吗 | 新增功能要记得手动加刷新 |
| 5 | 执行中能看到反馈吗 | 用户以为没跑 |
| 6 | 失败路径也更新 UI 吗 | 失败了但界面无变化 |
| 7 | 长任务有进度感吗 | 等 3 分钟不知道死没死 |
| 8 | 后台任务有归属吗 | AI 这轮结束，进程还在跑但界面不管了 |

## 四、反模式

### ❌ 用轮询代替订阅

```js
setInterval(refreshUI, 30000);  // 用户最多 30 秒看不到变化
```
正确：`state.onChange(refreshUI)` + 秒级心跳只刷计时。

### ❌ 在业务代码里判断 UI

```js
if (toolName === "bash") setStatus("executing");
```
正确：`taskState.transition(EXECUTING)`，UI 自己决定怎么显示。

### ❌ 静默 catch

```js
try { ... } catch (_) {}   // 断了没人知道
```
正确：至少 `console.error`，并让 UI 反映失败。

### ❌ 把并行关系塞进串行状态机

后台任务和 AI 生成是**并行**的（可能同时在跑）。
塞进同一个状态枚举会导致互斥——应该用独立的登记表叠加显示。

## 五、验证方法

改完必须能回答这四个问题：

1. **正常路径**：执行中 → 成功，全程有反馈吗
2. **失败路径**：报错时界面变了吗
3. **挂死场景**：外部调用不返回时，会超时失败还是永久卡住
4. **长时运行**：等 5 分钟，反馈还在吗、用户知道系统还活着吗

第 4 条最容易被忽略——**秒级计时**是廉价而有效的「我还活着」信号。
