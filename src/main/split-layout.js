/**
 * 分屏布局计算（纯函数，无 Electron 依赖）
 *
 * 窗口合并后，宿主窗口需要同时摆放多个 WebContentsView。
 * 左右并排时按最小宽度计算：可用宽度均分后若低于 minWidth，则每个视图用 minWidth，
 * 总宽超出视口的部分由主窗口横向滚动查看（视图位置按 scrollX 左移）。
 */

const MIN_WIDTH_DEFAULT = 0;

/** 均分一个轴，尊重最小尺寸；最后一段吸收余数 */
function divide(start, total, count, gap, minSize) {
  const g = Math.max(0, Number(gap) || 0);
  const min = Math.max(0, Number(minSize) || 0);
  const usable = Math.max(0, total - g * (count - 1));
  const even = Math.floor(usable / count);
  const size = Math.max(min, even);
  const out = [];
  let pos = start;
  for (let i = 0; i < count; i++) {
    // 有最小宽约束时每段等宽（不吸收余数）；否则最后一段吸收取整余数
    const s = min > even
      ? size
      : (i === count - 1 ? Math.max(0, start + total - pos) : even);
    out.push({ pos, size: s });
    pos += s + g;
  }
  return out;
}

/**
 * @param {{x:number,y:number,width:number,height:number}} area 可用区域
 * @param {'horizontal'|'vertical'} direction
 * @param {number} count 视图总数
 * @param {number} gap 分隔条宽度
 * @param {number} minWidth 左右分屏时每个视图的最小宽度（0 = 不限制）
 * @param {number} scrollX 横向滚动偏移（左右分屏时所有视图整体左移）
 * @returns {Array<{x,y,width,height}>|null}
 */
function computeSplitLayout(area, direction, count, gap, minWidth, scrollX) {
  if (!area || (direction !== 'horizontal' && direction !== 'vertical')) return null;
  const n = Math.max(1, Number(count) || 1);
  const min = Math.max(0, Number(minWidth) || 0);
  const sx = Math.max(0, Number(scrollX) || 0);

  if (n === 1) {
    return [{ x: area.x, y: area.y, width: area.width, height: area.height }];
  }
  if (direction === 'horizontal') {
    return divide(area.x - sx, area.width, n, gap, min).map(seg => ({
      x: seg.pos, y: area.y, width: seg.size, height: area.height,
    }));
  }
  // 上下堆叠：最小宽不适用
  return divide(area.y, area.height, n, gap, 0).map(seg => ({
    x: area.x, y: seg.pos, width: area.width, height: seg.size,
  }));
}

/**
 * 计算分屏内容的总宽度（左右分屏时用于滚动条）
 * 内容窄于视口时返回视口宽度（不出现滚动条）
 */
function computeScrollContentWidth(area, direction, count, gap, minWidth) {
  if (!area) return 0;
  const n = Math.max(1, Number(count) || 1);
  if (direction !== 'horizontal' || n <= 1) return area.width;
  const g = Math.max(0, Number(gap) || 0);
  const min = Math.max(0, Number(minWidth) || 0);
  const usable = Math.max(0, area.width - g * (n - 1));
  const each = Math.max(min, Math.floor(usable / n));
  return Math.max(area.width, each * n + g * (n - 1));
}

/** 兼容旧签名：两视图分屏 */
function computeSplitBounds(area, direction, gap, minWidth, scrollX) {
  if (!area || (direction !== 'horizontal' && direction !== 'vertical')) return null;
  const l = computeSplitLayout(area, direction, 2, gap, minWidth, scrollX);
  return l ? { main: l[0], attached: l[1] } : null;
}

module.exports = { computeSplitLayout, computeSplitBounds, computeScrollContentWidth, MIN_WIDTH_DEFAULT };
