/**
 * XML / DSML 格式工具调用检测（纯函数，无副作用）
 *
 * 【为什么单独成文件】
 * 这段正则经历过两次修复（2026-10-24 用户截图实测）：
 *   · AI 输出 `< | DSML | | invoke>` 这种【半角单竖线 + 空格】变体，
 *     原正则 /｜｜\s*DSML\s*｜｜/ 要求两个【全角竖线紧邻】，全部漏判
 *   · 漏判后果：XML 文本被当普通回复放过 → 不提示纠正 → Agent 静默停摆
 *
 * 抽成纯函数后，测试可以直接 require 本函数验证各种变体，
 * 不再依赖「扫源码找字符串」这种脆弱方式（曾因重构导致测试误报）。
 */

/**
 * 本轮回复是否包含 XML/DSML 格式的工具调用特征。
 * @param {string} raw AI 回复全文
 * @returns {boolean}
 */
function detectXmlFormat(raw) {
  const text = String(raw || '');
  // 竖线允许 1~2 个（[｜|] 匹配单个，{1,2} 放宽），中间可有空格
  const hasDsmlMark = /[｜|]\s*DSML\s*[｜|]/i.test(text);
  // invoke / parameter 前允许任意非 > 字符（容忍 < | DSML | | invoke>）
  const hasXmlInvoke = /<\s*[^>]*?\binvoke\s+name=/i.test(text);
  const hasXmlClose = /<\s*\/\s*[^>]*?\binvoke\s*>/i.test(text);
  const hasXmlParam = /<\s*[^>]*?\bparameter\s+name=/i.test(text);
  // 只有 invoke 没有 parameter/close 不算（避免误伤普通 HTML 示例）
  return hasDsmlMark || (hasXmlInvoke && (hasXmlClose || hasXmlParam));
}

module.exports = { detectXmlFormat };
