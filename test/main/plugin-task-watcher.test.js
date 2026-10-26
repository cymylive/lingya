/**
 * 任务守望者插件 —— 结构与配置归一化测试
 *
 * 该插件的核心逻辑（定时检查 / 催促）跑在 preload 注入脚本里，无法在 Node
 * 环境直接执行。这里覆盖可静态验证的部分：
 *   1. manifest 完整性（id / entry 存在，且目录下有 index.js）
 *   2. 插件源码必须注册 preload 脚本、注册侧栏视图、暴露两个 IPC 通道
 *   3. 注入脚本必须包含全部防误催闸门（停止 / 等用户 / 分批 / 已声明完成）
 *   4. saveConfig 的数值归一化（阈值下限、上限、非法输入回退）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'plugins', 'task-watcher');
const MANIFEST = path.join(PLUGIN_DIR, 'manifest.json');
const ENTRY = path.join(PLUGIN_DIR, 'index.js');

function readSrc() {
  return fs.readFileSync(ENTRY, 'utf-8');
}

test('manifest 完整且指向存在的入口文件', () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  assert.strictEqual(m.id, 'task-watcher');
  assert.ok(m.name && m.name.length > 0, '必须有名称');
  assert.ok(m.version, '必须有版本号');
  assert.strictEqual(m.entry, 'index.js');
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, m.entry)), '入口文件必须存在');
});

test('插件导出 apply 与 inject', () => {
  const src = readSrc();
  assert.ok(/export\s+function\s+apply\s*\(/.test(src), '必须导出 apply(ctx)');
  assert.ok(/export\s+const\s+inject\s*=/.test(src), '必须导出 inject');
});

test('必须注册 preload 脚本与侧栏视图', () => {
  const src = readSrc();
  assert.ok(src.includes('ctx.registerPreload('), '必须注册 preload 脚本');
  assert.ok(src.includes('ctx.registerView('), '必须注册侧栏面板');
});

test('必须暴露 getConfig / saveConfig 两个 IPC 通道', () => {
  const src = readSrc();
  assert.ok(src.includes("ctx.registerIpc('getConfig'"), '缺少 getConfig');
  assert.ok(src.includes("ctx.registerIpc('saveConfig'"), '缺少 saveConfig');
});

test('注入脚本必须包含全部防误催闸门', () => {
  const src = readSrc();
  // 四个前置条件：停止 / 等用户 / 分批发送 / 已声明完成
  assert.ok(src.includes('st.stopped'), '缺少 stopped 闸门');
  assert.ok(src.includes('st.awaitingUserInput'), '缺少 awaitingUserInput 闸门');
  assert.ok(src.includes('st.awaitingNextInitialChunk'), '缺少分批发送闸门');
  assert.ok(src.includes('st.taskDeclaredDone'), '缺少已声明完成闸门');
});

test('注入脚本必须走 pluginAPI 发送，不得自行操作 DOM 输入框', () => {
  const src = readSrc();
  assert.ok(src.includes('__lingyaPluginAPI'), '必须使用注入的插件 API');
  assert.ok(src.includes('api.sendMessage('), '必须通过 api.sendMessage 发送');
  assert.ok(!src.includes('dispatchEvent(new KeyboardEvent'), '不得自行合成按键事件');
});

test('默认配置：开启、阈值 120 秒、上限 3 次、要求有未完成计划', () => {
  const src = readSrc();
  assert.ok(/enabled:\s*true/.test(src), '默认应开启');
  assert.ok(/thresholdSec:\s*120/.test(src), '默认阈值应为 120 秒');
  assert.ok(/maxNudge:\s*3/.test(src), '默认上限应为 3 次');
  assert.ok(/requirePlan:\s*true/.test(src), '默认应要求有未完成计划');
});

test('saveConfig 归一化：阈值下限 10 秒、上限 3600 秒', () => {
  const src = readSrc();
  assert.ok(src.includes('Math.max(10, Math.min(3600,'), '阈值必须夹在 10~3600');
});

test('saveConfig 归一化：上限 0~100，0 表示不限', () => {
  const src = readSrc();
  assert.ok(src.includes('Math.max(0, Math.min(100,'), '催促上限必须夹在 0~100');
});

test('催促文案为空时回退默认值', () => {
  const src = readSrc();
  assert.ok(src.includes("String(next.promptText || DEFAULTS.promptText).trim()"),
    '必须对空文案回退到默认值');
});


test('催促计数必须持久化在主进程（bumpNudgeCount IPC）', () => {
  const src = readSrc();
  assert.ok(src.includes("ctx.registerIpc('bumpNudgeCount'"), '缺少 bumpNudgeCount 通道');
  assert.ok(src.includes("ctx.registerIpc('resetNudgeCounts'"), '缺少 resetNudgeCounts 通道');
});

test('计数必须按会话隔离存储，且带时间戳', () => {
  const src = readSrc();
  assert.ok(/nudgeCounts:\s*\{\}/.test(src), '默认应有空 nudgeCounts');
  assert.ok(src.includes('counts[sid] = { count: used, at: now }'), '必须按会话记录 count + at');
});

test('催促后出现新活动 → 计数归零', () => {
  const src = readSrc();
  assert.ok(src.includes('lastActivityAt > at + 1000'), '必须检测「催促后有新活动」并重置');
});

test('陈旧计数必须有 24 小时清理', () => {
  const src = readSrc();
  assert.ok(src.includes('COUNT_TTL_MS = 24 * 60 * 60 * 1000'), '必须有 24h TTL 常量');
  assert.ok(src.includes('now - (Number(rec.at) || 0) > COUNT_TTL_MS'), '必须按 at 清理陈旧记录');
});

test('saveConfig 不得覆盖 nudgeCounts（用户改配置不能清计数）', () => {
  const src = readSrc();
  assert.ok(src.includes('next.nudgeCounts = prev.nudgeCounts'),
    'saveConfig 必须强制沿用旧计数');
});

test('preload 脚本不再持有内存计数，改由主进程裁决', () => {
  const src = readSrc();
  assert.ok(src.includes('bumpNudgeCount'), 'preload 必须调用 bumpNudgeCount');
  assert.ok(src.includes('br.data.allowed'), '必须依据主进程返回的 allowed 决定是否催促');
  assert.ok(!/var\s+counts\s*=\s*\{\}/.test(src), '不应再持有本地 counts 对象');
});
