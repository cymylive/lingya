/**
 * 定时任务 bridge（运行在 AI 页面 preload）
 * 
 * 解决时序问题：主进程需要花费较长时间初始化，导致任务放入队列的时间晚于前端启动时间。
 * 采用定时轮询机制，只要没收到任务就一直查。
 */

const { sendToChat } = require('./chat-input');
const state = require('./state');
const { getFabState } = require('../overlay/ui');

let pendingTask = null;
let checkTimer = null;
let forceTimer = null;
let pollTimer = null;

/** 发送暂存的任务指令 */
function flushTask() {
  if (!pendingTask) return;
  
  // 检查初始化是否彻底完成。initializationDone 为 true 才是真正的全部分片发送完毕！
  // 不能用 awaitingNextInitialChunk，因为它在第一片发出前和最后一片发完后都是 false，会导致抢跑。
  if (!state.initializationDone) {
    return; // 等待下一次 checkTimer 触发
  }

  // 【新增】必须等 AI 彻底空闲（不再处于生成中），否则回车事件发不出去，内容会卡在输入框。
  if (getFabState() === 'generating') {
    return; // 等待下一次 checkTimer 触发
  }

  const t = pendingTask;
  pendingTask = null;
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }

  const msg = (t.prompt || '');
  console.log('[LingYa Schedule] 开始发送任务指令:', t.name);
  
  sendToChat(msg, '定时任务', 500).then((ok) => {
    if (ok) {
      window.electronAPI.scheduleReportDone({ taskId: t.taskId, taskName: t.name, success: true });
    } else {
      window.electronAPI.scheduleReportDone({ taskId: t.taskId, taskName: t.name, success: false, error: '发送失败（找不到输入框）' });
    }
  }).catch((err) => {
    window.electronAPI.scheduleReportDone({ taskId: t.taskId, taskName: t.name, success: false, error: err.message });
  });
}

let inited = false;
function initScheduleBridge() {
  if (inited) return;
  inited = true;

  // 启动后开始轮询拉取任务（每 2 秒一次）
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (pendingTask) return; // 已经有了，不用再拉
    window.electronAPI.scheduleFetchPending().then((res) => {
      if (!res || !res.success || !res.task) return;
      
      const payload = res.task;
      console.log('[LingYa Schedule] 轮询到待执行任务:', payload.name);
      pendingTask = payload;
      
      // 每 2 秒检查一次分片是否发完
      if (checkTimer) clearInterval(checkTimer);
      checkTimer = setInterval(flushTask, 2000);
      
      // 兜底：120 秒后强制无视分片状态发送
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = setTimeout(() => {
          console.warn('[LingYa Schedule] 等待分片超时，强制执行任务指令');
          state.initializationDone = true;
          state.awaitingNextInitialChunk = false;
          state.initialPromptChunks = null;
          flushTask();
      }, 120000);

      // 立即尝试一次
      setTimeout(flushTask, 1000);
    }).catch((err) => {
      console.error('[LingYa Schedule] 轮询任务失败:', err);
    });
  }, 2000);
}

module.exports = { initScheduleBridge };
