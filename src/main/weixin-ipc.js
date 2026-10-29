/**
 * IPC：微信 iLink 通道
 *  - 配置读写 / 扫码登录 / 启停 / 状态查询（覆盖层「微信」面板调用）
 *  - 接收 AI 页面上报（weixin-report）→ 按配置推送到微信
 *  - 微信来消息 → 转发给当前活跃窗口的 AI 页面
 *
 * 消息路由：优先按「该微信用户绑定的窗口」分发；未绑定才回退主窗口。
 * 这样多个通道可以绑定到不同窗口并行工作，互不干扰。
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const weixinClient = require('../weixin/client');
const roundCollector = require('./round-collector');
const { formatTodoPanel, formatEmptyPanel, stripMarkdown } = require('./channel-panel');
const { readConfig, writeConfig } = require('../weixin/config');
const profileManager = require('./profile-manager');

let weixinInited = false;

/** 每个 profile 最近一条微信消息的来源 userId，用于 AI 回复按来源回推 */
const lastWeixinSource = new Map();

/** 最近发过消息的微信用户：userId -> { at }，用于面板选择绑定目标 */
const recentWeixinUsers = new Map();

/** 每个 profile 的任务活跃状态（看门狗用） */
const taskState = new Map();

/**
 * 每个 profile 本轮是否已推过任务计划面板。
 * task-done 时若没推过，补一个「无计划」面板头，保证与 QQ 格式一致。
 */
const panelPushedThisRound = new Map();

/** 缓存每个 profile 当前的待办列表，供状态变化时生成面板 */
const todosCache = new Map();

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
  // 优先按「该微信用户绑定的窗口」路由；未绑定才回退主窗口
  let ctx = null;
  try {
    const bound = profileManager.getProfileByWeixinUser(fromUserId);
    if (bound) {
      ctx = windowState.getWindowByProfileId(bound.id);
      if (ctx) {
        console.log('[Weixin] 按绑定路由到窗口:', bound.name);
      } else {
        console.warn('[Weixin] 绑定的窗口未打开，回退主窗口:', bound.name);
      }
    }
  } catch (err) {
    console.warn('[Weixin] 查绑定失败:', err.message);
  }
  if (!ctx) ctx = windowState.getMainContext();
  if (!ctx) {
    console.warn('[Weixin] 没有活跃窗口，消息丢弃');
    return;
  }
  if (fromUserId) {
    recentWeixinUsers.set(fromUserId, { at: Date.now() });
    // 只保留最近 20 个，防止无限增长
    if (recentWeixinUsers.size > 20) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of recentWeixinUsers) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (oldestKey) recentWeixinUsers.delete(oldestKey);
    }
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
  const reply = async (msg) => {
    try { await weixinClient.sendText(msg, fromUserId); } catch (_) {}
    return true;
  };
  return await require('./channel-commands').handleCommand(text, ctx, reply, '微信');
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

  // ===== 窗口绑定：读当前窗口绑定的微信用户 =====
  ipcMain.handle('weixin-get-binding', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? profileManager.getProfileById(ctx.profileId) : null;
    return {
      success: true,
      userId: (profile && profile.weixinUserId) || '',
      userName: (profile && profile.weixinUserName) || '',
      profileId: ctx ? ctx.profileId : '',
    };
  });

  // ===== 窗口绑定：绑定/解绑当前窗口到某微信用户 =====
  ipcMain.handle('weixin-bind-user', async (event, { userId, userName } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.profileId) return { success: false, error: '找不到窗口' };
    // 同一个微信用户只能绑一个窗口：先清掉其他窗口的绑定
    if (userId) {
      const others = profileManager.readProfiles().filter(p => p.weixinUserId === userId && p.id !== ctx.profileId);
      for (const o of others) {
        profileManager.setProfileWeixinUser(o.id, '', '');
      }
    }
    const p = profileManager.setProfileWeixinUser(ctx.profileId, userId || '', userName || '');
    if (!p) return { success: false, error: '更新失败' };
    return { success: true };
  });

  // ===== 最近发过消息的微信用户（供面板选择绑定目标）=====
  ipcMain.handle('weixin-list-recent-users', async () => {
    const list = [];
    for (const [userId, info] of recentWeixinUsers) {
      // 查一下这个用户当前绑在哪个窗口
      const bound = profileManager.getProfileByWeixinUser(userId);
      list.push({
        userId,
        at: info.at,
        boundProfileId: bound ? bound.id : '',
        boundProfileName: bound ? bound.name : '',
      });
    }
    list.sort((a, b) => b.at - a.at);
    return { success: true, users: list };
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

    // 【轮次聚合（2026-10-30）】微信不支持卡片，与 QQ 同策略纯文本降级：
    //   实时轻提示保留，正文与工具链摘要在 task-done 时合成一条推出。
    let shouldPush = false;
    let body = '';
    const getPanel = (state, isFinal) => {
      const todos = todosCache.get(profileId) || [];
      if (todos.length > 0) return formatTodoPanel(todos, state, { isFinal });
      return formatEmptyPanel(state);
    };

    if (type === 'user-message') {
      roundCollector.onUserMessage(profileId, p.text);
      panelPushedThisRound.set(profileId, false);
      todosCache.delete(profileId);
      if (cfg.pushUserMessage) {
        shouldPush = true;
        body = '👤 ' + String(p.text || '');
      }
    } else if (type === 'ai-start') {
      roundCollector.onAiStart(profileId);
      shouldPush = true;
      body = getPanel('🧠 AI 正在思考…', false);
    } else if (type === 'ai-reply') {
      roundCollector.onAiReply(profileId, p.text, !!p.hasTool, p.thinking);
    } else if (type === 'tool-start') {
      roundCollector.onToolStart(profileId, p.toolName);
      shouldPush = true;
      body = getPanel('🔧 AI 正在调用工具：' + (p.toolName || '…'), false);
    } else if (type === 'tool-end') {
      roundCollector.onToolEnd(profileId);
      shouldPush = true;
      body = getPanel('🧠 AI 正在思考…', false);
    } else if (type === 'todo-panel') {
      panelPushedThisRound.set(profileId, true);
      if (Array.isArray(p.todos)) todosCache.set(profileId, p.todos);
      shouldPush = true;
      body = getPanel(p.activity || '🔨 正在执行计划…', false);
    } else if (type === 'task-done') {
      touchActivity(profileId, false);
      const round = roundCollector.finish(profileId);
      panelPushedThisRound.delete(profileId);
      if (round && (cfg.pushAiReply || cfg.pushToolStatus)) {
        shouldPush = true;
        const parts = [];
        parts.push(getPanel('✅ 已回复', true));
        if (round.userText) parts.push('👤 我：' + round.userText);
        const thinkingText = (round.thinkings || []).join('\n\n').trim();
        if (thinkingText) {
          const brief = thinkingText.length > 300 ? thinkingText.slice(0, 300) + '…（共 ' + thinkingText.length + ' 字）' : thinkingText;
          parts.push('💭 思考过程:\n' + brief);
        }
        if (round.replies.length > 0) {
          parts.push('🤖 AI：\n' + round.replies.join('\n\n'));
        }
        const chain = roundCollector.buildToolChainSummary(round.tools);
        if (chain) {
          const secs = (round.durationMs / 1000).toFixed(1);
          parts.push('🔧 执行过程（' + round.tools.length + ' 步，' + secs + 's）:\n' + chain);
        }
        body = parts.join('\n\n────────\n\n');
      } else if (cfg.pushTaskDone) {
        shouldPush = true;
        body = getPanel('✅ 任务完成', true);
      }
      todosCache.delete(profileId);
    }

    if (!shouldPush || !body.trim()) return { success: true, skipped: true };

    // 【2026-10-30】推送前剥 Markdown 符号（微信不渲染，原样显示是乱码）
    body = stripMarkdown(body);
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
