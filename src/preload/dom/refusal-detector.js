/**
 * 拒绝回复检测器（移植自 codex-session-patcher 的 RefusalDetector）
 *
 * 两级策略：
 * 1. 强拒绝短语：出现在任意位置即判定（误报率低）
 * 2. 弱拒绝关键词：仅在消息开头 150 字符内出现才判定
 * 3. 自定义关键词：作为强匹配，全文搜索
 */

// 强拒绝短语：出现在任意位置即判定为拒绝
const STRONG_REFUSAL_PHRASES = [
  // 中文
  '我无法协助', '我无法帮助', '我不能协助', '我不能帮助',
  '我不能做', '我无法做', '我不会帮', '我无法提供',
  '违反了我的', '违反我的', '这违反',
  '我拒绝', '我必须拒绝',
  // 英文
  "i cannot assist", "i can't assist", "i'm unable to assist",
  "i cannot help", "i can't help", "i'm unable to help",
  "i must decline", "i must refuse",
  "against my guidelines", "against my policy",
  "violates my", "i won't help", "i won't assist",
  "as an ai", "as a language model",
  "i apologize, but i", "i'm sorry, but i can't",
  "not able to provide", "not able to assist",
];

// 弱拒绝关键词：需要出现在消息开头（前 150 字符）才算拒绝
const WEAK_REFUSAL_KEYWORDS = [
  // 中文
  '抱歉', '很抱歉', '对不起', '不好意思',
  '我无法', '我不能', '不允许', '禁止',
  // 中文 - 省略主语的直接拒绝
  '不能帮你', '不能协助', '无法帮你', '无法协助你',
  '不会帮你', '不会帮助', '不能为你', '无法为你',
  // 英文
  'sorry', 'apologize', "i cannot", "i can't",
  "i'm unable", 'unable to', 'not permitted', 'not allowed',
  'refuse to',
];

/**
 * 检测内容是否为拒绝回复
 * @param {string} content 待检测文本
 * @param {object} [customKeywords] 自定义关键词 { zh: [], en: [] }
 * @returns {boolean}
 */
function detectRefusal(content, customKeywords) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();

  // 1. 强拒绝短语 - 全文匹配
  for (const phrase of STRONG_REFUSAL_PHRASES) {
    if (lower.includes(phrase)) return true;
  }

  // 2. 弱拒绝关键词 - 仅匹配开头 150 字符
  const head = lower.slice(0, 150);
  for (const keyword of WEAK_REFUSAL_KEYWORDS) {
    if (head.includes(keyword)) return true;
  }

  // 3. 用户自定义关键词 - 全文匹配
  if (customKeywords && typeof customKeywords === 'object') {
    for (const lang of Object.keys(customKeywords)) {
      const list = customKeywords[lang];
      if (!Array.isArray(list)) continue;
      for (const keyword of list) {
        if (typeof keyword === 'string' && keyword && lower.includes(keyword.toLowerCase())) {
          return true;
        }
      }
    }
  }

  return false;
}

module.exports = {
  STRONG_REFUSAL_PHRASES,
  WEAK_REFUSAL_KEYWORDS,
  detectRefusal,
};
