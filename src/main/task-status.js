/**
 * 跨窗口任务状态推导（纯函数，无 Electron 依赖）
 *
 * 用于「全部分屏」总控台：把某个窗口的 todo 列表 + 最近工具活动，
 * 归纳成一个可展示的状态。
 */

/** 工具静默超过该时长（且有 in_progress）视为卡住 */
const STUCK_MS = 60000;

/** 统计 todo 各状态数量 */
function summarizeTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  let completed = 0, inProgress = 0, pending = 0;
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { total: list.length, completed, inProgress, pending };
}

/**
 * 推导窗口状态
 * @param {object} p
 * @param {Array} p.todos 该窗口当前会话的 todo 列表
 * @param {object} p.activity { running:number, lastToolName:string|null, lastAt:number, lastOk:boolean|null }
 * @param {number} p.now 当前时间戳（便于测试注入）
 * @returns {'running'|'stuck'|'error'|'done'|'waiting'|'idle'}
 */
function deriveStatus(p) {
  const o = p || {};
  const todos = Array.isArray(o.todos) ? o.todos : [];
  const act = o.activity || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const sum = summarizeTodos(todos);
  const running = Number(act.running) || 0;
  const lastAt = Number(act.lastAt) || 0;

  // 1) 有工具正在执行 —— 一定在跑
  if (running > 0) return 'running';

  // 2) 有进行中的任务
  if (sum.inProgress > 0) {
    const idleMs = lastAt ? (now - lastAt) : Infinity;
    if (idleMs > STUCK_MS) return 'stuck';
    return 'running';
  }

  // 3) 最近一次工具失败 → 出错（即使 todo 都标完了，也可能最后一步失败）
  if (act.lastOk === false && lastAt) return 'error';

  // 4) 全部完成
  if (sum.total > 0 && sum.completed === sum.total) return 'done';

  // 5) 有 pending 没开始
  if (sum.pending > 0) return 'waiting';

  // 6) 空
  return 'idle';
}

module.exports = { deriveStatus, summarizeTodos, STUCK_MS };
