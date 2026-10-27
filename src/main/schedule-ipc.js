/**
 * 定时任务 IPC + 执行流程
 *  - CRUD（覆盖层「定时」面板调用）
 *  - 执行：到点 → 在目标窗口"新开对话" → 注入项目提示词 → 把任务指令发给 AI
 *  - 通知：复用飞书（AI 回复/完成/卡住自动推送），另在开始/失败时单独推
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const profileManager = require('./profile-manager');
const store = require('./schedule-store');
const cron = require('./cron');
const scheduler = require('./scheduler');
const feishuClient = require('../feishu/client');
const { readConfig: readFeishuConfig } = require('../feishu/config');

/**
 * 解析目标窗口 ctx（严格模式）。
 *
 * 【重要】任务必须指定 profileId，且该 profile 的窗口必须处于打开状态。
 * 任一条件不满足就返回失败，绝不降级到其它窗口 —— 降级会导致：
 *   - 用错账号发内容（番茄音乐项目 A/B 账号混发）
 *   - 污染别的会话（任务提示词注入到无关对话）
 *   - 用户以为任务没跑，实际在别处跑过了
 *
 * @returns {{ ok: boolean, ctx?: object, error?: string }}
 */
function resolveTargetCtx(task) {
  if (!task || !task.profileId) {
    return { ok: false, error: '任务未指定执行窗口（请在任务配置里选择目标窗口）' };
  }
  const ctx = windowState.getWindowByProfileId(task.profileId);
  if (!ctx) {
    const p = profileManager.getProfileById(task.profileId);
    const pname = (p && p.name) ? p.name : task.profileId;
    return { ok: false, error: '任务指定的窗口「' + pname + '」未打开，已跳过本次执行' };
  }
  return { ok: true, ctx };
}

/** 推送飞书（目标为任务目标窗口绑定的群） */
async function pushFeishu(text, task) {
  try {
    const cfg = readFeishuConfig();
    if (!cfg.enabled) return;
    const res = resolveTargetCtx(task);
    const ctx = res.ok ? res.ctx : null;
    const profile = ctx && ctx.profileId ? profileManager.getProfileById(ctx.profileId) : null;
    const chatId = (profile && profile.feishuChatId) || '';
    // 【不要因 chatId 为空就 return】
    // 窗口未打开时正好最需要通知用户「任务已跳过」，此时拿不到 profile.feishuChatId，
    // 但 sendText 内部会回退到全局 targetOpenId 单聊。
    // 直接 return 会导致用户完全收不到通知（连「为什么没跑」都看不到）。
    await feishuClient.sendText(text, chatId);
  } catch (_) {}
}

/** 默认项目目录（用户未填时用，确保 initProject 能注入工具能力） */
function getDefaultProjectDir() {
  try {
    const { app } = require('electron');
    const path = require('path');
    const fs = require('fs');
    const dir = path.join(app.getPath('userData'), 'scheduled-tasks');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (_) {
    return process.cwd();
  }
}

/** 在目标窗口新开对话（导航到平台首页） */
async function openNewChat(ctx) {
  const win = ctx && ctx.win;
  if (!win || win.isDestroyed()) return { ok: false, error: '目标窗口不可用（未打开？）' };
  const wc = win.webContents;
  let homeUrl = null;
  try {
    const { getProviderByUrl } = require('../providers');
    const provider = getProviderByUrl(wc.getURL());
    if (provider && provider.homeUrl) homeUrl = provider.homeUrl;
  } catch (_) {}
  if (!homeUrl) return { ok: false, error: '无法确定平台首页' };
  try {
    await wc.loadURL(homeUrl);
  } catch (err) {
    return { ok: false, error: '新开对话失败：' + err.message };
  }
  // 等页面 preload 监听器就绪
  await new Promise((r) => setTimeout(r, 1200));
  return { ok: true };
}

// 待推送的定时任务队列（按 profileId 隔离，确保只推给对应的窗口）
let pendingScheduleTask = null;

/** 执行一个任务：在目标窗口新开对话并发指令给 AI */
async function runTask(task) {
  console.log('[Schedule] 执行任务:', task.name);
  await pushFeishu('⏰ 定时任务开始：' + task.name, task);

  // 【严格模式】窗口不满足条件直接跳过，绝不降级到其它窗口执行。
  // 降级会造成：用错账号发内容、污染无关会话、用户以为没跑实际在别处跑过。
  const res = resolveTargetCtx(task);
  if (!res.ok) {
    console.warn('[Schedule] 跳过任务「' + task.name + '」：' + res.error);
    store.markRun(task.id, { success: false, error: res.error });
    await pushFeishu('⏭ 定时任务已跳过：' + task.name + '（' + res.error + '）', task);
    return;
  }
  const ctx = res.ctx;

  // 1) 新开对话
  const opened = await openNewChat(ctx);
  if (!opened.ok) {
    store.markRun(task.id, { success: false, error: opened.error });
    await pushFeishu('❌ 定时任务失败：' + task.name + '（' + opened.error + '）', task);
    return;
  }

  // 2) 始终注入初始化提示词（工具能力）。
  //    用户没填项目目录时用默认目录——否则 AI 会没有工具能力（裸聊）。
  const projectDir = task.projectDir || getDefaultProjectDir();
  try {
    const { initProject } = require('./project-context');
    await initProject(false, ctx, projectDir);
    // 等 renderer 把 systemPrompt 填入输入框并发送。
    // 注意：用户的系统提示词可能分多段发送，且间隔配置可能达 6000ms。
    // 这里把等待时间延长到 8 秒，确保基础分片有机会进入发送队列。
    // 后续的分片处理交由 renderer 的 schedule-bridge 精确判断。
    await new Promise((r) => setTimeout(r, 8000));
  } catch (err) {
    console.error('[Schedule] initProject 失败:', err.message);
  }

  // 3) 暂存任务，等前端主动来拉取。
  //    为什么不再用 wc.send：新打开的标签页 preload 尚未执行完毕，直接 send 必定丢失。
  //    改为前端就绪后主动调用 schedule-fetch-pending 领取任务。
  pendingScheduleTask = {
    taskId: task.id,
    name: task.name,
    prompt: task.prompt,
    profileId: ctx.profileId,
    task: task // 保留完整 task 供飞书推送用
  };
  console.log('[Schedule] 任务已暂存，等待前端拉取:', task.name);
}

function registerScheduleIpc() {
  scheduler.setRunner(runTask);
  scheduler.start();

  // ===== 新增：前端主动拉取待执行任务 =====
  ipcMain.handle('schedule-fetch-pending', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '未找到窗口上下文' };
    if (pendingScheduleTask && pendingScheduleTask.profileId === ctx.profileId) {
      const t = pendingScheduleTask;
      pendingScheduleTask = null; // 取走即清空，防止重复执行
      return { success: true, task: t };
    }
    return { success: true, task: null };
  });

  // ===== 新增：前端发送成功后的回执 =====
  ipcMain.handle('schedule-report-done', async (_e, { taskId, taskName, success, error } = {}) => {
    try {
      if (success) {
        store.markRun(taskId, { success: true, at: new Date().toISOString() });
        console.log('[Schedule] 前端回执：任务发送成功', taskName);
      } else {
        store.markRun(taskId, { success: false, error: error || '发送失败' });
        await pushFeishu('❌ 定时任务失败：' + taskName + '（' + (error || '发送失败') + '）', null);
      }
    } catch (err) {
      console.error('[Schedule] 回执处理失败:', err.message);
    }
    return { success: true };
  });

  // 列出任务
  ipcMain.handle('schedule-list', async () => {
    return { success: true, tasks: store.listTasks() };
  });

  // 列出可选目标窗口（供面板下拉）
  ipcMain.handle('schedule-list-windows', async () => {
    const profiles = profileManager.readProfiles();
    return {
      success: true,
      windows: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        open: !!windowState.getWindowByProfileId(p.id),
      })),
    };
  });

  // 新增任务
  ipcMain.handle('schedule-add', async (_e, { name, cron: cronExpr, prompt, enabled, profileId, projectDir } = {}) => {
    if (!cron.isValidCron(cronExpr)) return { success: false, error: 'cron 表达式无效' };
    if (!prompt || !String(prompt).trim()) return { success: false, error: '任务指令不能为空' };
    // 【必填】必须指定执行窗口。定时任务在后台跑，指定错窗口可能用错账号发内容。
    if (!profileId || !String(profileId).trim()) {
      return { success: false, error: '必须选择执行窗口（任务只会在该窗口打开时执行）' };
    }
    const t = store.addTask({ name, cron: cronExpr, prompt, enabled, profileId, projectDir });
    return { success: true, task: t };
  });

  // 修改任务
  ipcMain.handle('schedule-update', async (_e, { id, patch } = {}) => {
    if (patch && patch.cron && !cron.isValidCron(patch.cron)) {
      return { success: false, error: 'cron 表达式无效' };
    }
    // 防止把已指定的窗口清空（会导致任务无法执行）
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'profileId') &&
        (!patch.profileId || !String(patch.profileId).trim())) {
      return { success: false, error: '执行窗口不能为空（任务只会在该窗口打开时执行）' };
    }
    const t = store.updateTask(id, patch || {});
    if (!t) return { success: false, error: '任务不存在' };
    return { success: true, task: t };
  });

  // 删除任务
  ipcMain.handle('schedule-delete', async (_e, { id } = {}) => {
    return { success: store.deleteTask(id) };
  });

  // 立即执行一次（调试/手动）
  ipcMain.handle('schedule-run-now', async (_e, { id } = {}) => {
    const t = store.getTask(id);
    if (!t) return { success: false, error: '任务不存在' };
    runTask(t).catch(() => {});
    return { success: true };
  });

  // 校验 cron（面板实时提示）
  ipcMain.handle('schedule-validate', async (_e, { cron: cronExpr } = {}) => {
    return { success: true, valid: cron.isValidCron(cronExpr) };
  });

  // 页面执行结果回传 → 飞书
  ipcMain.handle('schedule-report', async (_e, payload = {}) => {
    const { name, ok, error } = payload;
    const t = store.listTasks().find((x) => x.name === name);
    if (ok) await pushFeishu('🏁 定时任务完成：' + (name || ''), t);
    else await pushFeishu('❌ 定时任务失败：' + (name || '') + (error ? ('（' + error + '）') : ''), t);
    return { success: true };
  });
}

module.exports = { registerScheduleIpc, runTask, pushFeishu, resolveTargetCtx, openNewChat };
