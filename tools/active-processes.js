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
// 中止标志按窗口/会话隔离：A 窗口点停止不应影响 B 窗口。
// 不传 key 的旧调用点退化为 '__global'，行为与原来一致。
const abortedKeys = new Set();
const GLOBAL_KEY = '__global';

// 子进程归属：child -> key（窗口 profileId），用于按窗口隔离 kill
const owner = new WeakMap();

/** 注册一个正在运行的子进程 */
function register(child, key) {
  if (child && typeof child.kill === 'function') {
    active.add(child);
    if (key) owner.set(child, key);
  }
}

/** 注销一个已结束的子进程 */
function unregister(child) {
  active.delete(child);
}

/**
 * kill 掉活动子进程（Windows 用 taskkill /T 杀整棵进程树）。
 * @param {string} [key] 只杀属于该 key 的进程。不传则杀全部（兼容旧调用）。
 * @returns {number} 被处理（尝试 kill）的进程数
 */
function killAll(key) {
  let n = 0;
  const targets = [];
  for (const child of active) {
    if (key !== undefined && owner.get(child) !== key) continue;
    targets.push(child);
  }
  for (const child of targets) {
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
    active.delete(child);
  }
  return n;
}

/** 当前活动进程数 */
function count() {
  return active.size;
}

/**
 * 标记为已中止（停止任务时调用）。
 * @param {string} [key] 隔离键（窗口 profileId）。不传则记为全局，影响所有窗口。
 */
function markAborted(key) {
  abortedKeys.add(key || GLOBAL_KEY);
}

/**
 * 清除中止标志（用户下次发消息时调用）。
 * @param {string} [key] 隔离键。不传则清空全部（兼容旧调用）。
 */
function clearAborted(key) {
  if (key === undefined) {
    abortedKeys.clear();
  } else {
    abortedKeys.delete(key || GLOBAL_KEY);
  }
}

/**
 * 是否已中止。
 * @param {string} [key] 隔离键（窗口 profileId）。
 *   传了：只查该 key 或全局标记。
 *   不传：任一 key 被标记就算中止（兼容旧调用点）。
 */
function isAborted(key) {
  if (key === undefined) return abortedKeys.size > 0;
  return abortedKeys.has(key) || abortedKeys.has(GLOBAL_KEY);
}

module.exports = { register, unregister, killAll, count, markAborted, clearAborted, isAborted };
