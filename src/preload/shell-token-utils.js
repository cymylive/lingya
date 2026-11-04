'use strict';
/**
 * 状态栏 token 纯函数（供测试与壳页面共用）
 * 双环境暴露：Node 用 module.exports，渲染进程用 window.__lyShellTokenUtils
 * 注意：壳页面 contextIsolation:true / nodeIntegration:false，没有 require，
 * 必须通过 window 全局传递，否则 shell-renderer 会崩溃。
 */

function upsertTokenEntry(map, viewKey, context) {
  const src = (map instanceof Map) ? map : new Map();
  if (!viewKey || typeof context !== 'number' || !isFinite(context)) return src;
  const next = new Map(src);
  next.set(String(viewKey), context);
  return next;
}

function pruneTokenEntries(map, activeViewKeys) {
  const src = (map instanceof Map) ? map : new Map();
  const keep = new Set(Array.isArray(activeViewKeys) ? activeViewKeys.map(String) : []);
  const next = new Map();
  for (const [k, v] of src) {
    if (keep.has(k)) next.set(k, v);
  }
  return next;
}

function formatTokenCount(n) {
  if (!isFinite(n) || n < 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(2) + '万';
  return String(Math.round(n));
}

var API = { upsertTokenEntry: upsertTokenEntry, pruneTokenEntries: pruneTokenEntries, formatTokenCount: formatTokenCount };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.__lyShellTokenUtils = API;
}
