/**
 * IPC：QQ 通道
 *  - 配置读写 / 启停 / 状态查询
 *  - 接收 AI 页面上报（qq-report）→ 按配置推送
 *  - QQ 来消息 → 转发给当前活跃窗口的 AI 页面
 *
 * 消息路由：优先按「该 QQ 用户/群绑定的窗口」分发；未绑定才回退主窗口。
 * 主动推送有每月 4 条限制。
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const qqClient = require('../qq/client');
const { readConfig, writeConfig } = require('../qq/config');
const profileManager = require('./profile-manager');

let qqInited = false;

/** 每个 profile 最近的 QQ 消息来源 { msgId, openid, kind } */
const lastQqSource = new Map();

/** 最近发过消息的 QQ 用户/群：openid -> { at, kind }，用于面板选择绑定目标 */
const recentQqUsers = new Map();

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
  // 优先按「该 QQ 用户/群绑定的窗口」路由；未绑定才回退主窗口
  let ctx = null;
  try {
    const bound = profileManager.getProfileByQqOpenId(openid);
    if (bound) {
      ctx = windowState.getWindowByProfileId(bound.id);
      if (ctx) {
        console.log('[QQ] 按绑定路由到窗口:', bound.name);
      } else {
        console.warn('[QQ] 绑定的窗口未打开，回退主窗口:', bound.name);
      }
    }
  } catch (err) {
    console.warn('[QQ] 查绑定失败:', err.message);
  }
  if (!ctx) ctx = windowState.getMainContext();
  if (!ctx) {
    console.warn('[QQ] 没有活跃窗口，消息丢弃');
    return;
  }
  if (openid) {
    recentQqUsers.set(openid, { at: Date.now(), kind: kind || 'c2c' });
    // 只保留最近 20 个
    if (recentQqUsers.size > 20) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of recentQqUsers) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (oldestKey) recentQqUsers.delete(oldestKey);
    }
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
  const reply = async (msg) => {
    try { await qqClient.sendText(msg, { msgId, openid, kind }); } catch (_) {}
    return true;
  };
  return await require('./channel-commands').handleCommand(text, ctx, reply, 'QQ');
}

function registerQqIpc() {
  ipcMain.handle('qq-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.appId && !!cfg.appSecret };
  });

  // ===== 窗口绑定：读当前窗口绑定的 QQ 用户 =====
  ipcMain.handle('qq-get-binding', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? profileManager.getProfileById(ctx.profileId) : null;
    return {
      success: true,
      openId: (profile && profile.qqOpenId) || '',
      openName: (profile && profile.qqOpenName) || '',
      profileId: ctx ? ctx.profileId : '',
    };
  });

  // ===== 窗口绑定：绑定/解绑当前窗口到某 QQ 用户/群 =====
  ipcMain.handle('qq-bind-openid', async (event, { openId, openName } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.profileId) return { success: false, error: '找不到窗口' };
    // 同一个 QQ 目标只能绑一个窗口
    if (openId) {
      const others = profileManager.readProfiles().filter(p => p.qqOpenId === openId && p.id !== ctx.profileId);
      for (const o of others) {
        profileManager.setProfileQqOpenId(o.id, '', '');
      }
    }
    const p = profileManager.setProfileQqOpenId(ctx.profileId, openId || '', openName || '');
    if (!p) return { success: false, error: '更新失败' };
    return { success: true };
  });

  // ===== 最近发过消息的 QQ 用户（供面板选择绑定目标）=====
  ipcMain.handle('qq-list-recent-users', async () => {
    const list = [];
    for (const [openId, info] of recentQqUsers) {
      const bound = profileManager.getProfileByQqOpenId(openId);
      list.push({
        openId,
        kind: info.kind,
        at: info.at,
        boundProfileId: bound ? bound.id : '',
        boundProfileName: bound ? bound.name : '',
      });
    }
    list.sort((a, b) => b.at - a.at);
    return { success: true, users: list };
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

    console.log('[QQ] 准备推送到 QQ, 目标:', src.openid, '内容长度:', body.length);
    const r = await qqClient.sendText(body, src);
    if (!r.success) console.warn('[QQ] 推送失败:', r.error);
    else console.log('[QQ] 推送成功');
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
