/**
 * DOM 前缀随机化（封号风险改造 2026-11-01，P3 等效方案）
 *
 * 背景：原实现把覆盖层 460+ 元素用 lingya-* 前缀直接注入页面 DOM。
 * 页面任意脚本 document.querySelectorAll('[id^="lingya-"]') 一行即可命中工具身份。
 * 完整迁移到独立 BrowserWindow 需重写数千行 IPC，成本过高；
 * 本模块做等效替代：注入时把 'lingya-' 前缀全局替换为随机串（如 'lx_a3k2'），
 * 并劫持 document.getElementById / querySelectorAll，让所有调用方无感切换。
 *
 * 效果：
 *   - 页面 querySelectorAll('[id^="lingya-"]')       → 0 个（不再是 lingya- 开头）
 *   - 页面 querySelectorAll('.lingya-tab')            → 0 个
 *   - 页面 querySelectorAll('textarea')              → 仍命中（这是页面原生组件，无法避免）
 *   - 但页面无法从 DOM 上识别出「这是 LingYa」
 *
 * 后缀在同一 preload 生命周期内固定；刷新页面会变。
 */
'use strict';

// 6 位小写 + 数字（避免与页面原生 id 撞）
const TAIL = Math.random().toString(36).slice(2, 8);
// 新前缀（注意：不加 'lingya' 字样）
const PREFIX = 'lx_' + TAIL + '_';
// 旧前缀
const LEGACY = 'lingya-';

/** 把字符串里的旧前缀全部替换为新前缀 */
function replacePrefix(s) {
  if (!s) return s;
  return s.split(LEGACY).join(PREFIX);
}

/** 把旧 id 映射为新 id（供 getElementById 劫持用） */
function mapId(id) {
  if (typeof id !== 'string') return id;
  if (id.indexOf(LEGACY) === 0) return PREFIX + id.slice(LEGACY.length);
  return id;
}

module.exports = { PREFIX, LEGACY, TAIL, replacePrefix, mapId };
