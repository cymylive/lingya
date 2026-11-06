/**
 * 手机远程控制：IPC 注册
 * 供桌面设置页调用；服务/隧道/粘合层在此接线。
 */
const { ipcMain } = require('electron');
const config = require('./remote/config');
const server = require('./remote/server');
const manager = require('./remote/manager');
const tunnel = require('./remote/tunnel');

let registered = false;
let currentRemoteConfig = null;

function getRemoteConfig() {
  if (!currentRemoteConfig) currentRemoteConfig = config.readConfig();
  return currentRemoteConfig;
}

function saveRemoteConfig(patch) {
  config.writeConfig(patch);
  currentRemoteConfig = config.readConfig();
  return currentRemoteConfig;
}

/** 启动服务（不启隧道） */
async function startService() {
  const cfg = getRemoteConfig();
  const r = await server.startServer({
    port: cfg.port,
    token: cfg.token,
    deps: {
      onUserMessage: (text) => manager.onUserMessage(text, manager.currentProfileId || ''),
      onStop: () => manager.onStop(manager.currentProfileId || ''),
      onSelectProfile: (pid, ws) => manager.onSelectProfile(pid, ws),
    },
  });
  if (!r.ok) return { ok: false, error: r.error };
  manager.initRemote({ server });
  return { ok: true, port: r.port };
}

/** 停止服务与隧道 */
async function stopAll() {
  try { await tunnel.stopTunnel(); } catch (_) {}
  try { await server.stopServer(); } catch (_) {}
  try { manager.stopRemote(); } catch (_) {}
}

/** 启动隧道 */
async function startTunnelNow() {
  const cfg = getRemoteConfig();
  if (!server.isRunning()) {
    const s = await startService();
    if (!s.ok) return { ok: false, error: s.error };
  }
  const r = await tunnel.startTunnel({
    port: cfg.port,
    tunnelToken: cfg.tunnelToken || '',
    edgeDns: cfg.edgeDns || '',
    onUrlDetected: (url) => { saveRemoteConfig({ publicUrl: url }); },
  });
  if (r.ok && r.url) {
    saveRemoteConfig({ publicUrl: r.url });
  } else {
    saveRemoteConfig({ publicUrl: '' });
  }
  return r;
}

/** 聚合状态（设置页轮询） */
function getStatus() {
  const cfg = getRemoteConfig();
  const ts = tunnel.getTunnelStatus();
  return {
    enabled: cfg.enabled === true,
    port: cfg.port,
    token: cfg.token,
    publicUrl: cfg.publicUrl || ts.url || '',
    serverRunning: server.isRunning(),
    tunnel: ts,
    clients: server.listClients(),
    platform: process.platform,
    profiles: manager.listProfilesForRemote(),
  };
}

function registerRemoteIpc() {
  if (registered) return;
  registered = true;

  ipcMain.handle('remote-status', async () => ({ success: true, ...getStatus() }));

  ipcMain.handle('remote-set-enabled', async (event, enabled) => {
    const cfg = saveRemoteConfig({ enabled: !!enabled });
    if (cfg.enabled) {
      const s = await startService();
      if (!s.ok) return { success: false, error: s.error };
    } else {
      await stopAll();
    }
    return { success: true, ...getStatus() };
  });

  ipcMain.handle('remote-set-config', async (event, patch) => {
    const p = patch || {};
    const next = {};
    if (typeof p.port === 'number') next.port = p.port;
    if (typeof p.tunnelToken === 'string') next.tunnelToken = p.tunnelToken;
    if (typeof p.publicUrl === 'string') next.publicUrl = p.publicUrl;
    saveRemoteConfig(next);
    return { success: true, ...getStatus() };
  });

  ipcMain.handle('remote-reset-token', async () => {
    const token = config.genToken();
    saveRemoteConfig({ token });
    try { server.kickAll(); } catch (_) {}
    return { success: true, ...getStatus() };
  });

  ipcMain.handle('remote-start-tunnel', async () => {
    const r = await startTunnelNow();
    return { success: !!r.ok, error: r.error || '', ...getStatus() };
  });

  ipcMain.handle('remote-stop-tunnel', async () => {
    try { await tunnel.stopTunnel(); } catch (_) {}
    saveRemoteConfig({ publicUrl: '' });
    return { success: true, ...getStatus() };
  });

  ipcMain.handle('remote-list-clients', async () => ({ success: true, clients: server.listClients() }));

  ipcMain.handle('remote-kick-all', async () => {
    try { server.kickAll(); } catch (_) {}
    return { success: true, ...getStatus() };
  });

  // AI 视图上报的任务状态变化 -> 手机
  // 由 index.js 的 lingya-report-task-state 处理器调用
  ipcMain.handle('remote-ai-event', async (event, payload) => {
    const p = payload || {};
    try { manager.broadcastAiEvent(p.webContentsId, p.kind || '', p.data || {}); } catch (_) {}
    return { success: true };
  });
}

/** 应用启动时若已启用则自动拉起服务 */
async function initRemoteOnBoot() {
  const cfg = getRemoteConfig();
  if (!cfg.enabled) return { ok: true, skipped: true };
  const s = await startService();
  if (!s.ok) return s;
  if (cfg.tunnelEnabled || cfg.tunnelToken) {
    try { await startTunnelNow(); } catch (_) {}
  }
  return { ok: true };
}

module.exports = {
  registerRemoteIpc,
  initRemoteOnBoot,
  stopAll,
  getStatus,
  startService,
  startTunnelNow,
};
