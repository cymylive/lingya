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

/** 解析目标窗口 ctx：优先任务指定的 profileId，否则当前活跃窗口 */
function resolveTargetCtx(task) {
  if (task && task.profileId) {
    const ctx = windowState.getWindowByProfileId(task.profileId);
    if (ctx) return ctx;
  }
  return windowState.getMainContext();
}

/** 推送飞书（目标为任务目标窗口绑定的群） */
async function pushFeishu(text, task) {
  try {
    const cfg = readFeishuConfig();
    if (!cfg.enabled) return;
    const ctx = resolveTargetCtx(task);
    const profile = ctx && ctx.profileId ? profileManager.getProfileById(ctx.profileId) : null;
    const chatId = (profile && profile.feishuChatId) || '';
    if (!chatId) return;
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

/** 执行一个任务：在目标窗口新开对话并发指令给 AI */
async function runTask(task) {
  console.log('[Schedule] 执行任务:', task.name);
  await pushFeishu('⏰ 定时任务开始：' + task.name, task);

  const ctx = resolveTargetCtx(task);
  if (!ctx) {
    store.markRun(task.id, { success: false, error: '无可用窗口' });
    await pushFeishu('❌ 定时任务失败（没有可用窗口）：' + task.name, task);
    return;
  }

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
    // 等 renderer 把 systemPrompt 填入输入框并发送（renderer 有 2-4 秒随机延迟）
    await new Promise((r) => setTimeout(r, 4000));
  } catch (err) {
    console.error('[Schedule] initProject 失败:', err.message);
  }

  // 3) 发指令给 AI。bridge 会暂存任务，等 AI 回复完成（初始化就绪）后再真正发送，
  //    避免覆盖还没发出去的 systemPrompt。
  try {
    const wc = ctx.win.webContents;
    wc.send('schedule-run', { taskId: task.id, name: task.name, prompt: task.prompt });
    store.markRun(task.id, { success: true, at: new Date().toISOString() });
  } catch (err) {
    store.markRun(task.id, { success: false, error: err.message });
    await pushFeishu('❌ 定时任务失败：' + task.name + '（' + err.message + '）', task);
  }
}

function registerScheduleIpc() {
  scheduler.setRunner(runTask);
  scheduler.start();

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
    const t = store.addTask({ name, cron: cronExpr, prompt, enabled, profileId, projectDir });
    return { success: true, task: t };
  });

  // 修改任务
  ipcMain.handle('schedule-update', async (_e, { id, patch } = {}) => {
    if (patch && patch.cron && !cron.isValidCron(patch.cron)) {
      return { success: false, error: 'cron 表达式无效' };
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
