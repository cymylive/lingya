/**
 * XML / DSML 格式工具调用检测（纯函数，无副作用）
 *
 * 检测两条路（任一命中即视为 XML 工具调用）：
 *  1. 内置正则：匹配 < | DSML | | invoke> / <invoke name=> / <parameter name=> 等变体
 *  2. 用户自定义正则（设置面板「AI 回复拦截」配置，一行一条，不区分大小写）
 *
 * 抽成纯函数后，测试可以直接 require 本函数验证各种变体。
 */

/** 内置正则：竖线允许 1~2 个，中间可有空格 */
const BUILTIN_PATTERNS = [
  /[｜|]\s*DSML\s*[｜|]/i,
  /<\s*[^>]*?\binvoke\s+name=/i,
  /<\s*\/\s*[^>]*?\binvoke\s*>/i,
  /<\s*[^>]*?\bparameter\s+name=/i,
];

/** 编译用户自定义正则（数组）；非法正则跳过 */
function compileCustomPatterns(patternStrs) {
  if (!Array.isArray(patternStrs)) return [];
  const out = [];
  for (const s of patternStrs) {
    const src = String(s || '').trim();
    if (!src) continue;
    try { out.push(new RegExp(src, 'i')); } catch (_) { /* 非法正则跳过 */ }
  }
  return out;
}

/**
 * 本轮回复是否包含 XML/DSML 格式的工具调用特征。
 * @param {string} raw AI 回复全文
 * @param {RegExp[]} [customPatterns] 用户自定义正则（可选）
 * @returns {boolean}
 */
function detectXmlFormat(raw, customPatterns) {
  const text = String(raw || '');
  // 1) 用户自定义正则优先
  if (Array.isArray(customPatterns)) {
    for (const re of customPatterns) {
      try { if (re.test(text)) return true; } catch (_) {}
    }
  }
  // 2) 内置检测（沿用原有兼容逻辑）
  const hasDsmlMark = BUILTIN_PATTERNS[0].test(text);
  const hasXmlInvoke = BUILTIN_PATTERNS[1].test(text);
  const hasXmlClose = BUILTIN_PATTERNS[2].test(text);
  const hasXmlParam = BUILTIN_PATTERNS[3].test(text);
  // 只有 invoke 没有 parameter/close 不算（避免误伤普通 HTML 示例）
  return hasDsmlMark || (hasXmlInvoke && (hasXmlClose || hasXmlParam));
}

module.exports = { detectXmlFormat, compileCustomPatterns, BUILTIN_PATTERNS };
