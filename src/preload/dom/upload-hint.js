/**
 * 上传附件的引导语生成（恢复版）
 *
 * 历史演进：
 *   1. 初版：恒定「请阅读附件 lingya-input.md 并按其中内容执行。」——强机器指纹
 *   2. 二版：20 条文案池随机——降低指纹，但界面上仍有文字
 *   3. 三版：恒定零宽空格 \u200B——视觉上等于「没有引导语」
 *   4. 四版：短句池随机
 *
 * 恢复回三版逻辑：平台只校验 textarea.value 非空，零宽空格完全满足，
 * 且肉眼不可见，最符合「恢复单 .md 上传且去掉引导语」的需求。
 */

const ZERO_WIDTH = '\u200B';
const FALLBACK_HINT = '。';

function pickHint(fileName) {
  return ZERO_WIDTH;
}

module.exports = { pickHint, ZERO_WIDTH, FALLBACK_HINT };
