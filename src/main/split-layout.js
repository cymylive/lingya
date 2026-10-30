/**
 * 分屏布局计算（纯函数，无 Electron 依赖）
 *
 * 窗口合并后，宿主窗口需要同时摆放多个 WebContentsView：
 *  第 1 个是宿主自己的 active tab 视图，其后是合并进来的附加视图。
 * 全部均分：左右并排则等分宽度，上下堆叠则等分高度。
 */

/** 按数量均分一个轴，返回每段的起始偏移与尺寸 */
function divide(start, total, count, gap) {
  const g = Math.max(0, Number(gap) || 0);
  const usable = Math.max(0, total - g * (count - 1));
  const each = Math.floor(usable / count);
  const out = [];
  let pos = start;
  for (let i = 0; i < count; i++) {
    // 最后一段吸收取整余数，避免右边/下边留 1px 缝
    const size = (i === count - 1) ? Math.max(0, start + total - pos) : each;
    out.push({ pos, size });
    pos += size + g;
  }
  return out;
}

/**
 * @param {{x:number,y:number,width:number,height:number}} area 可用区域
 * @param {'none'|'horizontal'|'vertical'} direction
 * @param {number} count 视图总数（含宿主自己的）
 * @param {number} gap 分隔条宽度
 * @returns {Array<{x:number,y:number,width:number,height:number}>|null}
 */
function computeSplitLayout(area, direction, count, gap) {
  if (!area || (direction !== 'horizontal' && direction !== 'vertical')) return null;
  const n = Math.max(1, Number(count) || 1);
  if (n === 1) {
    return [{ x: area.x, y: area.y, width: area.width, height: area.height }];
  }
  if (direction === 'horizontal') {
    return divide(area.x, area.width, n, gap).map(seg => ({
      x: seg.pos, y: area.y, width: seg.size, height: area.height,
    }));
  }
  return divide(area.y, area.height, n, gap).map(seg => ({
    x: area.x, y: seg.pos, width: area.width, height: seg.size,
  }));
}

/** 兼容旧签名：两视图分屏 */
function computeSplitBounds(area, direction, gap) {
  if (!area || (direction !== 'horizontal' && direction !== 'vertical')) return null;
  const l = computeSplitLayout(area, direction, 2, gap);
  return l ? { main: l[0], attached: l[1] } : null;
}

module.exports = { computeSplitLayout, computeSplitBounds };
