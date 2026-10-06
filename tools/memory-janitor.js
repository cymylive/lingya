/**
 * 内存清理器 - 工具调用完成后强制回收
 *
 * 原理：Node/Electron 默认不暴露 global.gc()，但主进程可用
 *   v8.setFlagsFromString('--expose-gc') + vm.runInNewContext('gc')
 * 拿到真正的 GC 函数。
 *
 * 用途：工具调用（读大文件、跑命令）会产生大量瞬时对象（字符串/Buffer/数组）。
 * V8 的 GC 是惰性的，不会立刻回收，物理内存（rss）也不会立刻归还 OS。
 * 主动触发一次 gc()，把已无引用的对象尽快回收并把内存归还系统。
 *
 * 注意：gc() 只回收「已无引用」的对象。其它会话/其它模块仍持有引用的对象
 * 不会被回收 —— 因此调用它是安全的，不会误清别人的数据。
 *
 * 节流：gc() 是 stop-the-world，频繁调用会卡顿。默认最小间隔 800ms，
 * 期间多次请求会合并为一次（取最后一次）。
 */
const v8 = require('v8');
const vm = require('vm');

let gcFn = null;
let gcResolved = false;

const MIN_INTERVAL = 800;   // 两次 gc 的最小间隔（毫秒）
let lastRun = 0;
let pendingTimer = null;

/** 尝试获取主进程的真实 gc 函数（一次性） */
function ensureGc() {
  if (gcResolved) return gcFn;
  gcResolved = true;
  try {
    v8.setFlagsFromString('--expose-gc');
    gcFn = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    if (typeof gcFn !== 'function') gcFn = null;
  } catch (err) {
    console.warn('[Janitor] 无法启用 gc():', err.message);
    gcFn = null;
  }
  return gcFn;
}

/**
 * 触发一次内存回收（带节流）。
 * @param {boolean} [async=true] true=用定时器延后（不阻塞当前响应）
 * @returns {boolean} 是否成功安排/执行
 */
function collect(async = true) {
  const gc = ensureGc();
  if (typeof gc !== 'function') return false;

  const run = () => {
    lastRun = Date.now();
    pendingTimer = null;
    try { gc(); } catch (_) { /* ignore */ }
  };

  if (!async) {
    // 同步：仅在距上次足够久时才真正执行（避免同批调用里连续 stop-the-world）
    if (Date.now() - lastRun < MIN_INTERVAL) return false;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    run();
    return true;
  }

  // 异步：节流合并
  const sinceLast = Date.now() - lastRun;
  if (sinceLast >= MIN_INTERVAL) {
    if (pendingTimer) return true; // 已有排队的
    pendingTimer = setTimeout(run, 0);
    return true;
  }
  // 还在冷却期：若已有排队则复用，否则安排到冷却结束
  if (!pendingTimer) {
    pendingTimer = setTimeout(run, MIN_INTERVAL - sinceLast);
  }
  return true;
}

/** 当前内存使用快照（MB） */
function snapshot() {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576 * 10) / 10;
  return { heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), rss: mb(m.rss), external: mb(m.external) };
}

/** 获取清理能力状态（供诊断） */
function status() {
  return { gcAvailable: typeof ensureGc() === 'function', memory: snapshot() };
}

module.exports = { collect, snapshot, status };
