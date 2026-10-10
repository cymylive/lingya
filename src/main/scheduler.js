/**
 * 定时任务调度器（主进程）
 * 每 30 秒 tick 一次，检查所有启用任务的 cron 是否命中当前分钟。
 * 命中 → 调用注册的 runner 执行（由 schedule-ipc 注入，避免循环依赖）。
 * 错过（LingYa 未运行/电脑关机）：不补跑，等下次命中。
 */
const cron = require('./cron');
const store = require('./schedule-store');

const TICK_MS = 30 * 1000;
let timer = null;
let runner = null; // (task) => Promise<void>
// 记录每个任务上次触发的分钟标记，避免同一分钟重复触发
const lastFired = new Map(); // taskId -> 'YYYY-MM-DD HH:MM'

function minuteKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 注册执行器（schedule-ipc 调用） */
function setRunner(fn) { runner = fn; }

/** 单次 tick（导出供测试） */
async function tick(now) {
  const d = now || new Date();
  const key = minuteKey(d);
  const tasks = store.listTasks();
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (!cron.isValidCron(task.cron)) continue;
    if (!cron.matches(task.cron, d)) continue;
    if (lastFired.get(task.id) === key) continue; // 本分钟已触发
    lastFired.set(task.id, key);
    console.log('[Schedule] 命中任务:', task.name, '(' + task.cron + ')');
    if (runner) {
      try { await runner(task); } catch (err) {
        console.error('[Schedule] 执行任务失败:', task.name, err.message);
      }
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  console.log('[Schedule] 调度器已启动（每 ' + (TICK_MS / 1000) + ' 秒检查）');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { setRunner, tick, start, stop, minuteKey };
