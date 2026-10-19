/**
 * 超时工具 —— 给任意 Promise 加执行上限。
 *
 * 为什么需要：
 *   tool-executor.js 里的 executeJs / executeTool 是 `await window.electronAPI.xxx()`，
 *   如果主进程崩溃/死锁/IPC 通道失效，这个 Promise 永远不会 settle。
 *   preload 侧就会无限挂起，isExecuting 永远是 true，整个处理队列彻底卡死
 *   —— 表现为「AI 说完就没下文」，且没有任何日志或提示。
 *
 *   加上超时后，最坏情况也只是「一次执行被判失败」，任务能继续往下走。
 */

/**
 * 给 Promise 加超时。
 * @param {Promise} promise 原 Promise
 * @param {number} ms 超时毫秒数
 * @param {string} label 超时错误信息里的标签（便于定位是哪个操作超时）
 * @returns {Promise} 原 Promise 的结果，或超时后 reject
 */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const name = label || '操作';
      reject(new Error(name + '超时（' + Math.round(ms / 1000) + ' 秒无响应）'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
}

/** 各操作默认超时（毫秒）。必须大于对应工具自身的 deadline，避免误杀。 */
const TIMEOUTS = {
  // JsRunner 内部 RUN_DEADLINE = 660s（容纳一次 600s 的 bashOutput 等待），留 60s 余量
  executeJs: 720 * 1000,
  // 单个工具：bash/pwsh 默认 30s，但 MCP/插件工具可能更久，给 5 分钟
  executeTool: 300 * 1000,
  // 发送后等待 AI 开始生成的确认窗口
  sendAck: 3000,
};

module.exports = { withTimeout, TIMEOUTS };
