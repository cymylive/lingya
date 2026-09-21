/**
 * 活动子进程跟踪器（主进程与 tools 共享）
 *
 * 目的：让"停止任务"能真正 kill 掉正在跑的 bash / pwsh / JS 沙箱子进程。
 * - 每个工具在 spawn 子进程时调用 register(child)
 * - 进程结束时调用 unregister(child)
 * - 用户点「停止」时主进程调用 killAll()，遍历 kill 并清空
 *
 * 同时维护一个全局 aborted 标志：停止后，正在运行的 JS 沙箱在下一次
 * 工具调用前会检测到该标志并主动中止，避免停止后继续执行后续步骤。
 */
const { execFileSync } = require('child_process');

const active = new Set();
let aborted = false;

/** 注册一个正在运行的子进程 */
function register(child) {
  if (child && typeof child.kill === 'function') {
    active.add(child);
  }
}

/** 注销一个已结束的子进程 */
function unregister(child) {
  active.delete(child);
}

/**
 * kill 掉所有活动子进程（Windows 用 taskkill /T 杀整棵进程树）。
 * @returns {number} 被处理（尝试 kill）的进程数
 */
function killAll() {
  let n = 0;
  for (const child of active) {
    try {
      if (process.platform === 'win32' && child.pid) {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
          { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      } else {
        child.kill('SIGKILL');
      }
      n++;
    } catch (_) {
      try { child.kill('SIGKILL'); n++; } catch (_) { /* ignore */ }
    }
  }
  active.clear();
  return n;
}

/** 当前活动进程数 */
function count() {
  return active.size;
}

/** 标记为已中止（停止任务时调用） */
function markAborted() {
  aborted = true;
}

/** 清除中止标志（用户下次发消息时调用） */
function clearAborted() {
  aborted = false;
}

/** 是否已中止 */
function isAborted() {
  return aborted;
}

module.exports = { register, unregister, killAll, count, markAborted, clearAborted, isAborted };
