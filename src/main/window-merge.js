/**
 * 窗口合并的业务规则（纯逻辑，不依赖 Electron）
 *
 * 合并语义：点击合并的窗口是【宿主】，被点击的窗口是【来源】。
 * 来源窗口当前显示的视图被搬进宿主窗口并排显示，来源窗口随后关闭。
 * 视图本身的原窗口上下文（profileId / sessionStore）保持不变，
 * 由 window.js 的视图归属表继续维护 —— 因此工具调用回传不受影响。
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
 * @param {object} hostCtx   宿主窗口（发起合并的那个，会保留）
 * @param {object} sourceCtx 来源窗口（被合并进来的那个，视图搬走后关闭）
 * @param {'horizontal'|'vertical'} direction
 * @returns {{ok:true, view, direction, targetCount} | {ok:false, error:string}}
 */
function planMerge(hostCtx, sourceCtx, direction) {
  const dir = normalizeDirection(direction);
  if (!dir) return { ok: false, error: '合并方向非法，只支持 horizontal / vertical' };
  if (!hostCtx || !sourceCtx) return { ok: false, error: '窗口不存在' };
  if (hostCtx === sourceCtx) return { ok: false, error: '不能把窗口合并到自己' };

  // 来源窗口不能已分屏（它的多视图结构搬不过来）
  if (sourceCtx.attachedViews && sourceCtx.attachedViews.length) {
    return { ok: false, error: '被合并的窗口已处于分屏状态，请先拆分它' };
  }
  // 宿主已分屏时，方向必须与现有分屏一致，否则布局会乱
  const existing = (hostCtx.attachedViews || []).length;
  if (existing > 0 && hostCtx.splitDirection && hostCtx.splitDirection !== dir) {
    return {
      ok: false,
      error: '当前窗口已按「' + (hostCtx.splitDirection === 'horizontal' ? '左右' : '上下') + '」分屏，请选择相同方向',
    };
  }

  const view = activeViewOf(sourceCtx);
  if (!view) return { ok: false, error: '被合并的窗口没有可合并的视图' };

  return { ok: true, view, direction: dir, targetCount: existing + 2 };
}

/** 规划拆分全部附加视图 */
function planUnmergeAll(ctx) {
  if (!ctx) return { ok: false, error: '窗口不存在' };
  const list = ctx.attachedViews || [];
  if (!list.length) return { ok: false, error: '当前窗口没有可拆分的视图' };
  return { ok: true, views: list.slice() };
}

/** 规划拆分指定视图（webContentsId 为空 = 拆全部） */
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
