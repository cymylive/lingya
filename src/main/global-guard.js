/**
 * 主进程全局异常保护
 *
 * 为什么需要：
 *   主进程此前没有任何 process 级错误捕获。一旦有未捕获异常或未处理的 Promise rejection，
 *   Node 默认行为是打印一行堆栈然后**直接退出进程** —— 窗口瞬间消失，
 *   用户完全不知道发生了什么，内存里的任务状态全部丢失。
 *
 *   这不是「让崩溃不发生」，而是「让崩溃可见且可恢复」：
 *     - 记录完整堆栈到日志文件，便于事后定位
 *     - 通知所有渲染进程，让 UI 显示明确提示而不是白屏
 *     - 对不致命的情况（Promise rejection）不退出，继续运行
 *     - 对真正致命的情况（uncaughtException）保留退出，但先落盘状态
 *
 * 注意：不试图「吞掉」uncaughtException 后继续跑 —— 此时进程状态可能已不一致，
 *   继续运行比重启更危险。只保证退出前把信息留下来。
 */

let logFilePath = null;
let notifier = null;
let installed = false;

// 记录最近若干条异常，供 UI 查询展示
const recentErrors = [];
const MAX_RECENT = 20;

/**
 * 追加写入错误日志文件（同步写，崩溃前要保证落盘）
 */
function appendLog(line) {
  try {
    const fs = require('fs');
    const path = require('path');
    if (!logFilePath) {
      const { app } = require('electron');
      const dir = app.getPath('userData');
      logFilePath = path.join(dir, 'wyp', 'log', 'main-errors.log');
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    }
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8');
  } catch (_) { /* 日志失败不能再抛 */ }
}

/**
 * 格式化一次异常为可读文本
 */
function format(kind, err) {
  const ts = new Date().toISOString();
  let body;
  if (err && err.stack) {
    body = err.stack;
  } else if (err && typeof err === 'object') {
    try { body = JSON.stringify(err); } catch (_) { body = String(err); }
  } else {
    body = String(err);
  }
  return '[' + ts + '][' + kind + '] ' + body;
}

/** 推入最近错误队列 + 落盘 + 通知 UI */
function record(kind, err, fatal) {
  const text = format(kind, err);
  console.error('[LingYa][致命] ' + text);
  appendLog(text);

  recentErrors.push({ at: Date.now(), kind, text, fatal });
  if (recentErrors.length > MAX_RECENT) recentErrors.shift();

  // 通知所有渲染进程（UI 可以弹提示）
  if (notifier) {
    try { notifier({ kind, message: text, fatal }); } catch (_) {}
  }
}

/**
 * 安装全局保护。
 * @param {object} options
 * @param {Function} [options.onError] 每次记录到错误时回调，参数 { kind, message, fatal }
 * @returns {boolean} 是否首次安装（重复调用返回 false）
 */
function install(options) {
  if (installed) return false;
  installed = true;
  notifier = (options && typeof options.onError === 'function') ? options.onError : null;

  process.on('uncaughtException', (err) => {
    // 同步异常：进程状态可能已损坏，记录后退出。
    // 先给渲染进程一点时间显示提示（不阻塞，靠 before-quit 兜底落盘）。
    record('uncaughtException', err, true);
    // 延迟退出，给 UI 一次显示机会；不可靠时系统会强制结束
    setTimeout(() => {
      try { process.exit(1); } catch (_) { /* ignore */ }
    }, 300);
  });

  process.on('unhandledRejection', (reason) => {
    // Promise rejection 通常不致命：可能是某个 IPC handler 忘了 catch。
    // 记录但不退出，避免因小问题杀掉整个应用。
    record('unhandledRejection', reason, false);
  });

  // 子进程/GPU 进程异常（不致命但值得记录）
  try {
    const { app } = require('electron');
    app.on('child-process-gone', (_e, details) => {
      record('child-process-gone', new Error(
        'type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode
      ), false);
    });
  } catch (_) { /* ignore */ }

  return true;
}

/** 取最近错误列表（供 IPC 查询/UI 展示） */
function getRecentErrors() {
  return recentErrors.slice();
}

/** 取日志文件路径（供 UI 提示"日志在哪"） */
function getLogFilePath() {
  return logFilePath;
}

module.exports = { install, record, getRecentErrors, getLogFilePath };
