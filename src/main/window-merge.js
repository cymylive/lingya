/**
 * 窗口合并的业务规则（纯逻辑，不依赖 Electron）
 *
 * 合并语义：把源窗口当前显示的视图「搬」到目标窗口里并排显示。
 * 视图本身的原窗口上下文（profileId / sessionStore）保持不变，
 * 由 window.js 继续登记在源窗口 ctx 上 —— 因此工具调用回传不受影响。
 */

const DIRS = ['horizontal', 'vertical'];

/** 归一化方向参数，非法返回 null */
function normalizeDirection(dir) {
  return DIRS.indexOf(dir) >= 0 ? dir : null;
}

/** 取窗口当前显示的视图 */
function activeViewOf(ctx) {
  if (!ctx || !ctx.activeTabId || !ctx.tabs) return null;
  const tab = ctx.tabs.get(ctx.activeTabId);
  return (tab && tab.view) ? tab.view : null;
}

/**
 * 校验并规划一次合并
 * @returns {{ok:true, view, direction} | {ok:false, error:string}}
 */
function planMerge(sourceCtx, targetCtx, direction) {
  const dir = normalizeDirection(direction);
  if (!dir) return { ok: false, error: '合并方向非法，只支持 horizontal / vertical' };
  if (!sourceCtx || !targetCtx) return { ok: false, error: '窗口不存在' };
  if (sourceCtx === targetCtx) return { ok: false, error: '不能把窗口合并到自己' };
  if (sourceCtx.attachedViews && sourceCtx.attachedViews.length) {
    return { ok: false, error: '源窗口已处于分屏状态，请先拆分' };
  }
  // 目标窗口可以接受多次合并；但如果方向不一致，会让布局混乱，要求方向一致
  const targetDir = targetCtx.splitDirection;
  const existing = (targetCtx.attachedViews || []).length;
  if (existing > 0 && targetDir && targetDir !== dir) {
    return { ok: false, error: '目标窗口已按「' + (targetDir === 'horizontal' ? '左右' : '上下') + '」分屏，请选择相同方向' };
  }

  const view = activeViewOf(sourceCtx);
  if (!view) return { ok: false, error: '源窗口没有可合并的视图' };

  return { ok: true, view, direction: dir, targetCount: existing + 2 };
}

/**
 * 校验并规划一次拆分
 * @returns {{ok:true, view} | {ok:false, error:string}}
 */
/** 规划拆分全部附加视图 */
function planUnmergeAll(ctx) {
  if (!ctx) return { ok: false, error: '窗口不存在' };
  const list = ctx.attachedViews || [];
  if (!list.length) return { ok: false, error: '当前窗口没有可拆分的视图' };
  return { ok: true, views: list.slice() };
}

/** 规划拆分指定视图 */
function planUnmergeOne(ctx, webContentsId) {
  if (!ctx) return { ok: false, error: '窗口不存在' };
  const list = ctx.attachedViews || [];
  if (!list.length) return { ok: false, error: '当前窗口没有可拆分的视图' };
  if (webContentsId == null) return planUnmergeAll(ctx);
  const idx = list.findIndex(v => v.webContents && v.webContents.id === webContentsId);
  if (idx < 0) return { ok: false, error: '找不到指定的分屏视图' };
  return { ok: true, view: list[idx] };
}

/** 兼容旧签名：只有一个附加视图时返回 view，多个时返回 views */
function planUnmerge(ctx) {
  const r = planUnmergeAll(ctx);
  if (!r.ok) return r;
  if (r.views.length === 1) return { ok: true, view: r.views[0] };
  return { ok: true, views: r.views };
}

module.exports = { normalizeDirection, planMerge, planUnmerge, planUnmergeAll, planUnmergeOne, activeViewOf };
