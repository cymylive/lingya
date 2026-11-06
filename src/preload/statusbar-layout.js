/**
 * 状态栏布局计算（纯函数，可在 Node 下测试）
 *
 * 状态栏在分屏时按视图平铺 "x号窗口 对话上下文:… 输出速度:…"，
 * 窗口数超过可用宽度时会溢出。这里负责算出「能放几个完整块」。
 */
'use strict';

// 单个块的估算宽度（约 240px：窗口号 + 两组 label/value）
const ITEM_ESTIMATED_WIDTH = 240;
// 溢出按钮 +M 的估算宽度（含间距）
const OVERFLOW_BUTTON_WIDTH = 64;

/**
 * @param {number} availableWidth 状态栏可用宽度（px）
 * @param {number[]|null} itemWidths 各块实际宽度；null 时用估算宽度
 * @param {number} [totalCount] itemWidths 为 null 时使用，表示总块数
 * @returns {{visible:number, folded:number}}
 */
function computeVisibleCount(availableWidth, itemWidths, totalCount) {
  const avail = Math.max(0, Number(availableWidth) || 0);
  let widths;
  if (Array.isArray(itemWidths) && itemWidths.length > 0) {
    widths = itemWidths.map(function (w) { return Math.max(0, Number(w) || 0); });
  } else if (typeof totalCount === 'number' && totalCount > 0) {
    widths = [];
    for (let i = 0; i < totalCount; i++) widths.push(ITEM_ESTIMATED_WIDTH);
  } else {
    return { visible: 0, folded: 0 };
  }

  const total = widths.length;
  const sum = widths.reduce(function (a, b) { return a + b; }, 0);

  // 全部放得下
  if (sum <= avail) return { visible: total, folded: 0 };

  // 需要折叠：从最多往下试，确保 sum(前 visible 个) + 按钮宽 ≤ avail
  for (let visible = total - 1; visible >= 0; visible--) {
    let w = 0;
    for (let i = 0; i < visible; i++) w += widths[i];
    if (w + OVERFLOW_BUTTON_WIDTH <= avail) {
      return { visible: visible, folded: total - visible };
    }
  }
  // 连一个块 + 按钮都放不下：全部折叠
  return { visible: 0, folded: total };
}

module.exports = { computeVisibleCount, ITEM_ESTIMATED_WIDTH, OVERFLOW_BUTTON_WIDTH };
