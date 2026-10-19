/**
 * 主进程侧 Promise 超时包装
 *
 * 为什么需要：
 *   preload 侧（src/preload/dom/timeout.js）已有超时保护，720s/300s 后会放弃等待。
 *   但那只解决了「preload 不卡死」，主进程里那个永不 settle 的 Promise 仍然挂着：
 *     - 它持有的资源（文件句柄、子进程引用、MCP 连接）无法释放
 *     - Node 线程池可能被逐步占满，最终所有 IPC 都变慢
 *     - 工具执行状态永远停在 running，tool-lifecycle 清理不掉
 *
 *   所以主进程侧也必须有自己的超时，两侧独立、互为兜底。
 */

/**
 * 给 Promise 加超时。
 * @param {Promise} promise
 * @param {number} ms 超时毫秒数
 * @param {string} label 超时信息里的标签
 * @returns {Promise}
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

/**
 * 各工具类别的默认超时（毫秒）。
 * 必须大于工具自身可能的最长耗时，否则会误杀正常执行。
 */
const DEFAULT_TOOL_TIMEOUTS = {
  bash: 60 * 1000,           // BashTool 自身 timeout 默认 30s，留余量
  pwsh: 60 * 1000,
  bash_background: 10 * 1000, // 只负责启动，立即返回
  bash_output: 620 * 1000,    // 容纳一次 600s 的 wait
  bash_kill: 10 * 1000,
  web_fetch: 60 * 1000,
  web_search: 60 * 1000,
  mysql: 60 * 1000,
  mcp_call: 180 * 1000,       // MCP server 可能较慢
  mcp_list_servers: 30 * 1000,
  mcp_get_tools: 30 * 1000,
  read: 30 * 1000,
  write: 30 * 1000,
  edit: 30 * 1000,
  glob: 60 * 1000,
  grep: 60 * 1000,
  file_read: 30 * 1000,
  file_write: 30 * 1000,
  file_edit: 30 * 1000,
  file_glob: 60 * 1000,
  file_grep: 60 * 1000,
};

// 未列出的工具（插件贡献的等）统一用这个宽松上限
const FALLBACK_TIMEOUT = 300 * 1000;

/**
 * 取某个工具的超时值
 * @param {string} toolName
 * @returns {number} 毫秒
 */
function getTimeoutFor(toolName) {
  const n = DEFAULT_TOOL_TIMEOUTS[toolName];
  return (typeof n === 'number' && n > 0) ? n : FALLBACK_TIMEOUT;
}

module.exports = { withTimeout, getTimeoutFor, DEFAULT_TOOL_TIMEOUTS, FALLBACK_TIMEOUT };
