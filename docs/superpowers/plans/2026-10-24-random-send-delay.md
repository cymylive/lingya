# 发送延迟随机化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「快请求固定延迟」从单一固定值改为用户可配置的 [最小值, 最大值] 区间，每次发送在该区间内随机取值。

**Architecture:** 新增 `globalSendDelayMin` / `globalSendDelayMax` 两个 state 字段（默认均为 3000，等价于现状的固定 3000ms）。发送时若 min === max 则退化为固定值，否则在闭区间内均匀随机。旧的 `lingya-global-send-delay` localStorage 键做一次性迁移（迁移为 min=max=旧值），保证老用户配置不丢。

**Tech Stack:** Electron 33、纯 JS（无构建）、node:test 测试框架、localStorage + IPC setSetting 双通道持久化。

**Spec:** 本对话中的需求（用户确认：只作用于「快请求固定延迟」，UI 用两个输入框）。

## Global Constraints

- 慢请求自适应分支（`computeThinkAdaptiveDelay`）**不改动**。
- 调用方显式传入的 `fixedDelay` 参数**优先级最高，不参与随机**。
- `initialSendDelay`（首条消息兜底 1000ms）**不改动**。
- 随机必须是**闭区间均匀分布**：`[min, max]` 两端都可取到。
- 运行时若 `min > max`，自动交换，不得抛错（UI 已拦截，此为兜底）。
- 取值范围校验：0 ≤ min ≤ max ≤ 600000（与现有阈值上限一致）。
- 延迟决策记录到历史面板的既有逻辑必须保留（`send-delay-visibility.test.js` 的 5 条断言全绿）。

## Review Focus

1. **老用户配置迁移**：只在 localStorage 里存了旧键 `lingya-global-send-delay` 的用户，升级后第一次打开必须读到 min=max=旧值，而不是被重置成默认 3000/3000。
2. **min === max 的退化**：用户把两个框填成同一个数时，行为必须与改动前的固定延迟完全一致（而不是随机成别的值）。
3. **min > max 的输入**：UI 校验拦截并提示；若绕过 UI（如手动改 localStorage），运行时必须交换后仍能发送，不得卡死。
4. **随机只影响快请求分支**：慢请求自适应和调用方显式 fixedDelay 两条路径的取值必须逐字节不变。
5. **历史面板可读性**：随机后记录里必须能看出「本次取了多少、区间是多少」，否则用户仍无法判断随机是否生效。

---

### Task 1: state 字段 + 随机延迟计算

**Files:**
- Modify: `src/preload/dom/state.js:28-31`
- Modify: `src/preload/dom/chat-input.js:44-54`（恢复配置）、`src/preload/dom/chat-input.js:196-201`（快请求分支）
- Test: `test/preload/send-delay-random.test.js`（新建）

**Interfaces:**
- Produces:
  - `state.globalSendDelayMin: number`（默认 3000）
  - `state.globalSendDelayMax: number`（默认 3000）
  - `function pickGlobalDelay(): number` — 返回 [min, max] 闭区间内的整数
- Consumes: 无（本任务是最底层）

- [ ] **Step 1: 写失败测试**

新建 `test/preload/send-delay-random.test.js`：

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'chat-input.js'),
  'utf8'
);
const STATE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'state.js'),
  'utf8'
);

test('state 必须有 globalSendDelayMin / globalSendDelayMax，默认均为 3000', () => {
  assert.match(STATE, /globalSendDelayMin:\s*3000/, '必须定义 globalSendDelayMin 默认 3000');
  assert.match(STATE, /globalSendDelayMax:\s*3000/, '必须定义 globalSendDelayMax 默认 3000');
});

test('chat-input.js 必须定义 pickGlobalDelay 函数', () => {
  assert.match(SRC, /function pickGlobalDelay\s*\(/, '必须有 pickGlobalDelay');
});

test('pickGlobalDelay 必须是闭区间均匀随机（min + floor(random * (max-min+1))）', () => {
  const i = SRC.indexOf('function pickGlobalDelay');
  assert.ok(i >= 0, '必须有 pickGlobalDelay');
  const body = SRC.slice(i, i + 600);
  assert.match(body, /Math\.random\(\)/, '必须用 Math.random()');
  assert.match(body, /\+\s*1/, '区间跨度必须 +1（闭区间，两端可取）');
});

test('pickGlobalDelay 必须在 min > max 时自动交换（兜底，不抛错）', () => {
  const i = SRC.indexOf('function pickGlobalDelay');
  const body = SRC.slice(i, i + 600);
  assert.match(body, /min\s*>\s*max/, '必须处理 min > max 的情况');
});

test('快请求分支必须调用 pickGlobalDelay，而不是直接用 globalSendDelay', () => {
  const i = SRC.indexOf('快请求');
  assert.ok(i >= 0, '必须有快请求分支');
  const body = SRC.slice(Math.max(0, i - 600), i + 600);
  assert.match(body, /pickGlobalDelay\s*\(/, '快请求分支必须调用 pickGlobalDelay');
});

test('慢请求自适应分支不得调用 pickGlobalDelay', () => {
  const i = SRC.indexOf('computeThinkAdaptiveDelay');
  const body = SRC.slice(Math.max(0, i - 400), i + 800);
  assert.ok(!body.includes('pickGlobalDelay'), '慢请求分支不得随机');
});

test('必须支持从旧键 lingya-global-send-delay 迁移为 min=max', () => {
  assert.match(SRC, /lingya-global-send-delay-min/, '必须读取新键 min');
  assert.match(SRC, /lingya-global-send-delay-max/, '必须读取新键 max');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/preload/send-delay-random.test.js`
Expected: FAIL，多个断言报「必须有 globalSendDelayMin」等

- [ ] **Step 3: 在 state.js 新增字段**

在 `globalSendDelay: 3000,` 之后插入：

```javascript
  // 快请求延迟区间（闭区间，min === max 时等价于固定延迟）
  globalSendDelayMin: 3000,
  globalSendDelayMax: 3000,
```

保留 `globalSendDelay` 字段本身（有别的模块引用），但快请求分支不再读它。

- [ ] **Step 4: 在 chat-input.js 恢复逻辑里支持新键 + 旧键迁移**

把 `restoreThinkDelayConfig` 里读取 `lingya-global-send-delay` 的那段（当前 line 44-50）替换为：

```javascript
    // 快请求延迟区间：优先读新键；只有旧键时迁移为 min=max（老用户配置不丢）
    const gmin = localStorage.getItem('lingya-global-send-delay-min');
    const gmax = localStorage.getItem('lingya-global-send-delay-max');
    const gold = localStorage.getItem('lingya-global-send-delay');
    if (gmin !== null || gmax !== null) {
      const a = parseInt(gmin, 10);
      const b = parseInt(gmax, 10);
      if (Number.isFinite(a) && a >= 0) state.globalSendDelayMin = a;
      if (Number.isFinite(b) && b >= 0) state.globalSendDelayMax = b;
    } else if (gold !== null) {
      const n = parseInt(gold, 10);
      if (Number.isFinite(n) && n >= 0) {
        state.globalSendDelayMin = n;
        state.globalSendDelayMax = n;
      }
    }
```

- [ ] **Step 5: 新增 pickGlobalDelay 函数**

放在 `computeThinkAdaptiveDelay` 之后：

```javascript
/**
 * 计算快请求发送延迟：在 [globalSendDelayMin, globalSendDelayMax] 闭区间内均匀随机。
 * min === max 时退化为固定值（与旧行为一致）。
 * min > max 时自动交换（UI 已校验，此处兜底，避免卡死发送）。
 */
function pickGlobalDelay() {
  let min = Number(state.globalSendDelayMin);
  let max = Number(state.globalSendDelayMax);
  if (!Number.isFinite(min) || min < 0) min = 3000;
  if (!Number.isFinite(max) || max < 0) max = min;
  if (min > max) { const t = min; min = max; max = t; }
  if (min === max) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
```

- [ ] **Step 6: 快请求分支改用 pickGlobalDelay**

把 `chat-input.js` 里的：

```javascript
  } else {
    const globalDelay = Number(state.globalSendDelay) || 3000;
    sendDelay = globalDelay;
    branch = '快请求固定：往返 ' + thinkMs + 'ms ≤ 阈值 ' + threshold + 'ms → ' + globalDelay + 'ms';
  }
```

改为：

```javascript
  } else {
    const globalDelay = pickGlobalDelay();
    sendDelay = globalDelay;
    branch = '快请求随机：往返 ' + thinkMs + 'ms ≤ 阈值 ' + threshold +
      'ms → 区间 [' + state.globalSendDelayMin + ', ' + state.globalSendDelayMax +
      ']ms 内随机取 ' + globalDelay + 'ms';
  }
```

- [ ] **Step 7: 历史面板记录同步显示区间**

把 addHistory 的 output 数组里这一行：

```javascript
        'globalSendDelay（快请求固定延迟）: ' + state.globalSendDelay + 'ms',
```

改为：

```javascript
        'globalSendDelayMin/Max（快请求随机区间）: ' + state.globalSendDelayMin + ' ~ ' + state.globalSendDelayMax + 'ms',
        'globalSendDelay（本次实际取值）: ' + sendDelay + 'ms',
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --test test/preload/send-delay-random.test.js`
Expected: PASS（7 条全绿）

- [ ] **Step 9: 跑既有延迟测试确认没回归**

Run: `node --test test/preload/send-delay-visibility.test.js`
Expected: PASS（5 条全绿）。注意其中一条断言要求 `body.includes('globalSendDelay')` —— 新写法 `globalSendDelayMin/Max` 与 `globalSendDelay（本次实际取值）` 均包含该子串，满足。

- [ ] **Step 10: 提交**

```bash
git add src/preload/dom/state.js src/preload/dom/chat-input.js test/preload/send-delay-random.test.js
git commit -m "feat: 快请求发送延迟改为区间内随机"
```

---

### Task 2: 设置面板两个输入框

**Files:**
- Modify: `src/preload/shell-renderer.js:1695`（HTML 模板）
- Modify: `src/preload/shell-renderer.js:1724`（回填）
- Modify: `src/preload/shell-renderer.js:1728-1750`（保存与校验）
- Modify: `src/preload/dom/chat-input.js:566`（IPC setSetting 分支）
- Test: `test/preload/send-delay-random.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `state.globalSendDelayMin` / `state.globalSendDelayMax`
- Produces:
  - DOM 元素 id：`sh-set-dual-delay-min`、`sh-set-dual-delay-max`
  - localStorage 键：`lingya-global-send-delay-min`、`lingya-global-send-delay-max`
  - IPC 动作名：`global-send-delay-min`、`global-send-delay-max`

- [ ] **Step 1: 追加失败测试**

在 `test/preload/send-delay-random.test.js` 末尾追加：

```javascript
const SHELL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'shell-renderer.js'),
  'utf8'
);

test('设置面板必须有两个输入框：最小 / 最大', () => {
  assert.match(SHELL, /id="sh-set-dual-delay-min"/, '必须有最小值输入框');
  assert.match(SHELL, /id="sh-set-dual-delay-max"/, '必须有最大值输入框');
});

test('设置面板保存时必须校验 min <= max', () => {
  const i = SHELL.indexOf('sh-set-dual-delay-min');
  assert.ok(i >= 0, '必须有 min 输入框');
  const body = SHELL.slice(i, i + 2500);
  assert.match(body, /最小值不能大于最大值|min\s*>\s*max/i, '必须校验 min <= max');
});

test('设置面板回填必须读新键', () => {
  assert.match(SHELL, /lingya-global-send-delay-min/, '必须回填 min');
  assert.match(SHELL, /lingya-global-send-delay-max/, '必须回填 max');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/preload/send-delay-random.test.js`
Expected: 新增 3 条 FAIL

- [ ] **Step 3: 改 HTML 模板**

把 `shell-renderer.js:1695` 里这一段：

```html
<div style="display:flex;gap:4px;align-items:center;font-size:12px;margin-bottom:4px;"><span style="color:var(--ck-text-dim);">≤ 阈值 → 固定等</span><input id="sh-set-dual-delay" type="number" step="500" min="0" value="3000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">ms</span></div>
```

替换为：

```html
<div style="display:flex;gap:4px;align-items:center;font-size:12px;margin-bottom:4px;"><span style="color:var(--ck-text-dim);">≤ 阈值 → 随机等</span><input id="sh-set-dual-delay-min" type="number" step="500" min="0" value="3000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">~</span><input id="sh-set-dual-delay-max" type="number" step="500" min="0" value="3000" style="width:70px;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:4px;color:var(--ck-text);font-size:12px;" /><span style="color:var(--ck-text-dim);">ms</span></div>
```

- [ ] **Step 4: 改回填逻辑**

在 `loadSettingsCb` 里，把：

```javascript
v=localStorage.getItem('lingya-global-send-delay'); var e9=ev('sh-set-dual-delay'); if(v&&e9) e9.value=v;
```

替换为：

```javascript
v=localStorage.getItem('lingya-global-send-delay-min'); var e9=ev('sh-set-dual-delay-min'); if(v&&e9) e9.value=v;
v=localStorage.getItem('lingya-global-send-delay-max'); var e10=ev('sh-set-dual-delay-max'); if(v&&e10) e10.value=v;
```

- [ ] **Step 5: 改保存逻辑**

在 tss 的 click 处理里，把取 gl 的那行改为：

```javascript
      var glMin=parseInt((ev('sh-set-dual-delay-min')||{}).value,10);
      var glMax=parseInt((ev('sh-set-dual-delay-max')||{}).value,10);
```

校验段替换原有的 `if(!isFinite(gl)...)` 为：

```javascript
      if(!isFinite(glMin)||glMin<0||glMin>600000){ toast2('延迟最小值需在 0 - 600000ms 之间'); return; }
      if(!isFinite(glMax)||glMax<0||glMax>600000){ toast2('延迟最大值需在 0 - 600000ms 之间'); return; }
      if(glMin>glMax){ toast2('延迟最小值不能大于最大值'); return; }
```

持久化段追加：

```javascript
        localStorage.setItem('lingya-global-send-delay-min',String(glMin));
        localStorage.setItem('lingya-global-send-delay-max',String(glMax));
```

IPC 段追加：

```javascript
        window.shellAPI.setSetting('global-send-delay-min',glMin);
        window.shellAPI.setSetting('global-send-delay-max',glMax);
```

toast 文案改为：

```javascript
      toast2('已保存：≤' + th + 'ms 时在 ' + glMin + '~' + glMax + 'ms 内随机；超过则等「耗时×' + ratio + '」（最多 ' + maxDelay + 'ms）');
```

- [ ] **Step 6: 改 IPC 接收分支**

在 `chat-input.js` 的 `lingya-set-setting` 处理里，把 `else if (k === 'global-send-delay')` 那一行替换为：

```javascript
    else if (k === 'global-send-delay-min') { localStorage.setItem('lingya-global-send-delay-min', String(v)); state.globalSendDelayMin = Number(v); }
    else if (k === 'global-send-delay-max') { localStorage.setItem('lingya-global-send-delay-max', String(v)); state.globalSendDelayMax = Number(v); }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test test/preload/send-delay-random.test.js`
Expected: PASS（10 条全绿）

- [ ] **Step 8: 提交**

```bash
git add src/preload/shell-renderer.js src/preload/dom/chat-input.js test/preload/send-delay-random.test.js
git commit -m "feat: 设置面板支持配置发送延迟随机区间"
```

---

### Task 3: 全量回归与手动验证

**Files:**
- Test: 全量 `test/`

**Interfaces:**
- Consumes: Task 1、Task 2 的全部产出
- Produces: 无（收尾任务）

- [ ] **Step 1: 语法检查**

Run:
```bash
node --check src/preload/dom/state.js
node --check src/preload/dom/chat-input.js
node --check src/preload/shell-renderer.js
```
Expected: 三行都无输出（语法 OK）

- [ ] **Step 2: 全量测试**

Run: `node --test test/`
Expected: fail 0（当前基线 631 通过，本计划新增 10 条 → 641）

- [ ] **Step 3: 手动验证清单（需要用户操作，不阻塞提交）**

1. 设置面板 → 「≤ 阈值 → 随机等」，两个框填 2000 / 4000，保存 → toast 显示「2 秒~4 秒内随机」
2. 发一条消息触发快请求 → 历史面板查看 [发送延迟] 记录，区间显示 2000 ~ 4000ms，本次取值落在区间内
3. 连续发 3 次，三次取值不应完全相同（极小概率相同属正常）
4. 两个框都填 3000 → 行为与改动前完全一致（固定 3000）
5. 最小值填 5000、最大值填 1000 → 保存被拦截，toast 提示「最小值不能大于最大值」

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: 发送延迟随机化回归验证"
```
