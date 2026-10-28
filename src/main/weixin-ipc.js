/**
 * IPC：微信 iLink 通道
 *  - 配置读写 / 扫码登录 / 启停 / 状态查询（覆盖层「微信」面板调用）
 *  - 接收 AI 页面上报（weixin-report）→ 按配置推送到微信
 *  - 微信来消息 → 转发给当前活跃窗口的 AI 页面
 *
 * 与飞书的区别：iLink 以单聊为主，没有群绑定概念，
 * 消息一律路由到主窗口（或最近活跃窗口）。
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const weixinClient = require('../weixin/client');
const { readConfig, writeConfig } = require('../weixin/config');

let weixinInited = false;

/** 每个 profile 最近一条微信消息的来源 userId，用于 AI 回复按来源回推 */
const lastWeixinSource = new Map();

/** 每个 profile 的任务活跃状态（看门狗用） */
const taskState = new Map();

const STALL_CHECK_INTERVAL_MS = 15 * 1000;

function getStallTimeoutMs() {
  const sec = readConfig().stallTimeoutSec;
  if (typeof sec !== 'number') return 660 * 1000;
  if (sec === 0) return 0;
  return (sec >= 30 ? sec : 660) * 1000;
}
let watchdogTimer = null;

function touchActivity(profileId, active) {
  if (!profileId) return;
  let st = taskState.get(profileId);
  if (!st) { st = { active: false, lastActivity: 0, warned: false }; taskState.set(profileId, st); }
  st.lastActivity = Date.now();
  st.warned = false;
  if (active !== undefined) st.active = !!active;
}

/** 静默超时 → 推送告警（每次卡住只告警一次） */
function startStallWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try {
      if (!readConfig().enabled) return;
      const timeout = getStallTimeoutMs();
      if (!timeout) return;
      const now = Date.now();
      for (const [profileId, st] of taskState) {
        if (!st.active || st.warned) continue;
        if (now - st.lastActivity < timeout) continue;
        st.warned = true;
        st.active = false;
        const src = lastWeixinSource.get(profileId);
        if (!src || !src.userId) continue;
        const mins = Math.max(1, Math.round((now - st.lastActivity) / 60000));
        weixinClient.sendText(
          '⚠️ 任务疑似卡住：已 ' + mins + ' 分钟无进展。\n' +
          '可发送任意消息唤醒，或 /stop 后重新下指令。',
          src.userId
        ).catch(() => {});
        console.warn('[Weixin] 看门狗告警: profile=' + profileId + ', 静默 ' + mins + ' 分钟');
      }
    } catch (err) {
      console.error('[Weixin] 看门狗异常:', err.message);
    }
  }, STALL_CHECK_INTERVAL_MS);
}

/**
 * 微信来消息 → 转发给活跃窗口的 AI 页面。
 * iLink 是单聊模型，不区分群，一律回退主窗口。
 */
async function forwardUserMessage(text, fromUserId) {
  const ctx = windowState.getMainContext();
  if (!ctx) {
    console.warn('[Weixin] 没有活跃窗口，消息丢弃');
    return;
  }
  if (ctx.profileId) {
    lastWeixinSource.set(ctx.profileId, { userId: fromUserId || '' });
  }

  // 斜杠命令优先
  try {
    const handled = await handleWeixinCommand(text, fromUserId, ctx);
    if (handled) return;
  } catch (err) {
    console.error('[Weixin] 命令处理异常:', err.message);
  }

  const win = ctx && ctx.win;
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    console.warn('[Weixin] 目标窗口不可用，消息丢弃');
    return;
  }
  try {
    win.webContents.send('weixin-user-message', { text });
    console.log('[Weixin] 已转发消息到 AI 页面, 长度=' + text.length);
  } catch (err) {
    console.error('[Weixin] 转发失败:', err.message);
  }
}

/** 处理微信来消息里的斜杠命令 */
async function handleWeixinCommand(text, fromUserId, ctx) {
  const cmd = String(text || '').trim();
  if (!cmd.startsWith('/')) return false;
  const parts = cmd.slice(1).split(/\s+/);
  const name = parts[0];
  const win = ctx && ctx.win;

  const reply = async (msg) => {
    try { await weixinClient.sendText(msg, fromUserId); } catch (_) {}
    return true;
  };

  if (name === 'help' || name === '?') {
    return reply([
      '🤖 LingYa 微信指令：',
      '/new [项目名] — 开新对话',
      '/list — 列出会话',
      '/stop — 停止当前任务',
      '/help — 显示本帮助',
    ].join('\n'));
  }

  if (name === 'stop') {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('lingya-stop-task');
      }
      return reply('⏹ 已发送停止指令');
    } catch (err) {
      return reply('❌ 停止失败: ' + err.message);
    }
  }

  if (name === 'new') {
    if (!win || win.isDestroyed()) return reply('❌ 目标窗口不可用');
    try {
      win.webContents.send('lingya-new-conversation', { title: parts.slice(1).join(' ') || '' });
      return reply('✅ 已触发新建对话');
    } catch (err) {
      return reply('❌ 新建失败: ' + err.message);
    }
  }

  if (name === 'list') {
    if (!win || win.isDestroyed()) return reply('❌ 目标窗口不可用');
    try {
      win.webContents.send('lingya-list-conversations');
      return reply('📋 已在桌面列出会话');
    } catch (err) {
      return reply('❌ 列会话失败: ' + err.message);
    }
  }

  return reply('❓ 未知指令：/' + name + '，发 /help 查看用法');
}

/** 广播微信模式开关（供 AI 页面 bridge 决定是否监听） */
function broadcastWeixinMode(on) {
  try {
    for (const ctx of windowState.getAllContexts()) {
      const wc = ctx.win && ctx.win.webContents;
      if (wc && !wc.isDestroyed()) {
        try { wc.send('weixin-mode', { enabled: !!on }); } catch (_) {}
      }
    }
  } catch (_) {}
}

function registerWeixinIpc() {
  // 初始化时查询启用状态（避免错过广播时机）
  ipcMain.handle('weixin-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.botToken };
  });

  // 读配置 + 状态
  ipcMain.handle('weixin-get-config', async () => {
    const cfg = readConfig();
    const st = weixinClient.getStatus();
    return {
      success: true,
      config: {
        enabled: cfg.enabled,
        // token 不回传明文，只标记是否存在
        hasToken: !!cfg.botToken,
        botId: cfg.botId,
        userId: cfg.userId,
        pushUserMessage: cfg.pushUserMessage,
        pushAiReply: cfg.pushAiReply,
        pushToolStatus: cfg.pushToolStatus,
        pushToolName: cfg.pushToolName,
        pushTaskDone: cfg.pushTaskDone,
        stallTimeoutSec: cfg.stallTimeoutSec,
      },
      status: st.status,
      statusDetail: st.detail,
    };
  });

  // 扫码登录：拿二维码
  ipcMain.handle('weixin-get-qrcode', async () => {
    return await weixinClient.getLoginQrcode();
  });

  // 扫码登录：轮询状态（单次，前端自己循环）
  ipcMain.handle('weixin-check-qrcode', async (_event, { qrcode } = {}) => {
    if (!qrcode) return { status: 'error', error: 'qrcode 不能为空' };
    const st = await weixinClient.checkQrcodeStatus(qrcode);
    // 登录成功后自动启动轮询
    if (st.status === 'confirmed' && st.credentials && st.credentials.botToken) {
      // 【关键修复】必须先落盘凭证，否则 startPolling() 内部读不到 token 直接报错
      writeConfig({
        botToken: st.credentials.botToken,
        botId: st.credentials.botId,
        userId: st.credentials.userId,
        ...(st.baseUrl ? { baseUrl: st.baseUrl } : {}),
        enabled: true,
      });
      weixinClient.setCallbacks({
        onUserMessage: (text, from) => forwardUserMessage(text, from),
        onStatusChange: (s, d) => broadcastWeixinMode(s === 'connected'),
      });
      weixinClient.startPolling(true);
      broadcastWeixinMode(true);
      console.log('[Weixin] 扫码成功，凭证已落盘，已自动启动长轮询');
    }
    return st;
  });

  // 保存配置 + 按需启停
  ipcMain.handle('weixin-save-config', async (_event, { data } = {}) => {
    const before = readConfig();
    const ok = writeConfig(data || {});
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();

    const connChanged = before.enabled !== cfg.enabled
      || before.botToken !== cfg.botToken;

    if (!connChanged) return { success: true };

    if (cfg.enabled && cfg.botToken) {
      weixinClient.setCallbacks({
        onUserMessage: (text, from) => forwardUserMessage(text, from),
        onStatusChange: (s) => broadcastWeixinMode(s === 'connected'),
      });
      weixinClient.startPolling();
      broadcastWeixinMode(true);
    } else {
      weixinClient.stopPolling();
      broadcastWeixinMode(false);
    }
    return { success: true };
  });

  // 手动重连
  ipcMain.handle('weixin-reconnect', async () => {
    const cfg = readConfig();
    if (!cfg.botToken) return { success: false, error: '未登录，请先扫码' };
    weixinClient.setCallbacks({
      onUserMessage: (text, from) => forwardUserMessage(text, from),
      onStatusChange: (s) => broadcastWeixinMode(s === 'connected'),
    });
    weixinClient.startPolling(true);
    return { success: true };
  });

  // 断开 / 退出登录
  ipcMain.handle('weixin-disconnect', async () => {
    weixinClient.stopPolling();
    broadcastWeixinMode(false);
    return { success: true };
  });

  ipcMain.handle('weixin-logout', async () => {
    weixinClient.logout();
    broadcastWeixinMode(false);
    return { success: true };
  });

  // AI 页面上报 → 推送到微信
  ipcMain.handle('weixin-report', async (event, payload) => {
    const cfg = readConfig();
    if (!cfg.enabled || !cfg.botToken) return { success: false };

    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : '';
    const src = profileId ? lastWeixinSource.get(profileId) : null;
    const toUserId = (src && src.userId) || cfg.userId;
    if (!toUserId) return { success: false, error: '没有可用的推送目标' };

    const p = payload || {};
    const type = p.type || '';  // 前端 bridge 发来的字段是 type

    // 更新活跃状态（看门狗用）
    if (type === 'user-message' || type === 'tool-start') touchActivity(profileId, true);

    let shouldPush = false;
    let body = '';
    if (type === 'user-message' && cfg.pushUserMessage) {
      shouldPush = true;
      body = '👤 ' + String(p.text || '');
    } else if (type === 'ai-reply' && cfg.pushAiReply) {
      shouldPush = true;
      body = String(p.text || '');
    } else if (type === 'tool-start' && cfg.pushToolStatus) {
      shouldPush = true;
      body = cfg.pushToolName && p.toolName ? '🔧 正在调用工具：' + p.toolName : '🔧 AI 正在调用工具…';
    } else if (type === 'tool-end' && cfg.pushToolStatus) {
      shouldPush = true;
      body = '✅ 工具调用完成';
    } else if (type === 'task-done' && cfg.pushTaskDone) {
      shouldPush = true;
      body = '🏁 任务完成';
      touchActivity(profileId, false);
    }

    if (!shouldPush || !body.trim()) return { success: true, skipped: true };

    console.log('[Weixin] 准备推送到微信, 目标:', toUserId, '内容长度:', body.length);
    const r = await weixinClient.sendText(body, toUserId);
    if (!r.success) console.warn('[Weixin] 推送失败:', r.error);
    else console.log('[Weixin] 推送成功');
    return r;
  });

  console.log('[Weixin] IPC 已注册');
}

/**
 * 启动时若已启用且有 token，自动恢复长轮询。
 * 由 main/index.js 在主窗口就绪后调用。
 */
function autoConnectIfEnabled() {
  if (weixinInited) return;
  weixinInited = true;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.botToken) return;
  weixinClient.setCallbacks({
    onUserMessage: (text, from) => forwardUserMessage(text, from),
    onStatusChange: (s) => broadcastWeixinMode(s === 'connected'),
  });
  weixinClient.startPolling();
  startStallWatchdog();
  broadcastWeixinMode(true);
  console.log('[Weixin] 启动时自动恢复长轮询');
}

module.exports = { registerWeixinIpc, autoConnectIfEnabled };
