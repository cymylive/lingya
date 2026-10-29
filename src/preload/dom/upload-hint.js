/**
 * 上传附件的引导语生成（2026-10-30 三版）
 *
 * 历史演进：
 *   1. 初版：恒定「请阅读附件 lingya-input.md 并按其中内容执行。」
 *      —— 与固定文件名叠加构成强机器指纹
 *   2. 二版：改为 20 条文案池随机（祈使/疑问/口语/极简），约一半带文件名
 *      —— 降低指纹，但用户界面仍会出现「XX.md 在这儿，按这个来」这类文字
 *   3. 三版（本版）：改用零宽空格 \u200B
 *      —— 输入框在视觉上等于「没有引导语」，附件卡片是唯一可见内容
 *
 * 实测依据（DeepSeek chat，2026-10-30，本机 injectJS 真机验证）：
 *   输入框状态 → 发送按钮状态
 *   - 空值        → disabled（opacity 0.4, cursor not-allowed）
 *   - 普通空格     → 仍 disabled（平台 trim 掉了）
 *   - 一个句号「。」→ 可点（opacity 1, cursor pointer）
 *   - 零宽空格     → 可点（opacity 1, cursor pointer）
 *   - 注入 .md + 填 \u200B + 点击发送 → 平台正常收到，AI 回复文件标记正确
 *
 * 结论：平台的校验是「textarea.value 非空」，不是「必须有一行有意义的文字」。
 *      零宽空格完全满足，且肉眼不可见。
 *
 * 兜底：若未来平台前端改为 trim 掉零宽字符，发送按钮会保持 disabled，
 *      chat-input.js 的 triggerSend 会返回 false，届时自动改用「。」重试一次。
 *      见 chat-input.js 中「零宽引导语兜底重试」相关代码。
 */

// 零宽空格：Unicode U+200B，肉眼不可见，但字符串 length === 1
const ZERO_WIDTH = '\u200B';

// 兜底可见字符：如果零宽方案被平台拦截，chat-input.js 会用这个重试
const FALLBACK_HINT = '。';

/**
 * 生成一条引导语。
 * 当前实现恒定返回零宽空格，参数保留是为了向后兼容既有调用点。
 * @param {string} fileName 本次实际上传的文件名（保留参数，当前未使用）
 * @returns {string} 引导语（零宽空格）
 */
function pickHint(fileName) {
  return ZERO_WIDTH;
}

module.exports = { pickHint, ZERO_WIDTH, FALLBACK_HINT };
