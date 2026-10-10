/**
 * 暴露给渲染进程的 API（contextBridge + window 兜底）
 * 由原 preload.js 拆分而来，行为保持不变。
 */
const { contextBridge, ipcRenderer } = require('electron');

// ========== 暴露给渲染进程的 API ==========
// 尝试 contextBridge，如果失败则直接挂载到 window（作为 fallback）
let electronAPI = {
  executeCommand: (command, id) => {
    return ipcRenderer.invoke('execute-command', { command, id });
  },
  initProject: (projectDir, isCompaction) => {
    return ipcRenderer.invoke('init-project', {
      skipPrompt: false,
      projectDir: projectDir || null,
      isCompaction: !!isCompaction,
    });
  },
  updateProjectDir: () => {
    return ipcRenderer.invoke('init-project', { skipPrompt: true });
  },
  executeTool: (toolName, params, callId) => {
    return ipcRenderer.invoke('execute-tool', { toolName, params, callId });
  },
  executeJs: (code, callId) => {
    return ipcRenderer.invoke('execute-js', { code, callId });
  },
  sendEnterToChat: () => {
    return ipcRenderer.invoke('chat-send-enter');
  },
  simulateMouse: (action, x, y) => {
    return ipcRenderer.invoke('simulate-mouse', { action, x, y });
  },
  stopExecution: () => {
    return ipcRenderer.invoke('abort-execution');
  },
  // 内存诊断 / 手动回收
  memoryStatus: () => ipcRenderer.invoke('memory-status'),
  memoryCollect: () => ipcRenderer.invoke('memory-collect'),
  toolLifecycleStats: () => ipcRenderer.invoke('tool-lifecycle-stats'),
  toolLifecycleSweep: (sessionKey) => ipcRenderer.invoke('tool-lifecycle-sweep', { sessionKey }),
  clearAbort: () => {
    return ipcRenderer.invoke('clear-abort');
  },
  listSessions: () => {
    return ipcRenderer.invoke('list-sessions');
  },
  navigateSession: (sessionId) => {
    return ipcRenderer.invoke('navigate-session', { sessionId });
  },
  createProfileWindow: () => {
    return ipcRenderer.invoke('create-profile-window');
  },
  listProfiles: () => {
    return ipcRenderer.invoke('list-profiles');
  },
  openProfileWindow: (profileId) => {
    return ipcRenderer.invoke('open-profile-window', { profileId });
  },
  deleteProfileWindow: (profileId) => {
    return ipcRenderer.invoke('delete-profile', { profileId });
  },
  updateWindowName: (displayName) => {
    return ipcRenderer.invoke('update-window-name', { displayName });
  },
  showAiNotification: () => {
    return ipcRenderer.invoke('show-ai-notification');
  },
  // ========== 记忆系统 API ==========
  listMemories: () => {
    return ipcRenderer.invoke('memory-list');
  },
  saveMemory: (memory) => {
    return ipcRenderer.invoke('memory-save', { memory });
  },
  updateMemory: (memory) => {
    return ipcRenderer.invoke('memory-update', { memory });
  },
  deleteMemory: (id) => {
    return ipcRenderer.invoke('memory-delete', { id });
  },
  buildMemorySection: (prompt) => {
    return ipcRenderer.invoke('memory-build-section', { prompt });
  },
  importMemories: () => {
    return ipcRenderer.invoke('memory-import');
  },
  exportMemories: () => {
    return ipcRenderer.invoke('memory-export');
  },
  // ========== Skill 系统 API ==========
  listSkills: () => {
    return ipcRenderer.invoke('skill-list');
  },
  saveSkill: (skill) => {
    return ipcRenderer.invoke('skill-save', { skill });
  },
  deleteSkill: (name) => {
    return ipcRenderer.invoke('skill-delete', { name });
  },
  setSkillEnabled: (name, enabled) => {
    return ipcRenderer.invoke('skill-set-enabled', { name, enabled });
  },
  importSkillFolder: () => {
    return ipcRenderer.invoke('skill-import-folder');
  },
  // ========== Agent 系统 API（Plan / Build 模式）==========
  listAgents: () => {
    return ipcRenderer.invoke('agent-list');
  },
  setAgent: (agentId) => {
    return ipcRenderer.invoke('agent-set', { agentId });
  },
  getCurrentAgent: () => {
    return ipcRenderer.invoke('agent-current');
  },
  // ========== 计划（todoWrite）API ==========
  getTodos: () => {
    return ipcRenderer.invoke('get-todos');
  },
  onTodosUpdated: (cb) => {
    const handler = (_e, todos) => cb(todos);
    ipcRenderer.on('lingya-todos-updated', handler);
    return () => ipcRenderer.removeListener('lingya-todos-updated', handler);
  },
  // ========== 安全增强 API（CTF 注入 + 拒绝拦截）==========
  getSecurityConfig: () => {
    return ipcRenderer.invoke('security-get-config').then(r => (r && r.success ? r.config : null));
  },
  updateSecurityConfig: (config) => {
    return ipcRenderer.invoke('security-update-config', { config });
  },
  resetSecurityConfig: () => {
    return ipcRenderer.invoke('security-reset-config');
  },
  rewriteRefusal: (refusalText) => {
    return ipcRenderer.invoke('security-rewrite-refusal', { refusalText });
  },
  getCtfPrompt: () => {
    return ipcRenderer.invoke('security-get-ctf-prompt');
  },
  // ========== MCP 相关 API ==========
  listMcpServers: () => {
    return ipcRenderer.invoke('list-mcp-servers');
  },
  upsertMcpServer: (server) => {
    return ipcRenderer.invoke('upsert-mcp-server', { server });
  },
  removeMcpServer: (name) => {
    return ipcRenderer.invoke('remove-mcp-server', { name });
  },
  enableMcpServer: (name) => {
    return ipcRenderer.invoke('enable-mcp-server', { name });
  },
  disableMcpServer: (name) => {
    return ipcRenderer.invoke('disable-mcp-server', { name });
  },
  getMcpTools: () => {
    return ipcRenderer.invoke('get-mcp-tools');
  },
  // ========== 平台相关 API ==========
  listProviders: () => {
    return ipcRenderer.invoke('list-providers');
  },
  selectPlatform: (providerId) => {
    return ipcRenderer.invoke('select-platform', { providerId });
  },
  createProfileWindowWithProvider: (providerId) => {
    return ipcRenderer.invoke('create-profile-window', { providerId });
  },
  importProvider: () => {
    return ipcRenderer.invoke('import-provider');
  },
  removeProvider: (filePath, providerId) => {
    return ipcRenderer.invoke('remove-provider', { path: filePath, providerId });
  },
  replaceProvider: (providerId) => {
    return ipcRenderer.invoke('replace-provider', { providerId });
  },
  // ========== 飞书同步 API ==========
  getFeishuEnabled: () => {
    return ipcRenderer.invoke('feishu-is-enabled');
  },
  getFeishuConfig: () => {
    return ipcRenderer.invoke('feishu-get-config');
  },
  saveFeishuConfig: (data) => {
    return ipcRenderer.invoke('feishu-save-config', { data });
  },
  listFeishuChats: () => {
    return ipcRenderer.invoke('feishu-list-chats');
  },
  getFeishuBinding: () => {
    return ipcRenderer.invoke('feishu-get-binding');
  },
  bindFeishuChat: (chatId, chatName) => {
    return ipcRenderer.invoke('feishu-bind-chat', { chatId, chatName });
  },
  reconnectFeishu: () => {
    return ipcRenderer.invoke('feishu-reconnect');
  },
  disconnectFeishu: () => {
    return ipcRenderer.invoke('feishu-disconnect');
  },
  feishuReport: (payload) => {
    return ipcRenderer.invoke('feishu-report', payload);
  },
  // 主进程 → 渲染进程的事件监听（监听器注册，返回取消函数）
  onFeishuMode: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('feishu-mode', handler);
    return () => ipcRenderer.removeListener('feishu-mode', handler);
  },
  onFeishuUserMessage: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('feishu-user-message', handler);
    return () => ipcRenderer.removeListener('feishu-user-message', handler);
  },
  onFeishuStop: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('feishu-stop', handler);
    return () => ipcRenderer.removeListener('feishu-stop', handler);
  },
  // ========== 定时任务 API ==========
  scheduleList: () => ipcRenderer.invoke('schedule-list'),
  scheduleAdd: (data) => ipcRenderer.invoke('schedule-add', data),
  scheduleUpdate: (id, patch) => ipcRenderer.invoke('schedule-update', { id, patch }),
  scheduleDelete: (id) => ipcRenderer.invoke('schedule-delete', { id }),
  scheduleRunNow: (id) => ipcRenderer.invoke('schedule-run-now', { id }),
  scheduleListWindows: () => ipcRenderer.invoke('schedule-list-windows'),
  scheduleValidate: (cron) => ipcRenderer.invoke('schedule-validate', { cron }),
  scheduleReport: (payload) => ipcRenderer.invoke('schedule-report', payload),
  onScheduleRun: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('schedule-run', handler);
    return () => ipcRenderer.removeListener('schedule-run', handler);
  },
};

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) {
  console.error('[LingYa] contextBridge.exposeInMainWorld 失败:', err);
}

// 无论 contextBridge 是否成功，都直接挂载到 window 作为备选
window.electronAPI = electronAPI;
