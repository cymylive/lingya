/**
 * AI 生成状态追踪（主进程内存态，按 webContents 隔离）
 *
 * 用途：「全部分屏」总控台需要知道某个面板的 AI 当前是否在思考/生成。
 * 真相源在 AI 视图侧（overlay/ui.js 的 renderTaskbar），它每次状态变化都会
 * 通过 lingya-report-task-state 上报。主进程原先只转发给壳窗口，没留下记录，
 * 导致总控台只看得到「工具是否在跑」，AI 纯文本生成时被判为空闲。
 *
 * 键：AI 视图的 webContents.id
 * 值：{ visible, kind, text, at }
 */

const states = new Map();

/** 超过该时长未刷新视为失效（AI 视图被关掉/崩溃时不会再有上报） */
const STALE_MS = 30000;

/** 记录一次状态上报 */
function set(webContentsId, payload) {
  if (webContentsId == null) return;
  const p = payload || {};
  if (!p.visible) {
    states.delete(webContentsId);
    return;
  }
  states.set(webContentsId, {
    visible: true,
    kind: String(p.kind || ''),
    text: String(p.text || ''),
    at: Date.now(),
  });
}

/**
 * 取某个 webContents 的生成状态
 * @returns {{ generating: boolean, kind: string, text: string } | null}
 *   null 表示没有记录或已过期
 */
function get(webContentsId, now) {
  if (webContentsId == null) return null;
  const s = states.get(webContentsId);
  if (!s) return null;
  const t = typeof now === 'number' ? now : Date.now();
  if (t - s.at > STALE_MS) return null;
  return { generating: true, kind: s.kind, text: s.text };
}

/** 清空某个 webContents 的记录（视图销毁时调用） */
function clear(webContentsId) {
  if (webContentsId == null) return;
  states.delete(webContentsId);
}

/** 清掉所有过期记录（防止关闭的视图留下残条目） */
function prune(now) {
  const t = typeof now === 'number' ? now : Date.now();
  for (const [id, s] of states) {
    if (t - s.at > STALE_MS) states.delete(id);
  }
}

/** 统计（供诊断） */
function stats() {
  return { tracked: states.size };
}

module.exports = { set, get, clear, prune, stats, STALE_MS };
