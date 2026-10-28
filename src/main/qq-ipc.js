/**
 * IPC：QQ 通道
 *  - 配置读写 / 启停 / 状态查询
 *  - 接收 AI 页面上报（qq-report）→ 按配置推送
 *  - QQ 来消息 → 转发给当前活跃窗口的 AI 页面
 *
 * 与飞书的差异：QQ 是被动回复模型（60 秒窗口），没有群绑定概念，
 * 消息一律路由到主窗口。主动推送有每月 4 条限制。
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const qqClient = require('../qq/client');
const { readConfig, writeConfig } = require('../qq/config');

let qqInited = false;

/** 每个 profile 最近的 QQ 消息来源 { msgId, openid, kind } */
const lastQqSource = new Map();

/** 任务活跃状态（看门狗用） */
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
        const src = lastQqSource.get(profileId);
        if (!src || !src.msgId) continue;
        const mins = Math.max(1, Math.round((now - st.lastActivity) / 60000));
        qqClient.sendText(
          '⚠️ 任务疑似卡住：已 ' + mins + ' 分钟无进展。\n可发送任意消息唤醒，或 /stop 后重新下指令。',
          src
        ).catch(() => {});
        console.warn('[QQ] 看门狗告警: profile=' + profileId + ', 静默 ' + mins + ' 分钟');
      }
    } catch (err) {
      console.error('[QQ] 看门狗异常:', err.message);
    }
  }, STALL_CHECK_INTERVAL_MS);
}

/** 广播 QQ 模式开关 */
function broadcastQqMode(on) {
  try {
    for (const ctx of windowState.getAllContexts()) {
      const wc = ctx.win && ctx.win.webContents;
      if (wc && !wc.isDestroyed()) {
        try { wc.send('qq-mode', { enabled: !!on }); } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * QQ 来消息 → 转发给活跃窗口的 AI 页面。
 */
async function forwardUserMessage(text, openid, kind, msgId) {
  const ctx = windowState.getMainContext();
  if (!ctx) {
    console.warn('[QQ] 没有活跃窗口，消息丢弃');
    return;
  }
  if (ctx.profileId) {
    lastQqSource.set(ctx.profileId, { msgId, openid, kind });
  }

  try {
    const handled = await handleQqCommand(text, openid, kind, msgId, ctx);
    if (handled) return;
  } catch (err) {
    console.error('[QQ] 命令处理异常:', err.message);
  }

  const win = ctx && ctx.win;
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    console.warn('[QQ] 目标窗口不可用，消息丢弃');
    return;
  }
  try {
    win.webContents.send('qq-user-message', { text });
    console.log('[QQ] 已转发消息到 AI 页面, 长度=' + text.length);
  } catch (err) {
    console.error('[QQ] 转发失败:', err.message);
  }
}

/** 斜杠命令 */
async function handleQqCommand(text, openid, kind, msgId, ctx) {
  const cmd = String(text || '').trim();
  if (!cmd.startsWith('/')) return false;
  const parts = cmd.slice(1).split(/\s+/);
  const name = parts[0];
  const win = ctx && ctx.win;

  const reply = async (msg) => {
    try { await qqClient.sendText(msg, { msgId, openid, kind }); } catch (_) {}
    return true;
  };

  if (name === 'help' || name === '?') {
    return reply([
      '🤖 LingYa QQ 指令：',
      '/new [项目名] — 开新对话',
      '/list — 列出会话',
      '/stop — 停止当前任务',
      '/help — 显示本帮助',
    ].join('\n'));
  }

  if (name === 'stop') {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('lingya-stop-task');
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

function registerQqIpc() {
  ipcMain.handle('qq-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.appId && !!cfg.appSecret };
  });

  ipcMain.handle('qq-get-config', async () => {
    const cfg = readConfig();
    const st = qqClient.getStatus();
    return {
      success: true,
      config: {
        appId: cfg.appId,
        appSecret: cfg.appSecret ? '••••••' : '',
        hasSecret: !!cfg.appSecret,
        enabled: cfg.enabled,
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

  ipcMain.handle('qq-save-config', async (_event, { data } = {}) => {
    const before = readConfig();
    const d = Object.assign({}, data || {});
    if (d.appSecret === '••••••') delete d.appSecret;
    const ok = writeConfig(d);
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();

    const connChanged = before.appId !== cfg.appId
      || before.appSecret !== cfg.appSecret
      || before.enabled !== cfg.enabled;
    if (!connChanged) return { success: true };

    if (cfg.enabled && cfg.appId && cfg.appSecret) {
      const r = await qqClient.connect();
      if (!r.success) return { success: false, error: r.error };
      broadcastQqMode(true);
      startStallWatchdog();
    } else {
      qqClient.disconnect();
      broadcastQqMode(false);
    }
    return { success: true };
  });

  ipcMain.handle('qq-reconnect', async () => {
    const r = await qqClient.connect();
    if (r.success) broadcastQqMode(true);
    return r;
  });

  ipcMain.handle('qq-disconnect', async () => {
    qqClient.disconnect();
    broadcastQqMode(false);
    return { success: true };
  });

  ipcMain.handle('qq-report', async (event, payload) => {
    const cfg = readConfig();
    if (!cfg.enabled) return { success: false };

    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : '';
    const src = profileId ? lastQqSource.get(profileId) : null;
    if (!src || !src.msgId) return { success: false, error: '没有可用的 QQ 消息来源' };

    const p = payload || {};
    const type = p.type || '';

    if (type === 'user-message' || type === 'ai-start' || type === 'tool-start') touchActivity(profileId, true);
    else if (type === 'ai-reply') touchActivity(profileId, !(p && p.hasTool));
    else if (type === 'task-done') touchActivity(profileId, false);

    let body = '';
    if (type === 'user-message' && cfg.pushUserMessage) {
      body = '👤 我：' + String(p.text || '').trim();
    } else if (type === 'ai-start' && cfg.pushToolStatus) {
      body = '🧠 AI 正在生成…';
    } else if (type === 'ai-reply' && cfg.pushAiReply) {
      body = '🤖 AI：' + String(p.text || '').trim();
    } else if (type === 'tool-start' && cfg.pushToolStatus) {
      body = cfg.pushToolName && p.toolName ? '🔧 正在调用工具：' + p.toolName : '🔧 AI 正在调用工具…';
    } else if (type === 'tool-end' && cfg.pushToolStatus) {
      body = '✅ 工具调用完成';
    } else if (type === 'task-done' && cfg.pushTaskDone) {
      body = '🏁 任务完成';
    }

    if (!body.trim()) return { success: true, skipped: true };

    const r = await qqClient.sendText(body, src);
    return r;
  });

  console.log('[QQ] IPC 已注册');
}

/**
 * 启动时若已启用则自动连接。
 */
function autoConnectIfEnabled() {
  if (qqInited) return;
  qqInited = true;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return;
  qqClient.setCallbacks({
    onUserMessage: (text, openid, kind, msgId) => forwardUserMessage(text, openid, kind, msgId),
    onStatusChange: (s) => broadcastQqMode(s === 'connected'),
  });
  qqClient.connect().then((r) => {
    if (r.success) {
      broadcastQqMode(true);
      startStallWatchdog();
      console.log('[QQ] 启动时自动连接');
    } else {
      console.warn('[QQ] 启动时自动连接失败:', r.error);
    }
  }).catch((err) => {
    console.error('[QQ] 自动连接异常:', err.message);
  });
}

module.exports = { registerQqIpc, autoConnectIfEnabled };
