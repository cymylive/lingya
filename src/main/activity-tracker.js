/**
 * 工具活动追踪器（主进程内存态，按会话隔离）
 *
 * 用途：跨窗口任务总控台需要知道「每个窗口当前有没有工具在跑、最近一次工具是否失败」。
 * 只记录摘要，不存工具输入输出，内存开销可忽略。
 *
 * 会话键：sessionKey = profileId::sessionId（与 tool-lifecycle 保持一致）
 */

const activities = new Map(); // sessionKey -> { running, lastToolName, lastAt, lastOk }

// 【2026-10-30】变更回调：工具 start/end 时通知订阅方（主进程广播用）。
// 本模块是纯逻辑、不依赖 electron，广播函数由 main 侧注入。
let onChange = null;
/** 注册变更回调（传 null 取消） */
function setOnChange(fn) {
  onChange = typeof fn === 'function' ? fn : null;
}
/** 内部：安全触发回调，异常绝不影响工具执行 */
function fireChange(sessionKey) {
  if (!onChange) return;
  try { onChange(sessionKey); } catch (_) { /* 广播失败不影响主流程 */ }
}

/** 取某会话的活动摘要（不存在时返回空活动，不创建条目） */
function get(sessionKey) {
  const a = activities.get(sessionKey);
  if (!a) return { running: 0, lastToolName: null, lastAt: 0, lastOk: null };
  return { running: a.running, lastToolName: a.lastToolName, lastAt: a.lastAt, lastOk: a.lastOk };
}

/** 工具开始执行 */
function start(sessionKey, toolName) {
  if (!sessionKey) return;
  let a = activities.get(sessionKey);
  if (!a) { a = { running: 0, lastToolName: null, lastAt: 0, lastOk: null }; activities.set(sessionKey, a); }
  a.running += 1;
  a.lastToolName = toolName || 'unknown';
  a.lastAt = Date.now();
  fireChange(sessionKey);
}

/** 工具执行结束（ok 表示是否成功） */
function end(sessionKey, ok) {
  if (!sessionKey) return;
  let a = activities.get(sessionKey);
  if (!a) { a = { running: 0, lastToolName: null, lastAt: 0, lastOk: null }; activities.set(sessionKey, a); }
  a.running = Math.max(0, a.running - 1);
  a.lastAt = Date.now();
  a.lastOk = (ok === true);
  fireChange(sessionKey);
}

/** 清空某会话的活动记录（会话切换/关闭时调用） */
function clear(sessionKey) {
  if (!sessionKey) return;
  activities.delete(sessionKey);
}

/** 统计（供诊断） */
function stats() {
  let running = 0;
  for (const a of activities.values()) running += a.running;
  return { sessions: activities.size, running };
}

module.exports = { get, start, end, clear, stats, setOnChange };
