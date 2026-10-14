#!/usr/bin/env node
/**
 * 侧边栏功能完整性核对脚本
 *
 * 对比「覆盖层面板」与「侧边栏面板」的功能对齐情况：
 *  ① shellAPI 三层（renderer 调用 vs preload 暴露）
 *  ② IPC 通道（invoke vs 主进程 handle）
 *  ③ 各面板关键功能点存在性
 *  ④ 事件（send vs on）
 *
 * 用法：node scripts/verify-sidebar-parity.js
 * 退出码：0 = 全对齐；1 = 有缺失
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const errors = [];
const report = {};

function read(p) { return fs.readFileSync(p, 'utf-8'); }

// ===== ① shellAPI 三层 =====
const rd = read(path.join(SRC, 'preload', 'shell-renderer.js'));
const pd = read(path.join(SRC, 'preload', 'shell-preload.js'));
const called = [...new Set([...rd.matchAll(/shellAPI\.([a-zA-Z0-9]+)/g)].map((m) => m[1]))];
const exposed = [...new Set([...pd.matchAll(/^\s+([a-zA-Z0-9]+):\s/gm)].map((m) => m[1]))];
const missingApi = called.filter((c) => !exposed.includes(c));
report.shellApi = { called: called.length, exposed: exposed.length, missing: missingApi };
if (missingApi.length) errors.push('shellAPI 缺失: ' + missingApi.join(', '));

// ===== ② IPC 通道 =====
let handles = new Set();
for (const f of walk(path.join(SRC, 'main'))) {
  const t = read(f);
  for (const m of t.matchAll(/ipcMain(?:ForProfile)?[.]handle\(['"]([^'"]+)['"]/g)) handles.add(m[1]);
}
for (const f of walk(path.join(ROOT, 'tools'))) {
  const t = read(f);
  for (const m of t.matchAll(/ipcMain(?:ForProfile)?[.]handle\(['"]([^'"]+)['"]/g)) handles.add(m[1]);
}
const invokes = [...new Set([...pd.matchAll(/invoke\(['"]([^'"]+)['"]/g)].map((m) => m[1]))];
const noHandler = invokes.filter((c) => !handles.has(c));
report.ipc = { handlers: handles.size, invokes: invokes.length, noHandler };
if (noHandler.length) errors.push('IPC 无 handler: ' + noHandler.join(', '));

// ===== ③ 面板关键功能点 =====
const FEATURES = {
  '记忆-筛选': /sh-mem-filter/,
  '记忆-新建': /sh-mem-new/,
  '记忆-编辑': /sh-mem-ed-save/,
  '记忆-删除': /deleteMemory/,
  '记忆-插入': /insertToChat/,
  '记忆-导入导出': /importMemories|exportMemories/,
  '技能-启停': /sh-sk-toggle|setSkillEnabled/,
  '技能-编辑': /sh-sk-ed-save/,
  '技能-导入': /importSkillFolder/,
  '安全-CTF': /sh-sec-ctf/,
  '安全-拒绝拦截': /refusalEnabled|sh-sec-refusal/,
  '安全-自动续写': /sh-sec-autoc/,
  '安全-停滞监督': /sh-sec-stall/,
  '安全-重置': /sh-sec-reset/,
  '安全-立即注入': /sh-sec-inject/,
  '定时-新建': /sh-sc-new/,
  '定时-cron校验': /validateScheduleCron/,
  '定时-窗口下拉': /sh-sc-window/,
  '飞书-配置': /sh-fs-appid/,
  '飞书-群绑定': /sh-fs-bind/,
  '飞书-刷新': /sh-fs-refresh/,
  'Agent-切换': /data-agent/,
  '计划-进度条': /pct/,
  '设置-悬浮开关': /sh-set-hidefloat/,
  'MCP-启用禁用': /enableMcpServer|disableMcpServer/,
  '窗口-改名删除': /updateWindowName|deleteProfileWindow/,
};
const featureMiss = [];
for (const [name, re] of Object.entries(FEATURES)) {
  if (!re.test(rd)) featureMiss.push(name);
}
report.features = { checked: Object.keys(FEATURES).length, missing: featureMiss };
if (featureMiss.length) errors.push('功能点缺失: ' + featureMiss.join(', '));

// ===== ④ 事件 =====
let sent = new Set();
for (const f of walk(path.join(SRC, 'main'))) {
  const t = read(f);
  for (const m of t.matchAll(/[.]send\(['"]([^'"]+)['"]/g)) sent.add(m[1]);
}
let on = new Set();
for (const f of walk(path.join(SRC, 'preload'))) {
  const t = read(f);
  for (const m of t.matchAll(/ipcRenderer[.]on\(['"]([^'"]+)['"]/g)) on.add(m[1]);
}
const sentNoListener = [...sent].filter((c) => !on.has(c));
report.events = { sent: sent.size, on: on.size, sentNoListener };

// ===== 输出 =====
console.log(JSON.stringify(report, null, 2));
if (errors.length) {
  console.error('\n❌ 发现 ' + errors.length + ' 类问题:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ 侧边栏功能与覆盖层完全对齐');

// ===== 工具 =====
function walk(dir) {
  let out = [];
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|[.]git|dist|tmp/.test(e.name)) out = out.concat(walk(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
