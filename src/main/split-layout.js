/**
 * 分屏布局计算（纯函数，无 Electron 依赖）
 *
 * 窗口合并后，宿主窗口需要同时摆放两个 WebContentsView：
 *  - main     : 宿主窗口自己的 active tab 视图
 *  - attached : 从另一个窗口合并进来的视图
 *
 * @param {{x:number,y:number,width:number,height:number}} area 可用区域（已扣除侧栏、标签栏）
 * @param {'none'|'horizontal'|'vertical'} direction
 *        horizontal = 左右并排；vertical = 上下堆叠
 * @param {number} gap 两个视图之间的分隔条宽度（px），无间隙传 0
 * @returns {{main:Rect, attached:Rect}|null} direction 为 none 或未知时返回 null
 */
function computeSplitBounds(area, direction, gap) {
  if (!area || (direction !== 'horizontal' && direction !== 'vertical')) return null;
  const g = Math.max(0, Number(gap) || 0);
  const { x, y, width, height } = area;

  if (direction === 'horizontal') {
    const each = Math.max(0, Math.floor((width - g) / 2));
    return {
      main: { x, y, width: each, height },
      attached: { x: x + each + g, y, width: each, height },
    };
  }

  const each = Math.max(0, Math.floor((height - g) / 2));
  return {
    main: { x, y, width, height: each },
    attached: { x, y: y + each + g, width, height: each },
  };
}

module.exports = { computeSplitBounds };
