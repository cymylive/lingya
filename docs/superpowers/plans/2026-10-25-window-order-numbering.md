# 窗口排序 / 编号 / 主窗口 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏「窗口管理」支持拖动排序、手动编号、标记主窗口（= 列表第一位，启动时自动打开的那个）。

**Architecture:** 复用现有 `profile-list.json` 作为唯一真相源。数组顺序即显示顺序，索引 0 即主窗口（启动时 `getDefaultProfile()` 已返回 `profiles[0]`，无需改窗口创建逻辑）。新增 `number` 字段存手动编号，读盘时对缺字段的老数据按当前顺序赋 1..n 并回写。主进程新增 2 个 IPC，preload 暴露 2 个方法，侧边栏渲染层加拖动 + 编号编辑。

**Tech Stack:** Electron 33 / CommonJS / node:test

**Spec:** 本会话 brainstorm 结论（主窗口=第一位、编号手动存盘、拖动排序、编号重复自动顺延、prompt 编辑）

## Global Constraints

- CommonJS（`require` / `module.exports`），不用 ESM
- 侧边栏既有元素 id 不得改动（`sh-win-body` / `sh-win-new` 保持）
- 新增 CSS 一律用 `.sh-*` 前缀，样式内联到 `shell-renderer.js` 的字符串里（与现有代码风格一致）
- 每个 Task 结束跑 `npm test`，732 用例 + 新增用例必须全绿
- 不修改 `src/main/index.js` 的 `createWindow` 逻辑（它已经取 `profiles[0]`）

## Review Focus

- **老用户升级**：`profile-list.json` 里 12 个窗口全无 `number` 字段 → 首次读取必须按当前顺序赋 1..12 并落盘，侧边栏不能出现 `undefined`
- **编号重复**：用户把 A 改成 3，而 B 已经是 3 → B 及所有 >3 的顺延 +1，最终编号集合必须是连续的 1..n
- **拖动越界**：从第 5 行拖到第 1 行、从第 1 行拖到第 5 行、拖到自己身上 → 三种都不能让数组丢元素或重复
- **主窗口被删**：删掉索引 0 的窗口后，原索引 1 自动成为主窗口，重启后打开它
- **单窗口**：只剩 1 个窗口时拖动和编号仍要能正常渲染，不能崩

---

### Task 1: profile-manager 增加 number 字段与老数据迁移

**Files:**
- Modify: `src/main/profile-manager.js:19-63`（readProfiles / writeProfiles / createProfile）
- Test: `test/main/profile-manager.test.js`（追加用例，复用文件内已有 electron mock）

**Interfaces:**
- Produces: `readProfiles(): Profile[]`，其中 `Profile.number` 为 `number`（1 起，唯一连续）
- Produces: `createProfile(name?: string, providerId?: string): Profile`，返回对象含 `number`

- [ ] **Step 1: 写失败测试**

追加到 `test/main/profile-manager.test.js`：

```js
test('createProfile 自动分配递增 number', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  const b = pm.createProfile('B');
  assert.strictEqual(a.number, 1);
  assert.strictEqual(b.number, 2);
});

test('readProfiles 为缺 number 的老数据补齐 1..n 并落盘', () => {
  const file = path.join(userDataDir, 'profile-list.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'p1', name: '旧A', providerId: 'deepseek', partition: 'persist:p1' },
    { id: 'p2', name: '旧B', providerId: 'deepseek', partition: 'persist:p2' },
    { id: 'p3', name: '旧C', providerId: 'deepseek', partition: 'persist:p3' },
  ]), 'utf-8');
  const pm = require('../../src/main/profile-manager');
  const list = pm.readProfiles();
  assert.deepStrictEqual(list.map(p => p.number), [1, 2, 3]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(raw.map(p => p.number), [1, 2, 3]);
});

test('readProfiles 对已有 number 的数据不改写', () => {
  const file = path.join(userDataDir, 'profile-list.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'p1', name: 'A', number: 5 },
    { id: 'p2', name: 'B', number: 9 },
  ]), 'utf-8');
  const pm = require('../../src/main/profile-manager');
  const list = pm.readProfiles();
  assert.deepStrictEqual(list.map(p => p.number), [5, 9]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/main/profile-manager.test.js`
Expected: 前两条 FAIL（`a.number` 为 undefined；老数据 number 缺失），第三条 PASS

- [ ] **Step 3: 实现迁移与分配**

在 `profile-manager.js` 的 `readProfiles` 里，解析成功后插入迁移；`writeProfiles` 不变；`createProfile` 里给新对象加 `number`。

```js
/** 为缺 number 的 profile 按当前顺序补 1..n；返回是否发生了修改 */
function ensureNumbers(profiles) {
  let changed = false;
  for (let i = 0; i < profiles.length; i++) {
    const n = profiles[i].number;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) {
      profiles[i].number = i + 1;
      changed = true;
    }
  }
  return changed;
}
```

`readProfiles` 改为：

```js
function readProfiles() {
  try {
    const file = getProfileFile();
    if (fs.existsSync(file)) {
      const profiles = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(profiles) && ensureNumbers(profiles)) writeProfiles(profiles);
      return Array.isArray(profiles) ? profiles : [];
    }
  } catch (err) { /* 原有日志保留 */ }
  return [];
}
```

`createProfile` 里 `const profile = {...}` 加一行 `number: profiles.length + 1,`。

- [ ] **Step 3b: 补「主窗口被删」用例**

```js
test('删除第一个 profile 后 getDefaultProfile 返回新的第一个', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  const b = pm.createProfile('B');
  pm.deleteProfile(a.id);
  assert.strictEqual(pm.getDefaultProfile().id, b.id);
});

test('只有一个 profile 时 getDefaultProfile 返回它', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('独苗');
  assert.strictEqual(pm.getDefaultProfile().id, a.id);
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/main/profile-manager.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/profile-manager.js test/main/profile-manager.test.js
git commit -m "feat(profile): add number field with legacy migration"
```

---

### Task 2: 排序与编号调整

**Files:**
- Modify: `src/main/profile-manager.js`（新增两个导出函数）
- Test: `test/main/profile-manager.test.js`

**Interfaces:**
- Consumes: Task 1 的 `readProfiles()` / `writeProfiles(profiles)`
- Produces: `reorderProfiles(orderedIds: string[]): Profile[] | null` — 按给定 id 顺序重排数组并落盘；`orderedIds` 为空或非数组返回 `null`。未出现在 `orderedIds` 的 profile 追加到末尾（保持原相对顺序）
- Produces: `updateProfileNumber(id: string, number: number): Profile[] | null` — 设置某 profile 的 number；若该 number 已被他人占用，占用者及所有 `number >= 目标值` 的其他 profile 全部 +1，再把目标设为 `number`。id 不存在或 number 非法（非正整数）返回 `null`
- Produces: `moveIdBefore(ids: string[], dragId: string, targetId: string): string[]` — 纯函数，把 `dragId` 移到 `targetId` 所在位置（插在 target 之前）。任一 id 不在数组中、或两者相同，返回原数组的**副本**（不修改入参）。供渲染层拖动调用，便于单元测试

- [ ] **Step 1: 写失败测试**

```js
test('reorderProfiles 按给定 id 顺序重排并落盘', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  const b = pm.createProfile('B');
  const c = pm.createProfile('C');
  const out = pm.reorderProfiles([c.id, a.id, b.id]);
  assert.deepStrictEqual(out.map(p => p.name), ['C', 'A', 'B']);
  assert.deepStrictEqual(pm.readProfiles().map(p => p.name), ['C', 'A', 'B']);
});

test('reorderProfiles 遗漏的 id 追加到末尾', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  const b = pm.createProfile('B');
  const out = pm.reorderProfiles([b.id]);
  assert.deepStrictEqual(out.map(p => p.name), ['B', 'A']);
});

test('reorderProfiles 非法输入返回 null', () => {
  const pm = require('../../src/main/profile-manager');
  assert.strictEqual(pm.reorderProfiles(null), null);
  assert.strictEqual(pm.reorderProfiles([]), null);
});

test('updateProfileNumber 无冲突时直接改', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  pm.createProfile('B');
  const out = pm.updateProfileNumber(a.id, 7);
  assert.strictEqual(out.find(p => p.id === a.id).number, 7);
});

test('updateProfileNumber 冲突时占用者及其后顺延', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A'); // 1
  const b = pm.createProfile('B'); // 2
  const c = pm.createProfile('C'); // 3
  const d = pm.createProfile('D'); // 4
  // 把 A 改成 2 → 原 2(B) 变 3，原 3(C) 变 4，原 4(D) 变 5
  const out = pm.updateProfileNumber(a.id, 2);
  assert.strictEqual(out.find(p => p.id === a.id).number, 2);
  assert.strictEqual(out.find(p => p.id === b.id).number, 3);
  assert.strictEqual(out.find(p => p.id === c.id).number, 4);
  assert.strictEqual(out.find(p => p.id === d.id).number, 5);
});

test('updateProfileNumber 非法输入返回 null', () => {
  const pm = require('../../src/main/profile-manager');
  const a = pm.createProfile('A');
  assert.strictEqual(pm.updateProfileNumber('bad', 2), null);
  assert.strictEqual(pm.updateProfileNumber(a.id, 0), null);
  assert.strictEqual(pm.updateProfileNumber(a.id, 1.5), null);
});
```

- [ ] **Step 1b: 追加 moveIdBefore 测试**

```js
test('moveIdBefore 从后往前移', () => {
  const pm = require('../../src/main/profile-manager');
  assert.deepStrictEqual(pm.moveIdBefore(['a','b','c','d'], 'd', 'a'), ['d','a','b','c']);
});

test('moveIdBefore 从前往后移', () => {
  const pm = require('../../src/main/profile-manager');
  assert.deepStrictEqual(pm.moveIdBefore(['a','b','c','d'], 'a', 'd'), ['b','c','a','d']);
});

test('moveIdBefore 自己拖自己保持原顺序且不修改入参', () => {
  const pm = require('../../src/main/profile-manager');
  const input = ['a','b','c'];
  const out = pm.moveIdBefore(input, 'b', 'b');
  assert.deepStrictEqual(out, ['a','b','c']);
  assert.notStrictEqual(out, input);
});

test('moveIdBefore id 不存在时返回原数组副本', () => {
  const pm = require('../../src/main/profile-manager');
  const input = ['a','b'];
  assert.deepStrictEqual(pm.moveIdBefore(input, 'zz', 'a'), ['a','b']);
  assert.deepStrictEqual(pm.moveIdBefore(input, 'a', 'zz'), ['a','b']);
});

test('moveIdBefore 空数组 / 单元素不崩', () => {
  const pm = require('../../src/main/profile-manager');
  assert.deepStrictEqual(pm.moveIdBefore([], 'a', 'b'), []);
  assert.deepStrictEqual(pm.moveIdBefore(['x'], 'x', 'x'), ['x']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/main/profile-manager.test.js`
Expected: 10 条新用例 FAIL（`pm.reorderProfiles is not a function` / `pm.moveIdBefore is not a function`）

- [ ] **Step 3: 实现两个函数并导出**

```js
function reorderProfiles(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return null;
  const profiles = readProfiles();
  const byId = new Map(profiles.map(p => [p.id, p]));
  const out = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p) { out.push(p); byId.delete(id); }
  }
  for (const p of profiles) if (byId.has(p.id)) out.push(p);
  writeProfiles(out);
  return out;
}

function updateProfileNumber(id, number) {
  if (!id || !Number.isInteger(number) || number < 1) return null;
  const profiles = readProfiles();
  const target = profiles.find(p => p.id === id);
  if (!target) return null;
  if (target.number === number) return profiles;
  for (const p of profiles) {
    if (p.id === id) continue;
    if (p.number >= number) p.number += 1;
  }
  target.number = number;
  writeProfiles(profiles);
  return profiles;
}
```

```js
function moveIdBefore(ids, dragId, targetId) {
  const src = Array.isArray(ids) ? ids.slice() : [];
  const from = src.indexOf(dragId);
  const to = src.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return src;
  src.splice(from, 1);
  const insertAt = src.indexOf(targetId);
  src.splice(insertAt, 0, dragId);
  return src;
}
```

`module.exports` 追加 `reorderProfiles, updateProfileNumber, moveIdBefore`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/main/profile-manager.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/profile-manager.js test/main/profile-manager.test.js
git commit -m "feat(profile): add reorderProfiles and updateProfileNumber"
```

---

### Task 3: 主进程 IPC + preload 暴露

**Files:**
- Modify: `src/main/index.js:1091-1109`（在 `list-profiles` 之后插入两个 handler）
- Modify: `src/preload/shell-preload.js:102-104`（新增两个方法）

**Interfaces:**
- Produces（IPC）: `reorder-profiles` 收 `{ orderedIds: string[] }` → 返回 `{ success: boolean, profiles?: Profile[], error?: string }`
- Produces（IPC）: `update-profile-number` 收 `{ profileId: string, number: number }` → 返回同上
- Produces（渲染层）: `window.shellAPI.reorderProfiles(orderedIds)`、`window.shellAPI.updateProfileNumber(profileId, number)`

- [ ] **Step 1: 在 `src/main/index.js` 的 `list-profiles` handler 后插入**

```js
// 调整窗口顺序（数组顺序即显示顺序，第一位为主窗口）
ipcMainForProfile.handle('reorder-profiles', async (_event, { orderedIds } = {}) => {
  const out = profileManager.reorderProfiles(orderedIds);
  if (!out) return { success: false, error: '参数无效' };
  return { success: true, profiles: out };
});

// 修改窗口编号（重复时占用者及其后顺延）
ipcMainForProfile.handle('update-profile-number', async (_event, { profileId, number } = {}) => {
  const out = profileManager.updateProfileNumber(profileId, number);
  if (!out) return { success: false, error: '参数无效或窗口不存在' };
  return { success: true, profiles: out };
});
```

- [ ] **Step 2: 在 `src/preload/shell-preload.js` 的 `createProfileWindow` 行后插入**

```js
  reorderProfiles: (orderedIds) => ipcRenderer.invoke('reorder-profiles', { orderedIds }),
  updateProfileNumber: (profileId, number) => ipcRenderer.invoke('update-profile-number', { profileId, number }),
```

- [ ] **Step 3: 验证语法与现有测试**

Run: `npm test`
Expected: 全绿（无新增测试，确认没破坏已有 732 例）

- [ ] **Step 4: 提交**

```bash
git add src/main/index.js src/preload/shell-preload.js
git commit -m "feat(ipc): add reorder-profiles and update-profile-number"
```

---

### Task 4: 侧边栏渲染编号与主窗口徽标

**Files:**
- Modify: `src/preload/shell-renderer.js:1995-2021`（整段 `renderWindowsView` 替换）

**Interfaces:**
- Consumes: `window.shellAPI.listProfiles()` 返回 `{ success, profiles }`，每项含 `id / name / providerId / number`
- Produces: 每行 DOM 结构——`div.sh-win-row[data-id][draggable="true"]` 内含 `span.sh-win-num`（编号，点击编辑）、可选 `span.sh-win-main`（第一位才渲染，文案「主」）、`span.sh-win-open`（名称）、`span.sh-win-rename`、`span.sh-win-del`
- Produces: 元素 id `sh-win-body` / `sh-win-new` 不变

- [ ] **Step 1: 替换 `renderWindowsView` 函数体**

保留外层 `panel(...)` 与新建按钮逻辑，把列表渲染改为：

```js
for (var i = 0; i < list.length; i++) {
  var w = list[i];
  var isMain = (i === 0);
  h += '<div class="sh-list-item sh-win-row" draggable="true" data-id="' + esc(w.id) + '" data-idx="' + i + '">'
    + '<div style="display:flex;align-items:center;gap:6px;">'
    + (isMain ? '<span class="sh-win-main" style="font-size:9px;padding:1px 4px;border-radius:3px;background:#2dd4bf;color:#0b0e14;font-weight:700;">主</span>' : '')
    + '<span class="sh-win-num" style="font-size:11px;color:var(--ck-text-dim);cursor:pointer;" title="点击修改编号">' + esc(String(w.number || (i + 1))) + '</span>'
    + '<span class="sh-win-open" data-id="' + esc(w.id) + '" style="font-weight:600;color:var(--ck-title);flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">' + esc(w.name) + '</span>'
    + '<span style="font-size:10px;color:var(--ck-text-dim);">' + esc(w.providerId || '平台') + '</span>'
    + '<span class="sh-win-rename" data-id="' + esc(w.id) + '" data-name="' + esc(w.name) + '" style="cursor:pointer;font-size:11px;color:var(--ck-text);">改名</span>'
    + '<span class="sh-win-del" data-id="' + esc(w.id) + '" data-name="' + esc(w.name) + '" style="cursor:pointer;font-size:11px;color:#f87171;">删除</span>'
    + '</div></div>';
}
```

编号点击编辑沿用现有 `q()` 选择器绑定模式，追加：

```js
q('.sh-win-num', function (id) {
  var cur = null;
  for (var k = 0; k < list.length; k++) if (list[k].id === id) cur = list[k].number;
  var nv = prompt('新编号', String(cur || ''));
  if (nv == null) return;
  var n = parseInt(nv, 10);
  if (!n || n < 1) { toast2('编号需为正整数'); return; }
  window.shellAPI.updateProfileNumber(id, n).then(function (r2) {
    toast2(r2 && r2.success ? '编号已更新' : '更新失败'); load();
  })['catch'](function () {});
});
```

`q()` 的现签名回调是 `fn(id, name)`，`.sh-win-num` 只带 `data-id`，name 会是 `null`，可忽略。

- [ ] **Step 2: 手工验证（启动应用）**

Run: `set "PATH=D:\NodeJS;%PATH%" && npm start`
Expected: 侧边栏 → 窗口管理，每行左侧显示数字，第一行数字前有青色「主」徽标；点数字弹 prompt，输入 5 后列表刷新且该窗口显示 5

- [ ] **Step 3: 跑测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add src/preload/shell-renderer.js
git commit -m "feat(sidebar): render window number and primary badge"
```

---

### Task 5: 拖动排序

**Files:**
- Modify: `src/preload/shell-renderer.js`（`renderWindowsView` 内，在 `q()` 绑定之后追加拖动事件）

**Interfaces:**
- Consumes: Task 3 的 `window.shellAPI.reorderProfiles(orderedIds)`
- Consumes: Task 4 渲染出的 `.sh-win-row[data-id]`
- Consumes: Task 2 的 `moveIdBefore` —— **preload 层不直接调主进程纯函数**，拖动时在渲染层用同样的 splice 逻辑重组（见 Step 1），`moveIdBefore` 的单元测试保证该逻辑正确
- Produces: 拖动结束后数组顺序改变，第一行自动带「主」徽标

- [ ] **Step 1: 追加拖动逻辑**

```js
var dragId = null;
var rows = box.querySelectorAll('.sh-win-row');
for (var di = 0; di < rows.length; di++) {
  (function (row) {
    row.addEventListener('dragstart', function (e) {
      dragId = row.getAttribute('data-id');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
    });
    row.addEventListener('dragover', function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      var targetId = row.getAttribute('data-id');
      if (!dragId || dragId === targetId) return;
      // 与 src/main/profile-manager.js 的 moveIdBefore 保持同一算法（渲染层无法 require 主进程模块）
      var ids = list.map(function (x) { return x.id; });
      var from = ids.indexOf(dragId);
      var to = ids.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) { dragId = null; return; }
      ids.splice(from, 1);
      ids.splice(ids.indexOf(targetId), 0, dragId);
      window.shellAPI.reorderProfiles(ids).then(function (r2) {
        toast2(r2 && r2.success ? '顺序已更新' : '排序失败'); load();
      })['catch'](function () {});
      dragId = null;
    });
  })(rows[di]);
}
```

- [ ] **Step 2: 手工验证**

Run: `npm start` → 侧边栏 → 窗口管理
Expected: 把第 3 行拖到第 1 行后，「主」徽标出现在原第 3 行；重启应用后仍是这个顺序；关闭再打开 LingYa 时自动打开的是这个窗口

- [ ] **Step 3: 跑测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add src/preload/shell-renderer.js
git commit -m "feat(sidebar): drag to reorder windows"
```
