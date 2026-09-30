/**
 * IPC：飞书同步
 *  - 配置读写 / 启停 / 状态查询（覆盖层「飞书」面板调用）
 *  - 接收 AI 页面上报（feishu-report）→ 按配置推送飞书
 *  - 飞书来消息 → 转发给当前活跃窗口的 AI 页面
 *
 * 移植自 cuckoo-code src/app/ipc/feishu.ts。
 * 适配 LingYa：窗口上下文为 ctx.win（BrowserWindow），非 ctx.view。
 */
const { ipcMain } = require('electron');
const windowState = require('./window');
const feishuClient = require('../feishu/client');
const { readConfig, writeConfig } = require('../feishu/config');
const profileManager = require('./profile-manager');

let feishuInited = false;

/**
 * 飞书来消息 → 按 chatId 找到"绑定了该群的窗口" → 转发给它的 AI 页面。
 * - 群消息（chatId 非空）：只发给绑了该群的窗口
 * - 单聊（chatId 为空）：回退给最近活跃窗口
 */
async function forwardUserMessage(text, chatId) {
  let ctx = null;
  if (chatId) {
    const profile = profileManager.getProfileByFeishuChat(chatId);
    if (!profile) {
      console.warn('[Feishu] 收到群消息，但没有窗口绑定该群，丢弃。chatId=' + chatId);
      return;
    }
    ctx = windowState.getWindowByProfileId(profile.id);
    if (!ctx) {
      console.warn('[Feishu] 群已绑定 profile，但该窗口未打开，丢弃。profileId=' + profile.id);
      return;
    }
  } else {
    ctx = windowState.getMainContext();
  }

  // 斜杠命令：优先于转发（/new /list /help）
  try {
    const handled = await handleFeishuCommand(text, chatId, ctx);
    if (handled) return;
  } catch (err) {
    console.error('[Feishu] 命令处理异常:', err.message);
  }

  const win = ctx && ctx.win;
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    console.warn('[Feishu] 目标窗口不可用，消息丢弃');
    return;
  }
  try {
    win.webContents.send('feishu-user-message', { text });
    console.log('[Feishu] 已转发消息到 AI 页面, 长度=' + text.length + (chatId ? ' (群)' : ' (活跃窗口)'));
  } catch (err) {
    console.error('[Feishu] 转发失败:', err.message);
  }
}

/**
 * 处理飞书来消息里的斜杠命令。
 * @returns {Promise<boolean>} true 表示已作为命令处理（不再转发给 AI）
 */
async function handleFeishuCommand(text, chatId, ctx) {
  const cmd = String(text || '').trim();
  if (!cmd.startsWith('/')) return false;
  const [name] = cmd.slice(1).split(/\s+/);
  const win = ctx && ctx.win;

  const reply = async (msg) => {
    try { await feishuClient.sendText(msg, chatId); } catch (_) {}
    return true;
  };

  if (name === 'help' || name === '?') {
    return reply([
      '🤖 LingYa 指令：',
      '/new — 开新对话（导航到平台首页，下一条消息即新会话）',
      '/list — 列出当前窗口的会话',
      '/help — 显示本帮助',
    ].join('\n'));
  }

  if (name === 'new') {
    if (!win || win.isDestroyed()) return reply('❌ 目标窗口不可用');
    // 从 provider 取首页 URL
    let homeUrl = null;
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(win.webContents.getURL());
      if (provider && provider.homeUrl) homeUrl = provider.homeUrl;
    } catch (_) {}
    if (!homeUrl) return reply('❌ 无法确定平台首页（当前平台未提供 homeUrl）');
    try {
      await win.webContents.loadURL(homeUrl);
      return reply('🆕 已开新对话（已导航到 ' + homeUrl + '）\n下一条消息将进入新会话。');
    } catch (err) {
      return reply('❌ 开新对话失败：' + err.message);
    }
  }

  if (name === 'list') {
    const store = ctx && ctx.sessionStore;
    if (!store) return reply('❌ 当前窗口无会话存储');
    const all = store.readSessionStore();
    const ids = Object.keys(all);
    if (ids.length === 0) return reply('📭 当前窗口暂无历史会话');
    const current = store.state && store.state.currentSessionId;
    const lines = ids.slice(0, 50).map((sid) => {
      const dir = all[sid] || '(未绑定目录)';
      const mark = sid === current ? ' 👈当前' : '';
      return '· ' + sid.slice(0, 8) + '…  ' + dir + mark;
    });
    return reply('📋 会话列表（' + ids.length + '）：\n' + lines.join('\n'));
  }

  return reply('❓ 未知指令：' + name + '（发送 /help 查看可用指令）');
}

/** 通知所有 AI 页面：飞书启用状态（bridge 据此决定是否上报） */
function broadcastFeishuMode(enabled) {
  for (const ctx of windowState.getAllContexts()) {
    try {
      const win = ctx && ctx.win;
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('feishu-mode', { enabled: !!enabled });
      }
    } catch (_) {}
  }
}

/** 初始化飞书（启动时调用：若配置为启用则自动连接） */
function initFeishu() {
  if (feishuInited) return;
  feishuInited = true;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return;
  feishuClient.connect({
    onUserMessage: (text, chatId) => forwardUserMessage(text, chatId),
  });
  broadcastFeishuMode(true);
  console.log('[Feishu] 启动时自动连接（已启用）');
}

function registerFeishuIpc() {
  // bridge 初始化时查询启用状态（避免错过广播时机）
  ipcMain.handle('feishu-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.appId && !!cfg.appSecret };
  });

  // 读配置 + 状态
  ipcMain.handle('feishu-get-config', async () => {
    const cfg = readConfig();
    const st = feishuClient.getStatus();
    // 不把 appSecret 明文回传（用掩码）
    return {
      success: true,
      config: {
        appId: cfg.appId,
        appSecret: cfg.appSecret ? '••••••' : '',
        hasSecret: !!cfg.appSecret,
        enabled: cfg.enabled,
        targetOpenId: cfg.targetOpenId,
        hasTarget: !!cfg.targetOpenId,
        pushUserMessage: cfg.pushUserMessage,
        pushAiReply: cfg.pushAiReply,
        pushToolStatus: cfg.pushToolStatus,
        pushToolName: cfg.pushToolName,
      },
      status: st.status,
      statusDetail: st.detail,
    };
  });

  // 保存配置 + （按需）启停连接
  ipcMain.handle('feishu-save-config', async (_event, { data } = {}) => {
    const before = readConfig();
    const d = Object.assign({}, data || {});
    // 掩码密码不回写（保留原值）
    if (d.appSecret === '••••••') delete d.appSecret;
    const ok = writeConfig(d);
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();
    // 仅当"凭证或启用状态"变化时才重连（纯改推送选项不重连）
    const connChanged = before.appId !== cfg.appId
      || before.appSecret !== cfg.appSecret
      || before.enabled !== cfg.enabled;
    if (!connChanged) return { success: true };
    // 按启用状态连接/断开
    if (cfg.enabled && cfg.appId && cfg.appSecret) {
      feishuClient.connect({ onUserMessage: (text, chatId) => forwardUserMessage(text, chatId) });
      broadcastFeishuMode(true);
    } else {
      feishuClient.disconnect();
      broadcastFeishuMode(false);
    }
    return { success: true };
  });

  // 查询机器人所在的群列表（供窗口下拉选择绑定）
  ipcMain.handle('feishu-list-chats', async () => {
    return await feishuClient.listChats();
  });

  // 读取当前窗口绑定的群
  ipcMain.handle('feishu-get-binding', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? profileManager.getProfileById(ctx.profileId) : null;
    return {
      success: true,
      chatId: (profile && profile.feishuChatId) || '',
      chatName: (profile && profile.feishuChatName) || '',
      profileId: ctx ? ctx.profileId : '',
    };
  });

  // 绑定/解绑当前窗口的群
  ipcMain.handle('feishu-bind-chat', async (event, { chatId, chatName } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.profileId) return { success: false, error: '找不到窗口' };
    const p = profileManager.setProfileFeishuChat(ctx.profileId, chatId || '', chatName || '');
    if (!p) return { success: false, error: '更新失败' };
    return { success: true };
  });

  // 手动重连
  ipcMain.handle('feishu-reconnect', async () => {
    const cfg = readConfig();
    if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置凭证' };
    feishuClient.connect({ onUserMessage: (text, chatId) => forwardUserMessage(text, chatId) });
    return { success: true };
  });

  // 断开
  ipcMain.handle('feishu-disconnect', async () => {
    feishuClient.disconnect();
    broadcastFeishuMode(false);
    return { success: true };
  });

  // AI 页面上报（用户消息 / AI 回复 / 工具状态）→ 按"发起窗口绑定的群"推送
  ipcMain.handle('feishu-report', async (event, payload) => {
    const cfg = readConfig();
    if (!cfg.enabled) return { success: false };
    // 从发起方（AI 页面）反查窗口 → 取该窗口绑定的群
    const ctx = windowState.getContextByWebContents(event.sender);
    const profile = ctx ? profileManager.getProfileById(ctx.profileId) : null;
    const chatId = (profile && profile.feishuChatId) || '';
    if (!chatId) {
      // 该窗口未绑定群：不推送（按需求：未绑定=飞书功能关闭）
      return { success: false, error: 'no-chat-bound' };
    }
    const type = payload && payload.type;
    const push = async (text, label) => {
      const r = await feishuClient.sendText(text, chatId);
      if (!r.success) console.warn('[Feishu] 推送失败（' + label + '）:', r.error);
      return r;
    };
    try {
      if (type === 'user-message') {
        if (!cfg.pushUserMessage) return { success: true };
        const t = String((payload && payload.text) || '').trim();
        if (t) return await push('👤 我：' + t, 'user-message');
      } else if (type === 'ai-reply') {
        if (!cfg.pushAiReply) return { success: true };
        const t = String((payload && payload.text) || '').trim();
        if (t) return await push('🤖 AI：' + t, 'ai-reply');
      } else if (type === 'tool-start') {
        if (!cfg.pushToolStatus) return { success: true };
        return await push(cfg.pushToolName && payload.toolName ? '🔧 正在调用工具：' + payload.toolName : '🔧 AI 正在调用工具…', 'tool-start');
      } else if (type === 'tool-end') {
        if (!cfg.pushToolStatus) return { success: true };
        return await push('✅ 工具调用完成', 'tool-end');
      }
    } catch (err) {
      console.error('[Feishu] 推送异常:', err.message);
      return { success: false, error: err.message };
    }
    return { success: true };
  });
}

module.exports = { registerFeishuIpc, initFeishu, broadcastFeishuMode, forwardUserMessage, handleFeishuCommand };
