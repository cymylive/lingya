/**
 * DOM 兜底探测 —— 绕过网络 hook 的第二路信号
 *
 * 为什么需要：
 *   拦截模式的根本风险是主世界 hook 失效（页面改版、fetch 被覆盖、流未正常收尾）。
 *   hook 挂了 → 'lingya-ai-response' 事件不来 → 整条续跑链静默死亡。
 *   这是唯一能在「事件彻底丢失」时救回任务的机制。
 *
 * 设计约束：
 *   1. 选择器不可靠（平台随时改版）→ 用多组模糊匹配 + 取最后一个
 *   2. 可能读到用户消息或读错 → 多重校验：长度、是否含工具块特征、是否与已处理文本相同
 *   3. 只在状态机判定 AWAITING 停滞时才调用（正常流程完全不走这里）
 */

// 各平台的消息容器选择器（按优先级尝试，取第一个能匹配到的最后一个元素）
// 注意：这类模糊选择器只用于兜底，命中失败就直接放弃，不影响正常流程
const MESSAGE_SELECTORS = [
  // DeepSeek：AI 回复的 markdown 渲染容器
  '.ds-markdown',
  '[class*="markdown"]',
  '[class*="message"] [class*="content"]',
  // 通用兜底
  'main [class*="prose"]',
];

// 用户消息容器的排除特征（避免把用户提问当成 AI 回复）
const USER_MESSAGE_HINTS = [
  'fbb737a4',   // DeepSeek 用户气泡常见类名片段
  'user-message',
  'message-user',
];

/**
 * 判断元素是否像用户消息（应当排除）
 */
function looksLikeUserMessage(el) {
  if (!el) return false;
  const cls = String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || '');
  const lower = cls.toLowerCase();
  for (const hint of USER_MESSAGE_HINTS) {
    if (lower.indexOf(hint.toLowerCase()) !== -1) return true;
  }
  return false;
}

/**
 * 从 DOM 提取最后一条 AI 回复文本。
 * @returns {{text: string, selector: string}|null} 提取失败返回 null
 */
function extractLastAiMessage() {
  for (const sel of MESSAGE_SELECTORS) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
    if (!nodes || nodes.length === 0) continue;

    // 从后往前找：最后一个不像用户消息、且有实质内容的
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      if (!el || looksLikeUserMessage(el)) continue;
      const text = String(el.innerText || el.textContent || '').trim();
      // 校验：太短的多半是占位符/按钮
      if (text.length < 10) continue;
      return { text: text, selector: sel };
    }
  }
  return null;
}

/**
 * 尝试从 DOM 补救一次。
 *
 * 触发条件（由调用方保证）：状态机处于 AWAITING 且已超时。
 *
 * @param {string} lastProcessedText 上一次已处理的文本（用于去重）
 * @param {Function} processFn 处理函数，签名 (text, force, interrupted) => Promise
 * @returns {Promise<{recovered: boolean, reason: string}>}
 */
async function tryRecoverFromDom(lastProcessedText, processFn) {
  let picked;
  try {
    picked = extractLastAiMessage();
  } catch (err) {
    return { recovered: false, reason: 'DOM 读取异常: ' + (err && err.message) };
  }
  if (!picked) {
    return { recovered: false, reason: '未找到可识别的 AI 消息容器（可能平台改版或页面为空）' };
  }

  const text = picked.text;
  // 去重：与上次处理过的完全相同 → 说明没有新内容，事件丢失是「回复根本没产生」而非「产生了没通知」
  if (lastProcessedText && text === lastProcessedText) {
    return { recovered: false, reason: 'DOM 最后一条消息与已处理内容相同，无新内容可补' };
  }

  // 防止把半截内容当完整回复：至少要有一定长度
  if (text.length < 20) {
    return { recovered: false, reason: 'DOM 内容过短（' + text.length + ' 字符），疑似占位符' };
  }

  console.log('[LingYa][DOM兜底] 从 DOM 补获回复（选择器 ' + picked.selector +
    '，长度 ' + text.length + '），交给正常处理流程');

  try {
    // force = true：绕过 lastProcessedText 去重（内容确实不同，但保险起见强制处理）
    // interrupted = false：DOM 里能读到的内容按「已完成」处理
    await processFn(text, true, false);
    return { recovered: true, reason: '已补处理 ' + text.length + ' 字符' };
  } catch (err) {
    return { recovered: false, reason: '补处理失败: ' + (err && err.message) };
  }
}

module.exports = { extractLastAiMessage, tryRecoverFromDom, MESSAGE_SELECTORS };
