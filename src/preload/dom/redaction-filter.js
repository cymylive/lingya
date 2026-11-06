/**
 * preload 侧脱敏引擎（2026-11-02）
 *
 * 目的：把从主进程拿到的规则表缓存起来，在 preload 里同步执行脱敏。
 * 用法：
 *   const { redactText, refreshRules } = require('./redaction-filter');
 *   const safe = redactText(dangerous);
 *
 * 规则来源：window.electronAPI.getRedactionRules() 异步拉取，
 * 缓存到模块级变量里，同步使用。
 *
 * 【缓存策略】
 * - 首次调用时同步返回空表（避免阻塞），同时发起异步刷新
 * - 后续调用使用缓存
 * - 主进程可主动调 refreshRules() 推送新规则（暂未实现，先走轮询）
 */

let cachedPairs = []; // [{word, placeholder}]，按词长降序
let loaded = false;
let loading = null;

/**
 * 从主进程拉取规则（异步）。
 * 拉取成功后重建 cachedPairs。
 */
async function refreshRules() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const api = (typeof window !== 'undefined' && window.electronAPI) || {};
      if (!api.getRedactionRules) {
        console.warn('[Redaction] electronAPI.getRedactionRules 不存在，脱敏规则为空');
        loaded = true;
        return;
      }
      // 只拿 global 作用域（auto 规则默认 memory-only，不应用于用户输入）
      const rules = await api.getRedactionRules('global');
      if (!Array.isArray(rules)) {
        console.warn('[Redaction] 规则返回格式非法，脱敏规则为空');
        loaded = true;
        return;
      }
      const pairs = [];
      for (const r of rules) {
        if (!r || r.enabled === false) continue;
        for (const w of (r.words || [])) {
          if (w) pairs.push({ word: String(w), placeholder: '⟦' + r.name + '⟧' });
        }
      }
      pairs.sort((a, b) => b.word.length - a.word.length);
      cachedPairs = pairs;
      loaded = true;
      console.log('[Redaction] 已加载 ' + pairs.length + ' 条脱敏规则');
    } catch (err) {
      console.warn('[Redaction] 加载规则失败:', err && err.message);
      loaded = true;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * 同步脱敏：把 cachedPairs 里的真词替换成占位符。
 * 未加载时会返回原文（不阻断发送），同时触发异步刷新。
 */
function redactText(text) {
  if (!text || typeof text !== 'string') return text;
  if (!loaded && !loading) {
    // 首次调用，异步加载
    refreshRules().catch(() => {});
  }
  if (cachedPairs.length === 0) return text;
  let out = text;
  for (const { word, placeholder } of cachedPairs) {
    if (out.indexOf(word) === -1) continue;
    out = out.split(word).join(placeholder);
  }
  return out;
}

/**
 * 反向还原：把占位符换回真词。
 * 【2026-11-05 新增】供本地显示/导出/推送使用——
 * 出站发给 AI 平台的仍是占位符（防泄露），但本地出口（IM 推送、会话存档、
 * 覆盖层日志、网页 DOM）应还原成真词，让用户看到可读内容。
 * 使用同一份 cachedPairs（与 redactText 共享规则表），确保双向一致。
 */
function unredactText(text) {
  if (!text || typeof text !== 'string') return text;
  if (cachedPairs.length === 0) return text;
  let out = text;
  for (const { word, placeholder } of cachedPairs) {
    if (out.indexOf(placeholder) === -1) continue;
    out = out.split(placeholder).join(word);
  }
  return out;
}

module.exports = { redactText, unredactText, refreshRules };
