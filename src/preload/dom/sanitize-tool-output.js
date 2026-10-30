/**
 * 工具输出清洗（2026-10-30）
 *
 * 【要解决的问题】
 * 工具执行异常时，err.message 里可能带上 LingYa 自身的安装路径，
 * 例如：
 *   Cannot find module 'H:\\lingya\\resources\\app.asar\\node_modules\\xxx'
 *   ENOENT: no such file or directory, open 'H:\\lingya\\resources\\app.asar\\...'
 * 这条消息会通过 sendToolResultToChat / sendCombinedJsResultsToChat 原样发给 DeepSeek。
 * 消息正文里出现 app.asar + resources 路径，等于向对方声明「这是个 Electron 注入工具」。
 *
 * 【边界 —— 极其重要，绝不能越界】
 * 只替换「LingYa 自身安装目录」这一种路径，判定依据是路径里同时包含
 *   resources + app.asar
 * 用户项目的任何路径（D:\\project\\src\\index.js、C:\\Users\\...\\code.js）
 * 都不含这一段，绝不会被替换。bash / read / git 的正常输出完全不受影响。
 *
 * 【为什么不做得更激进】
 * 曾考虑过滤所有 "LingYa" 字样或所有 H: 盘路径。这会误伤：
 *   - 用户项目本身就在 H: 盘
 *   - 工具输出里出现 lingya 这个词（如 package.json 里的项目名）
 * 只删「确定是自身安装目录」的片段，是唯一零误伤的方案。
 */

// 匹配 Windows / POSIX 下含 resources/app.asar 的路径片段。
// 只吃路径字符，遇到空白、引号、尖括号、竖线即停。
const ASAR_PATH_RE = /[A-Za-z]:[\\/][^\s"'\`<>|]*resources[\\/]app\.asar[^\s"'\`<>|]*/gi;
const POSIX_ASAR_RE = /\/[^\s"'\`<>|]*resources\/app\.asar[^\s"'\`<>|]*/g;

/**
 * 把 LingYa 自身安装路径替换为占位符。
 * @param {string} text 待清洗文本
 * @returns {string} 清洗后文本
 */
function sanitizeToolOutput(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text;
  try {
    s = s.replace(ASAR_PATH_RE, '<internal>');
    s = s.replace(POSIX_ASAR_RE, '<internal>');
  } catch (_) { /* 正则异常时原样返回，绝不阻断发送 */ }
  return s;
}

module.exports = { sanitizeToolOutput };
