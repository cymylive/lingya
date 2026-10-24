/**
 * 导出对话文件名的生成。
 *
 * 格式：<会话标题>_<YYYYMMDD-HHmm>.md
 * 例：LingYa 项目开工确认_20261025-0159.md
 *
 * 标题来源：document.title（由 page-title-sync.js 同步为真实会话标题）。
 * 平台常给标题加后缀（如「 - DeepSeek」），取第一个 ' - ' 之前的部分。
 * 取不到标题时回退到 lingya-conversation-<时间戳>.md，保持向后兼容。
 */

/**
 * 从 document.title 提取干净的会话标题。
 * @returns {string} 标题；取不到时返回空字符串
 */
function getConversationTitle() {
  try {
    const raw = String((typeof document !== 'undefined' && document.title) || '').trim();
    if (!raw) return '';
    // 截断平台后缀：「LingYa 项目开工确认 - DeepSeek」→「LingYa 项目开工确认」
    const idx = raw.indexOf(' - ');
    const title = (idx > 0 ? raw.slice(0, idx) : raw).trim();
    return title;
  } catch (_) {
    return '';
  }
}

/**
 * 把标题里的 Windows 非法文件名字符替换成下划线。
 * 非法字符：\ / : * ? " < > |
 * 另外压缩连续空白、去掉首尾空格和点（Windows 不允许文件名以点结尾）。
 * @param {string} s
 * @returns {string}
 */
function sanitizeTitle(s) {
  let out = String(s || '');
  out = out.replace(/[\\/:*?"<>|]/g, '_');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/[. ]+$/g, '');   // Windows 不允许结尾是点或空格
  // 过长截断（保留 80 字符够用，避免超出路径长度限制）
  if (out.length > 80) out = out.slice(0, 80).trim();
  return out;
}

/**
 * 生成导出文件名。
 * @param {Date} [now] 时间，默认当前时刻
 * @returns {string} 如「LingYa 项目开工确认_20261025-0159.md」
 */
function buildExportFilename(now) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes());

  const title = sanitizeTitle(getConversationTitle());
  if (title) return title + '_' + stamp + '.md';
  // 回退：保持原有命名，向后兼容
  return 'lingya-conversation-' + stamp + '.md';
}

module.exports = { buildExportFilename, getConversationTitle, sanitizeTitle };
