#!/usr/bin/env node
/**
 * 记忆库体检报告（本地终端输出，不发网页端）
 *
 * 用法：
 *   node tools/memory-audit.js
 *   node tools/memory-audit.js --root H:/lingya/LingYa-Data
 *   node tools/memory-audit.js --fix-stale   # 顺带刷新路径失效标记
 */
const path = require('path');
const memoryStore = require('../src/main/memory-store');
const { isSensitive } = require('../src/main/memory-redaction');

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 ? args[rootArg + 1] : 'H:/lingya/LingYa-Data';
const doFixStale = args.includes('--fix-stale');

memoryStore.init(root);

const all = memoryStore.getAllMemories();
const now = Date.now();
const DAY = 86400000;

console.log('');
console.log('======== 记忆库体检报告 ========');
console.log('存储:', path.join(root, 'lingya-memory.json'));
console.log('总数:', all.length);
console.log('');

// 1. scope 分布
const scopeCount = {};
for (const m of all) scopeCount[m.scope || 'global'] = (scopeCount[m.scope || 'global'] || 0) + 1;
console.log('---- scope 分布 ----');
Object.entries(scopeCount).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
console.log('');

// 2. kind 分布
const kindCount = {};
for (const m of all) kindCount[m.kind || '?'] = (kindCount[m.kind || '?'] || 0) + 1;
console.log('---- kind 分布 ----');
Object.entries(kindCount).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
console.log('');

// 3. 疑似重复（同 scope 内名称相似 >= 0.8）
console.log('---- 疑似重复（名称相似 >= 80%）----');
let dupGroups = 0;
const byScope = {};
for (const m of all) { if (!byScope[m.scope]) byScope[m.scope] = []; byScope[m.scope].push(m); }
for (const [scope, list] of Object.entries(byScope)) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const sim = memoryStore.nameSimilarity(list[i].name, list[j].name);
      if (sim >= 0.8) {
        console.log('  [' + scope + '] #' + list[i].id + ' vs #' + list[j].id + ' (' + Math.round(sim * 100) + '%)');
        console.log('      ' + list[i].name.slice(0, 50));
        console.log('      ' + list[j].name.slice(0, 50));
        dupGroups++;
      }
    }
  }
}
if (dupGroups === 0) console.log('  （无）');
console.log('');

// 4. 冷记忆（180 天未访问且访问次数 < 3）
const cold = all.filter((m) => (m.accessCount || 0) < 3 && (now - (m.lastAccessedAt || m.createdAt || 0)) > 180 * DAY);
console.log('---- 冷记忆（180 天未用且访问<3次）:', cold.length, '条 ----');
cold.slice(0, 10).forEach((m) => console.log('  #' + m.id + ' ' + m.name.slice(0, 50)));
if (cold.length > 10) console.log('  …还有 ' + (cold.length - 10) + ' 条');
console.log('');

// 5. 路径失效
console.log('---- 路径失效检查 ----');
if (doFixStale) {
  const r = memoryStore.refreshStaleFlags();
  console.log('  扫描 ' + r.checked + ' 条，新标失效 ' + r.stale + ' 条，恢复 ' + r.restored + ' 条');
} else {
  const stale = all.filter((m) => m.stale);
  console.log('  已标失效:', stale.length, '条（加 --fix-stale 重新扫描）');
  stale.slice(0, 10).forEach((m) => console.log('  #' + m.id + ' ' + m.name.slice(0, 50)));
}
console.log('');

// 6. 敏感条目
const sensitive = all.filter((m) => isSensitive(m));
console.log('---- 敏感条目（不外发）:', sensitive.length, '条 ----');
sensitive.forEach((m) => console.log('  #' + m.id + ' ' + m.name.slice(0, 60)));
console.log('');

// 7. 置信度
const hypo = all.filter((m) => m.confidence === 'hypothesis');
console.log('---- 推测类（hypothesis）:', hypo.length, '条 ----');
hypo.slice(0, 10).forEach((m) => console.log('  #' + m.id + ' ' + m.name.slice(0, 50)));
if (hypo.length > 10) console.log('  …还有 ' + (hypo.length - 10) + ' 条');
console.log('');

console.log('======== 报告结束 ========');
console.log('');
