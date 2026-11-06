/**
 * 暴露给渲染进程的 API（contextBridge + window 兜底）
 * 由原 preload.js 拆分而来，行为保持不变。
 */
const { contextBridge, ipcRenderer } = require('electron');

// ========== localStorage 键名混淆（封号风险改造 2026-11-01）==========
// 背景：LingYa 在 AI 页面（如 chat.deepseek.com）的 localStorage 里存了 30 个
// 'lingya-*' 配置键（theme / global-send-delay-min / 等）。DeepSeek 前端一行
//   Object.keys(localStorage).filter(k => k.startsWith('lingya'))
// 就能发现工具身份，比 DOM 痕迹更直接（localStorage 无隔离世界概念，主世界可读）。
//
// 方案：劫持隔离世界的 localStorage API，自动把 'lingya-' 前缀映射为
// 中性前缀 'webapp-'。同时启动时一次性迁移旧键 → 新键 → 删旧键。
//
// 为什么用固定前缀 'webapp-' 而非动态后缀：
//   1) 配置必须跨 preload 生命周期稳定（动态后缀会导致下次启动读不到上次配置）
//   2) 'webapp-' 是中性名字，不暴露 LingYa 身份
//   3) 与 DeepSeek 自己的 key 不冲突（DeepSeek 用 'oai/...' 或纯英文）
//
// 壳窗口（file:// origin）localStorage 独立，DeepSeek 无法访问，无需处理。
(() => {
  const LEGACY = 'lingya-';
  const NEUTRAL = 'webapp-';
  const mapKey = (k) => (typeof k === 'string' && k.indexOf(LEGACY) === 0)
    ? NEUTRAL + k.slice(LEGACY.length)
    : k;

  // 一次性迁移：把所有 'lingya-*' 键复制到新键后删除旧键。
  // 幂等：无旧键时什么都不做。失败静默（隐私模式等）。
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (typeof k === 'string' && k.indexOf(LEGACY) === 0) stale.push(k);
    }
    for (const oldKey of stale) {
      const newKey = mapKey(oldKey);
      // 新键已存在时以新键为准（说明之前迁移过），不覆盖
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(oldKey);
        if (v !== null) localStorage.setItem(newKey, v);
      }
      localStorage.removeItem(oldKey);
    }
    if (stale.length) console.log('[LingYa] localStorage 键名迁移完成: ' + stale.length + ' 个');
  } catch (_) { /* 隐私模式/禁用存储 */ }

  // 劫持 getItem / setItem / removeItem。只改 'lingya-*' 键，其他键（含 DeepSeek 自己的）原样透传。
  const LS = window.localStorage;
  if (!LS) return; // 测试桩 / 禁用存储环境无 localStorage，跳过劫持
  const origGet = LS.getItem.bind(LS);
  const origSet = LS.setItem.bind(LS);
  const origRemove = LS.removeItem.bind(LS);
  LS.getItem = function (k) { return origGet(mapKey(k)); };
  LS.setItem = function (k, v) { return origSet(mapKey(k), v); };
  LS.removeItem = function (k) { return origRemove(mapKey(k)); };
})();

// ========== 暴露给渲染进程的 API ==========
// 尝试 contextBridge，如果失败则直接挂载到 window（作为 fallback）
let electronAPI = {
  executeCommand: (command, id) => {
    return ipcRenderer.invoke('execute-command', { command, id });
  },
  initProject: (projectDir, isCompaction) => {
    // 【对齐 Cuckoo 2026-11-01】移除自动重命名调用。
    // 原实现：初始化项目后自动触发 AI 重命名（调 DeepSeek 侧栏重命名 API），
    // 这是自动化脚本操作服务的强特征，违反用户协议第 3.2 条。
    // Cuckoo 的行为：只有用户手动点「AI 重命名」按钮才触发。
    // 用户如需自动，可在「设置」面板手动开启（已通过 lingya-auto-rename-enabled 控制）。
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
  // 抢占上一轮前台工具执行（新工具调用到来时），后台任务不受影响
  preemptExecution: (payload) => {
    return ipcRenderer.invoke('preempt-execution', payload || {});
  },
  // 内存诊断 / 手动回收
  memoryStatus: () => ipcRenderer.invoke('memory-status'),
  memoryCollect: () => ipcRenderer.invoke('memory-collect'),
  // 2026-11-02：脱敏规则（preload 侧脱敏引擎用）
  getRedactionRules: (scope) => ipcRenderer.invoke('get-redaction-rules', scope || null),
  redactionRulesList: () => ipcRenderer.invoke('redaction-rules-list'),
  redactionRulesAdd: (rule) => ipcRenderer.invoke('redaction-rules-add', rule),
  redactionRulesQuickAdd: (word) => ipcRenderer.invoke('redaction-rules-quick-add', { word }),
  redactionQuickConfigGet: () => ipcRenderer.invoke('redaction-quick-config-get'),
  redactionQuickConfigUpdate: (patch) => ipcRenderer.invoke('redaction-quick-config-update', patch),
  redactionRulesUpdate: (name, patch) => ipcRenderer.invoke('redaction-rules-update', { name, patch }),
  redactionRulesDelete: (name) => ipcRenderer.invoke('redaction-rules-delete', { name }),
  // 2026-11-05: 批量删除 / 删除全部
  redactionRulesDeleteBatch: (names) => ipcRenderer.invoke('redaction-rules-delete-batch', { names }),
  redactionRulesDeleteAll: () => ipcRenderer.invoke('redaction-rules-delete-all'),
  // 导出/导入完整规则表（换机/重装后不丢）
  redactionRulesExport: () => ipcRenderer.invoke('redaction-rules-export'),
  redactionRulesImport: () => ipcRenderer.invoke('redaction-rules-import'),
  onRedactionRulesChanged: (cb) => { const h=()=>cb(); ipcRenderer.on('redaction-rules-changed',h); return ()=>ipcRenderer.removeListener('redaction-rules-changed',h); },
  toolLifecycleStats: () => ipcRenderer.invoke('tool-lifecycle-stats'),
  toolLifecycleSweep: (sessionKey) => ipcRenderer.invoke('tool-lifecycle-sweep', { sessionKey }),
  clearAbort: () => {
    return ipcRenderer.invoke('clear-abort');
  },
  listSessions: () => {
    return ipcRenderer.invoke('list-sessions');
  },
  newChat: () => {
    return ipcRenderer.invoke('shell-new-chat'); // 复用主进程已有的通道
  },
  navigateSession: (sessionId) => {
    return ipcRenderer.invoke('navigate-session', { sessionId });
  },
  setSessionTitle: (title, sessionId) => {
    return ipcRenderer.invoke('set-session-title', sessionId ? { title, sessionId } : { title });
  },
  setSessionArchived: (sessionId, archived) => {
    return ipcRenderer.invoke('set-session-archived', { sessionId, archived: !!archived });
  },
  // 会话本地存档（jsonl 追加存储）
  conversationArchiveAppend: (sessionId, entry) => {
    return ipcRenderer.invoke('conversation-archive-append', { sessionId, entry });
  },
  conversationArchiveRead: (sessionId) => {
    return ipcRenderer.invoke('conversation-archive-read', { sessionId });
  },
  conversationArchiveHas: (sessionId) => {
    return ipcRenderer.invoke('conversation-archive-has', { sessionId });
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
  // 导出对话为 Markdown（渲染进程生成内容，主进程弹保存框写盘）
  conversationExportMd: (markdown, suggestedName) => {
    return ipcRenderer.invoke('conversation-export-md', { markdown, suggestedName });
  },
  // ========== Skill 系统 API ==========
  // ========== Trusted input API ==========
  trustedClick: (x, y) => {
    return ipcRenderer.invoke('trusted-click', { x: x, y: y });
  },
  trustedInsertText: (text) => {
    return ipcRenderer.invoke('trusted-insert-text', { text: text });
  },
  trustedKey: (key) => {
    return ipcRenderer.invoke('trusted-key', { key: key });
  },
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
  // 侧栏开合联动窗口宽度
  sidebarResizeWindow: (open, width) => {
    return ipcRenderer.invoke('sidebar-resize-window', { open, width });
  },
  // 文件树浏览（只读）
  getFileTree: (options) => {
    return ipcRenderer.invoke('get-file-tree', options || {});
  },
  readFilePreview: (filePath) => {
    return ipcRenderer.invoke('read-file-preview', { filePath });
  },
  getTodos: () => {
    return ipcRenderer.invoke('get-todos');
  },
  onTodosUpdated: (cb) => {
    const handler = (_e, todos) => cb(todos);
    ipcRenderer.on('lingya-todos-updated', handler);
    return () => ipcRenderer.removeListener('lingya-todos-updated', handler);
  },
  // ===== 用户手动待办（与 AI 计划完全独立）=====
  userTodosList: () => {
    return ipcRenderer.invoke('user-todos-list');
  },
  userTodosAdd: (text) => {
    return ipcRenderer.invoke('user-todos-add', { text });
  },
  userTodosUpdate: (id, patch) => {
    return ipcRenderer.invoke('user-todos-update', { id, patch });
  },
  userTodosDelete: (id) => {
    return ipcRenderer.invoke('user-todos-delete', { id });
  },
  onUserTodosUpdated: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('lingya-user-todos-updated', handler);
    return () => ipcRenderer.removeListener('lingya-user-todos-updated', handler);
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
  // ========== 插件系统 API ==========
  // 通用插件 IPC 调用：供插件 preload 脚本回调宿主
  pluginInvoke: (pluginId, channel, args) => {
    return ipcRenderer.invoke('plugin-invoke', { pluginId, channel, args });
  },
  getPluginPreloads: () => ipcRenderer.invoke('plugin-preloads'),
  onPluginsChanged: (cb) => { const h=()=>cb(); ipcRenderer.on('lingya-tools-changed',h); return ()=>ipcRenderer.removeListener('lingya-tools-changed',h); },
  onSessionTitleUpdated: (cb) => { const h=(_e,p)=>cb(p); ipcRenderer.on('session-title-updated',h); return ()=>ipcRenderer.removeListener('session-title-updated',h); },
  // AI 生成「建议标题」（不自动改会话名，由用户手动应用）→ 覆盖层弹 Toast
  onSessionTitleSuggested: (cb) => { const h=(_e,p)=>cb(p||{}); ipcRenderer.on('session-title-suggested',h); return ()=>ipcRenderer.removeListener('session-title-suggested',h); },
  onSessionArchivedUpdated: (cb) => { const h=(_e,p)=>cb(p); ipcRenderer.on('session-archived-updated',h); return ()=>ipcRenderer.removeListener('session-archived-updated',h); },
  // 手动触发拒绝改写（侧边栏「立即改写」按钮 → 主进程转发 → AI 视图执行）
  onManualRewrite: (cb) => { const h=(_e,p)=>cb(p||{}); ipcRenderer.on('lingya-manual-rewrite',h); return ()=>ipcRenderer.removeListener('lingya-manual-rewrite',h); },
  // I1：AI 视图执行完手动改写后，把结果回传给主进程（供侧边栏等待）
  sendManualRewriteResult: (requestId, result) => ipcRenderer.send('security-manual-rewrite-result', { requestId, result }),
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
  // ========== 微信 iLink 通道 API ==========
  getWeixinEnabled: () => {
    return ipcRenderer.invoke('weixin-is-enabled');
  },
  getWeixinConfig: () => {
    return ipcRenderer.invoke('weixin-get-config');
  },
  saveWeixinConfig: (data) => {
    return ipcRenderer.invoke('weixin-save-config', { data });
  },
  getWeixinQrcode: () => {
    return ipcRenderer.invoke('weixin-get-qrcode');
  },
  checkWeixinQrcode: (qrcode) => {
    return ipcRenderer.invoke('weixin-check-qrcode', { qrcode });
  },
  reconnectWeixin: () => {
    return ipcRenderer.invoke('weixin-reconnect');
  },
  disconnectWeixin: () => {
    return ipcRenderer.invoke('weixin-disconnect');
  },
  logoutWeixin: () => {
    return ipcRenderer.invoke('weixin-logout');
  },
  weixinReport: (payload) => {
    return ipcRenderer.invoke('weixin-report', payload);
  },
  // ========== QQ 通道 API ==========
  // 【2026-11-01 修复】轻量启用状态查询。
  // qq-get-config 在 ipc-guard 的敏感白名单里，AI 页面（http 来源）调用会被拒，
  // 导致 bridge 拿不到 enabled → AI 回复不上报 → 不回传 QQ。这个通道只返回布尔值，不敏感。
  getQqEnabled: () => {
    return ipcRenderer.invoke('qq-is-enabled');
  },
  getQqConfig: () => {
    return ipcRenderer.invoke('qq-get-config');
  },
  saveQqConfig: (data) => {
    return ipcRenderer.invoke('qq-save-config', { data });
  },
  reconnectQq: () => {
    return ipcRenderer.invoke('qq-reconnect');
  },
  disconnectQq: () => {
    return ipcRenderer.invoke('qq-disconnect');
  },
  qqReport: (payload) => {
    return ipcRenderer.invoke('qq-report', payload);
  },
  // ========== 通道窗口绑定 API ==========
  getWeixinBinding: () => ipcRenderer.invoke('weixin-get-binding'),
  bindWeixinUser: (userId, userName) => ipcRenderer.invoke('weixin-bind-user', { userId, userName }),
  listWeixinRecentUsers: () => ipcRenderer.invoke('weixin-list-recent-users'),
  getQqBinding: () => ipcRenderer.invoke('qq-get-binding'),
  bindQqOpenId: (openId, openName) => ipcRenderer.invoke('qq-bind-openid', { openId, openName }),
  listQqRecentUsers: () => ipcRenderer.invoke('qq-list-recent-users'),
  // ========== 媒体收件箱 API ==========
  getMediaConfig: () => ipcRenderer.invoke('media-get-config'),
  saveMediaConfig: (data) => ipcRenderer.invoke('media-save-config', { data }),
  pickMediaDir: () => ipcRenderer.invoke('media-pick-dir'),
  openMediaDir: () => ipcRenderer.invoke('media-open-dir'),
  // 任务状态上报（AI 视图 → 主进程 → 壳窗口侧边栏）
  // 侧边栏和 AI 视图是两个独立 webContents，状态真相源在 AI 视图侧，
  // 必须显式上报才能让侧边栏也看到「进行中」。
  reportTaskState: (payload) => ipcRenderer.send('lingya-report-task-state', payload),
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
  onWeixinMode: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('weixin-mode', handler);
    return () => ipcRenderer.removeListener('weixin-mode', handler);
  },
  onWeixinUserMessage: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('weixin-user-message', handler);
    return () => ipcRenderer.removeListener('weixin-user-message', handler);
  },
  onQqMode: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('qq-mode', handler);
    return () => ipcRenderer.removeListener('qq-mode', handler);
  },
  onQqUserMessage: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('qq-user-message', handler);
    return () => ipcRenderer.removeListener('qq-user-message', handler);
  },
  onFeishuStop: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('feishu-stop', handler);
    return () => ipcRenderer.removeListener('feishu-stop', handler);
  },
  // QQ/微信 共用的 /stop 通道（channel-commands.js 发出 lingya-stop-task）
  onStopTask: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('lingya-stop-task', handler);
    return () => ipcRenderer.removeListener('lingya-stop-task', handler);
  },
  // ========== 跨窗口 Token 轮转 API ==========
  // 主进程只做「选目标 + 中继 + 超时」，数据与删会话都由窗口侧负责。
  // 【对齐 Cuckoo 2026-11-01】状态栏数据推送
  updateTps: (text) => ipcRenderer.invoke('update-tps', { text }),
  updateTokenUsage: (context, cumulative, windowCumulative, todayCumulative, daily) =>
    ipcRenderer.invoke('update-token-usage', { context, cumulative, windowCumulative, todayCumulative, daily }),
  rotationGetConfig: () => ipcRenderer.invoke('rotation-get-config'),
  rotationSetConfig: (patch) => ipcRenderer.invoke('rotation-set-config', { patch: patch || {} }),
  rotationListCandidates: () => ipcRenderer.invoke('rotation-list-candidates'),
  rotationSubmit: (data) => ipcRenderer.invoke('rotation-submit', { data: data || {} }),
  rotationAck: (payload) => {
    const p = payload || {};
    return ipcRenderer.invoke('rotation-ack', {
      requestId: p.requestId,
      ok: p.ok === true,
      error: p.error,
    });
  },
  rotationReset: () => ipcRenderer.invoke('rotation-reset'),
  /**
   * 监听主进程回告的轮转结果（仅源窗口关心）。
   * @param {(result:{ok:boolean, requestId:string, targetProfileId?:string, reason?:string, error?:string})=>void} cb
   * @returns {() => void} 取消订阅
   */
  onRotationResult: (cb) => {
    const handler = (_e, payload) => {
      try { cb(payload || {}); } catch (err) { console.error('[LingYa] onRotationResult 回调异常:', err); }
    };
    ipcRenderer.on('lingya-rotation-result', handler);
    return () => ipcRenderer.removeListener('lingya-rotation-result', handler);
  },
  /**
   * 监听主进程派发的迁移包（目标窗口）。收到后写入 localStorage，
   * 由既有 auto-inject 状态机接手承接流程。
   * @param {(data:object)=>void} cb
   * @returns {() => void} 取消订阅
   */
  onReceivedMigration: (cb) => {
    const handler = (_e, payload) => {
      try { cb(payload || {}); } catch (err) { console.error('[LingYa] onReceivedMigration 回调异常:', err); }
    };
    ipcRenderer.on('lingya-received-migration', handler);
    return () => ipcRenderer.removeListener('lingya-received-migration', handler);
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
  scheduleFetchPending: () => ipcRenderer.invoke('schedule-fetch-pending'),
  scheduleReportDone: (payload) => ipcRenderer.invoke('schedule-report-done', payload),
  onScheduleRun: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('schedule-run', handler);
    return () => ipcRenderer.removeListener('schedule-run', handler);
  },  // ========== Phone Remote API ==========
  remoteStatus: () => ipcRenderer.invoke('remote-status'),
  remoteSetEnabled: (enabled) => ipcRenderer.invoke('remote-set-enabled', !!enabled),
  remoteSetConfig: (patch) => ipcRenderer.invoke('remote-set-config', patch || {}),
  remoteResetToken: () => ipcRenderer.invoke('remote-reset-token'),
  remoteStartTunnel: () => ipcRenderer.invoke('remote-start-tunnel'),
  remoteStopTunnel: () => ipcRenderer.invoke('remote-stop-tunnel'),
  remoteListClients: () => ipcRenderer.invoke('remote-list-clients'),
  remoteKickAll: () => ipcRenderer.invoke('remote-kick-all'),

};

// 【安全隔离】contextBridge 暴露到主世界（页面可见）的 API 需要过滤掉高危方法。
// 威胁模型：DeepSeek 页面若被 XSS（第三方富文本/广告注入），攻击者可直接
//   await window.electronAPI.executeCommand('任意命令')
//   await window.electronAPI.executeJs('任意代码')
//   await window.electronAPI.executeTool('bash', {...})
// 这三个方法是任意代码执行入口，绝不能镜像到主世界。
//
// 为什么可以安全过滤：
//   - 162 处 window.electronAPI.xxx 调用全部在 src/preload/ 内部（isolated world），
//     读的是下方 window.electronAPI 完整对象，不受此处过滤影响
//   - 插件 preload 脚本经 new Function() 在 isolated world 执行，同样读 413 行
//   - 注入主世界的插件脚本均不引用 electronAPI（grep 证实）
//   - 主世界侧无任何已知合法消费者
const MAIN_WORLD_BLOCKED = ['executeCommand', 'executeJs', 'executeTool'];

// 【修复 2026-11-01】mainWorldAPI 必须在 try 块外声明，否则块外访问会 ReferenceError
const mainWorldAPI = {};
for (const k of Object.keys(electronAPI)) {
  if (MAIN_WORLD_BLOCKED.indexOf(k) === -1) mainWorldAPI[k] = electronAPI[k];
}
try {
  contextBridge.exposeInMainWorld('electronAPI', mainWorldAPI);
} catch (err) {
  console.error('[LingYa] contextBridge.exposeInMainWorld 失败:', err);
}

// 【封号风险改造 2026-11-01 · 修正】关键区分两个世界：
//   1. contextBridge.exposeInMainWorld('electronAPI', mainWorldAPI) —— 注入【主世界】，
//      页面脚本 window.electronAPI 读到的是白名单版（无 executeCommand/executeJs/executeTool）✅ 安全
//   2. 本行 window.electronAPI = electronAPI —— 赋值给【隔离世界的 window】，
//      preload 内部（tool-executor.js 等）通过 window.electronAPI.executeJs/executeTool 调用。
//      **隔离世界对页面不可见**（contextIsolation:true），完整对象安全。
// 【上轮改造的错误】曾把本行改成 mainWorldAPI，导致 tool-executor 拿不到 executeJs，
// 工具执行全部失败（window.electronAPI.executeJs is not a function）。现已还原。
window.electronAPI = electronAPI;

// 【安全清理】0.6.30 之前的版本把含 Bearer token 的完整请求头明文写进
// localStorage['lingya-ds-headers']（页面任意脚本可读走 token）。
// 现版本已改为仅主世界内存 + CustomEvent 传递，不再落存储。
// 但老用户 profile 里仍残留该键，每次 preload 启动清一次。
// 注：localStorage 劫持会把 'lingya-' 前缀映射为 'webapp-'，所以这里
// removeItem('lingya-ds-headers') 实际删除的是 'webapp-ds-headers'。
// 启动迁移逻辑已把 lingya-ds-headers 迁成 webapp-ds-headers（如果值不为 null），
// 此 removeItem 就是兜底清理那个迁移出来的 webapp 键。
try { localStorage.removeItem('lingya-ds-headers'); } catch (_) { /* 隐私模式/禁用存储 */ }
