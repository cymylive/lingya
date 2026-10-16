/**
 * 壳页面 preload：左侧栏独立视图的桥接
 * 暴露 shellAPI 给壳页面（shell.html），与主进程通信。
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 侧栏开合：主进程负责窗口加宽 + AI view 重排
  // open=true 时 width 为展开宽度；open=false 时收起
  toggleSidebar: (open, width) => ipcRenderer.invoke('shell-sidebar-toggle', { open, width }),
  // 拖拽中实时调宽（不改窗口宽，只重排 AI view）
  resizeSidebar: (width) => ipcRenderer.invoke('shell-sidebar-resize', { width }),
  // 拖拽开始/结束：拖拽期间把 AI view 移出，避免鼠标事件被 AI 网页抢走
  startSidebarDrag: () => ipcRenderer.invoke('shell-sidebar-drag', { phase: 'start' }),
  endSidebarDrag: () => ipcRenderer.invoke('shell-sidebar-drag', { phase: 'end' }),
  // 读文件树（复用已有 IPC）
  getFileTree: (options) => ipcRenderer.invoke('get-file-tree', options || {}),
  readFilePreview: (filePath) => ipcRenderer.invoke('read-file-preview', { filePath }),
  // 选择项目目录（弹系统目录选择框，只更新目录）
  chooseDir: () => ipcRenderer.invoke('shell-choose-dir'),
  // 读当前项目目录
  getDir: () => ipcRenderer.invoke('shell-get-dir'),
  // 删除文件（主进程弹确认框 + 越权防护；默认移到回收站）
  deleteFile: (filePath, useTrash = true) => ipcRenderer.invoke('shell-delete-file', { filePath, useTrash }),
  // 复制文本到剪贴板
  copyText: (text) => ipcRenderer.invoke('shell-copy-text', { text }),
  // 文件操作
  createFile: (parentDir, name) => ipcRenderer.invoke('shell-create-file', { parentDir, name }),
  createDir: (parentDir, name) => ipcRenderer.invoke('shell-create-dir', { parentDir, name }),
  rename: (targetPath, newName) => ipcRenderer.invoke('shell-rename', { targetPath, newName }),
  writeFile: (filePath, content) => ipcRenderer.invoke('shell-write-file', { filePath, content }),
  // ===== 功能面板 API（v0.6.36 迁移自覆盖层）=====
  // 跨上下文：插入文本到聊天输入框 / 新会话
  insertToChat: (text, tag, delay) => ipcRenderer.invoke('shell-insert-to-chat', { text, tag, delay }),
  newChat: () => ipcRenderer.invoke('shell-new-chat'),
  runAction: (action) => ipcRenderer.invoke('shell-run-action', { action }),
  setSetting: (key, value) => ipcRenderer.invoke('shell-set-setting', { key, value }),
  // 计划 / Todo
  getTodos: () => ipcRenderer.invoke('get-todos'),
  onTodosUpdated: (cb) => { const h=(_e,t)=>cb(t); ipcRenderer.on('lingya-todos-updated',h); return ()=>ipcRenderer.removeListener('lingya-todos-updated',h); },
  onSessionChanged: (cb) => { const h=(_e,p)=>cb(p); ipcRenderer.on('lingya-session-changed',h); return ()=>ipcRenderer.removeListener('lingya-session-changed',h); },
  onHistoryUpdated: (cb) => { const h=(_e,p)=>cb(p); ipcRenderer.on('lingya-history-updated',h); return ()=>ipcRenderer.removeListener('lingya-history-updated',h); },
  // 记忆
  listMemories: () => ipcRenderer.invoke('memory-list'),
  saveMemory: (memory) => ipcRenderer.invoke('memory-save', { memory }),
  updateMemory: (memory) => ipcRenderer.invoke('memory-update', { memory }),
  deleteMemory: (id) => ipcRenderer.invoke('memory-delete', { id }),
  importMemories: () => ipcRenderer.invoke('memory-import'),
  exportMemories: () => ipcRenderer.invoke('memory-export'),
  // 技能
  listSkills: () => ipcRenderer.invoke('skill-list'),
  saveSkill: (skill) => ipcRenderer.invoke('skill-save', { skill }),
  deleteSkill: (name) => ipcRenderer.invoke('skill-delete', { name }),
  setSkillEnabled: (name, enabled) => ipcRenderer.invoke('skill-set-enabled', { name, enabled }),
  importSkillFolder: () => ipcRenderer.invoke('skill-import-folder'),
  // 安全
  getSecurityConfig: () => ipcRenderer.invoke('security-get-config').then(r => (r && r.success ? r.config : null)),
  updateSecurityConfig: (config) => ipcRenderer.invoke('security-update-config', { config }),
  resetSecurityConfig: () => ipcRenderer.invoke('security-reset-config'),
  getCtfPrompt: () => ipcRenderer.invoke('security-get-ctf-prompt'),
  // 定时任务
  listSchedules: () => ipcRenderer.invoke('schedule-list'),
  addSchedule: (task) => ipcRenderer.invoke('schedule-add', task),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule-update', { id, patch }),
  runScheduleNow: (id) => ipcRenderer.invoke('schedule-run-now', { id }),
  listScheduleWindows: () => ipcRenderer.invoke('schedule-list-windows'),
  deleteSchedule: (id) => ipcRenderer.invoke('schedule-delete', { id }),
  validateScheduleCron: (cron) => ipcRenderer.invoke('schedule-validate', { cron }),
  // 飞书
  getFeishuConfig: () => ipcRenderer.invoke('feishu-get-config'),
  saveFeishuConfig: (data) => ipcRenderer.invoke('feishu-save-config', { data }),
  getFeishuBinding: () => ipcRenderer.invoke('feishu-get-binding'),
  listFeishuChats: () => ipcRenderer.invoke('feishu-list-chats'),
  bindFeishuChat: (chatId, chatName) => ipcRenderer.invoke('feishu-bind-chat', { chatId, chatName }),
  feishuReconnect: () => ipcRenderer.invoke('feishu-reconnect'),
  feishuDisconnect: () => ipcRenderer.invoke('feishu-disconnect'),
  // MCP
  listMcpServers: () => ipcRenderer.invoke('list-mcp-servers'),
  upsertMcpServer: (server) => ipcRenderer.invoke('upsert-mcp-server', { server }),
  removeMcpServer: (name) => ipcRenderer.invoke('remove-mcp-server', { name }),
  enableMcpServer: (name) => ipcRenderer.invoke('enable-mcp-server', { name }),
  disableMcpServer: (name) => ipcRenderer.invoke('disable-mcp-server', { name }),
  getMcpTools: () => ipcRenderer.invoke('get-mcp-tools'),
  deleteProfileWindow: (profileId) => ipcRenderer.invoke('delete-profile', { profileId }),
  updateWindowName: (displayName) => ipcRenderer.invoke('update-window-name', { displayName }),
  // 会话 / 窗口 / Agent / 项目
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  navigateSession: (sessionId) => ipcRenderer.invoke('navigate-session', { sessionId }),
  setSessionTitle: (title) => ipcRenderer.invoke('set-session-title', { title }),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  openProfileWindow: (profileId) => ipcRenderer.invoke('open-profile-window', { profileId }),
  createProfileWindow: () => ipcRenderer.invoke('create-profile-window'),
  getCurrentAgent: () => ipcRenderer.invoke('agent-current'),
  listAgents: () => ipcRenderer.invoke('agent-list'),
  setAgent: (agentId) => ipcRenderer.invoke('agent-set', { agentId }),
  initProject: () => ipcRenderer.invoke('init-project', { skipPrompt: true }),
  getSecurityCtfPrompt: () => ipcRenderer.invoke('security-get-ctf-prompt'),
  // ===== 插件系统 =====
  pluginList: () => ipcRenderer.invoke('plugin-list'),
  pluginSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin-set-enabled', { id, enabled }),
  pluginReload: (id) => ipcRenderer.invoke('plugin-reload', { id }),
  pluginOpenDir: () => ipcRenderer.invoke('plugin-open-dir'),
  pluginImport: () => ipcRenderer.invoke('plugin-import'),
  pluginExport: (id) => ipcRenderer.invoke('plugin-export', { id }),
  pluginDelete: (id) => ipcRenderer.invoke('plugin-delete', { id }),
  pluginViews: () => ipcRenderer.invoke('plugin-views'),
  pluginInvoke: (pluginId, channel, args) => ipcRenderer.invoke('plugin-invoke', { pluginId, channel, args }),
  // DSH 兼容层（外部 npm 插件）
  dshList: () => ipcRenderer.invoke('dsh-list'),
  dshInstall: (spec) => ipcRenderer.invoke('dsh-install', { spec }),
  dshUninstall: (id) => ipcRenderer.invoke('dsh-uninstall', { id }),
  dshSetEnabled: (id, enabled) => ipcRenderer.invoke('dsh-set-enabled', { id, enabled }),
  dshReload: (id) => ipcRenderer.invoke('dsh-reload', { id }),
  dshOpenDir: () => ipcRenderer.invoke('dsh-open-dir'),
  dshMarket: (force) => ipcRenderer.invoke('dsh-market', { force: !!force }),
  onPluginsChanged: (cb) => { const h=()=>cb(); ipcRenderer.on('lingya-tools-changed',h); return ()=>ipcRenderer.removeListener('lingya-tools-changed',h); },
  onSessionTitleUpdated: (cb) => { const h=(_e,p)=>cb(p); ipcRenderer.on('session-title-updated',h); return ()=>ipcRenderer.removeListener('session-title-updated',h); },
};

try {
  contextBridge.exposeInMainWorld('shellAPI', api);
} catch (_) {
  window.shellAPI = api;
}

console.log('[LingYa Shell] preload 就绪');
