/**
 * IPC 处理器注册（渲染进程 → 主进程）
 * 多窗口版：按 event.sender 路由到对应窗口的 profile 上下文。
 */
const { app, dialog, ipcMain, Notification } = require('electron');
const { exec } = require('child_process');

const windowState = require('./window');
const profileManager = require('./profile-manager');
const { toolRegistry, jsRunner } = require('./tool-registry');
const { initProject } = require('./project-context');
const { isDangerous } = require('./dangerous-commands');
const memoryStore = require('./memory-store');
const skillStore = require('./skill-store');
const securityStore = require('./security-store');
const agentStore = require('./agent-store');
const { getAgent, listAgents } = require('./agents');
const { decodeOutput, normalizeCommand } = require('../../tools/decodeOutput');
const activeProcesses = require('../../tools/active-processes');
const { registerFeishuIpc } = require('./feishu-ipc');
const { registerWeixinIpc } = require('./weixin-ipc');
const { registerMediaIpc } = require('./media-ipc');
const { registerQqIpc } = require('./qq-ipc');
const { todoEvents, getTodos, clearTodos } = require('../../tools/TodoWriteTool');
const userTodoStore = require('../../tools/UserTodoStore');
const { checkGate } = require('../../tools/plan-gate');
const memoryJanitor = require('../../tools/memory-janitor');
const toolLifecycle = require('../../tools/tool-lifecycle');
const activityTrackerRef = require('./activity-tracker');

// 【2026-10-30】工具开始/结束时立刻广播「总控台数据已变化」。
// 此前只有 todo 变化和 AI 生成状态变化会广播，「正在执行：glob」这类
// 工具活动变化只能靠前端 3 秒轮询才反映，看起来不实时。
// 广播函数在 window.js，内部带 100ms 节流，高频工具调用不会拖垮侧边栏。
activityTrackerRef.setOnChange(() => {
  try { windowState.broadcastAllTodosChanged(); } catch (_) { /* 广播失败不影响工具执行 */ }
});

/** 解析当前会话 ID：优先实时从窗口 URL 提取，fallback 到 handleUrlChange 维护的值。
 *  execute 与 read 共用此函数，避免"新建会话时 sessionId 从 null 变为真实值"导致 key 漂移。 */
function resolveSessionId(ctx, sender) {
  if (!ctx || !ctx.sessionStore) return null;
  // 会话 ID 来自 AI 网页 URL。侧边栏（壳窗口）调用时 sender 是 shell.html，
  // 解析不出 sessionId —— 故始终优先用 AI 视图的 URL。
  let target = sender;
  try {
    if (ctx.view && ctx.view.webContents && !ctx.view.webContents.isDestroyed()) {
      target = ctx.view.webContents;
    } else if (ctx.win && ctx.win.webContents && !ctx.win.webContents.isDestroyed()) {
      target = ctx.win.webContents;
    }
  } catch (_) {}
  try {
    const url = target && typeof target.getURL === 'function' ? target.getURL() : null;
    const fromUrl = url ? ctx.sessionStore.extractSessionIdFromUrl(url) : null;
    if (fromUrl) return fromUrl;
  } catch (_) {}
  return ctx.sessionStore.state.currentSessionId || null;
}

/**
 * 诊断辅助：init-project 拿不到窗口上下文时，打印 sender 信息和所有可用窗口，
 * 便于排查「B 窗口点初始化却查不到 ctx」这类问题。
 */
function logCtxLookupFailure(sender) {
  try {
    const sid = sender && sender.id;
    let url = '';
    try { url = sender.getURL ? sender.getURL() : ''; } catch (_) {}
    const ctxs = windowState.getAllContexts().map(c => {
      const rawId = c.rawWin && c.rawWin.webContents ? c.rawWin.webContents.id : null;
      const viewId = c.view && c.view.webContents ? c.view.webContents.id : null;
      const tabIds = c.tabs ? Array.from(c.tabs.values()).map(t => t.view && t.view.webContents ? t.view.webContents.id : null) : [];
      return c.profileId + '(raw=' + rawId + ',view=' + viewId + ',tabs=' + JSON.stringify(tabIds) + ')';
    });
    console.error('[LingYa] init-project 找不到 ctx: sender.id=' + sid + ' url=' + url);
    console.error('[LingYa] 可用窗口: ' + (ctxs.join(' | ') || '(无)'));
  } catch (e) {
    console.error('[LingYa] logCtxLookupFailure 自身失败:', e.message);
  }
}

// 初始化项目
function registerIpcHandlers() {
  // 飞书同步 IPC
  registerFeishuIpc();

  // 微信 iLink 通道 IPC
  registerWeixinIpc();

  // 媒体收件箱配置 IPC
  registerMediaIpc();

  // QQ 通道 IPC
  registerQqIpc();

  // 待办列表变更：广播给所有窗口（带 sessionId，前端按当前会话过滤，避免跨会话串扰）
  todoEvents.on('change', ({ sessionId, todos, archived }) => {
    for (const ctx of windowState.getAllContexts()) {
      const payload = { sessionId: sessionId || null, todos, archived: !!archived };
      // AI 视图（ctx.win 的 Proxy 已重定向到 view）——覆盖层订阅方
      try {
        const wc = ctx.win && ctx.win.webContents;
        if (wc && !wc.isDestroyed()) wc.send('lingya-todos-updated', payload);
      } catch (_) {}
      // 壳窗口（侧边栏）——真实 BrowserWindow 的 webContents
      try {
        const raw = ctx.rawWin;
        if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('lingya-todos-updated', payload);
      } catch (_) {}
    }
    // 通知所有壳窗口「总控台数据已变化」，前端据此立即重绘
    try {
      for (const c of windowState.getAllContexts()) {
        const raw2 = c.rawWin;
        if (raw2 && !raw2.isDestroyed() && raw2.webContents) {
          raw2.webContents.send('lingya-all-todos-changed');
        }
      }
    } catch (_) {}
  });

  // 读取当前窗口/会话的待办列表（严格按会话隔离，返回 archived 标记）
  ipcMain.handle('get-todos', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    const r = getTodos(sessionId, profileId);
    return { success: true, todos: r.todos, archived: r.archived, sessionId };
  });

  // ===== 跨窗口任务总控台：汇总所有窗口的 todo + 活动状态 =====
  ipcMain.handle('get-all-todos', async () => {
    const { deriveStatus, summarizeTodos } = require('./task-status');
    const activityTracker = require('./activity-tracker');
    const generationState = require('./generation-state');
    const now = Date.now();
    generationState.prune(now);   // 清掉已关闭视图的残记录
    const out = [];

    for (const ctx of windowState.getAllContexts()) {
      // 窗口名 / 平台
      let name = ctx.profileId || '窗口';
      let provider = ctx.providerId || '';
      let profileNumber = null;
      try {
        const pm = require('./profile-manager');
        const p = pm.getProfileById(ctx.profileId);
        if (p) { 
          name = p.name || name; 
          if (p.providerId) provider = p.providerId; 
          if (typeof p.number === 'number') profileNumber = p.number;
        }
      } catch (_) {}

      // 每个窗口可能有多个分屏面板，逐面板统计
      const panels = [];
      // 宿主面板
      const hostSession = resolveSessionId(ctx, ctx.rawWin ? ctx.rawWin.webContents : null);
      const hostKey = (ctx.profileId || 'p') + '::' + (hostSession || 's');
      const hostTodos = getTodos(hostSession, ctx.profileId);
      const hostWcId = ctx.view ? ctx.view.webContents.id : null;
      const hostGen = generationState.get(hostWcId, now);
      let hostSessionTitle = null;
      try { if (ctx.sessionStore) hostSessionTitle = ctx.sessionStore.getSessionTitleById(hostSession); } catch (_) {}
      panels.push({
        webContentsId: hostWcId,
        profileId: ctx.profileId,
        profileNumber: profileNumber,
        sessionId: hostSession,
        sessionTitle: hostSessionTitle,
        isHost: true,
        todos: hostTodos.todos,
        archived: hostTodos.archived,
        summary: summarizeTodos(hostTodos.todos),
        status: deriveStatus({
          todos: hostTodos.todos,
          activity: activityTracker.get(hostKey),
          generating: !!(hostGen && hostGen.generating),
          now,
        }),
        activity: activityTracker.get(hostKey),
        generating: hostGen,
      });

      // 附加面板
      const owners = [];
      for (const p of (ctx.attachedViews || [])) {
        if (!p.view || !p.view.webContents) continue;
        const oCtx = windowState.getContextByWebContents(p.view.webContents);
        if (oCtx) owners.push({ panel: p, ctx: oCtx });
      }
      for (const { panel, ctx: oCtx } of owners) {
        let oName = oCtx.profileId || '窗口';
        let oNumber = null;
        try {
          const pm = require('./profile-manager');
          const pr = pm.getProfileById(oCtx.profileId);
          if (pr) {
            if (pr.name) oName = pr.name;
            if (typeof pr.number === 'number') oNumber = pr.number;
          }
        } catch (_) {}
        let sid = null;
        try {
          const wc = panel.view.webContents;
          if (wc && !wc.isDestroyed() && oCtx.sessionStore) {
            sid = oCtx.sessionStore.extractSessionIdFromUrl(wc.getURL());
          }
        } catch (_) {}
        if (!sid) sid = resolveSessionId(oCtx, null);
        const key = (oCtx.profileId || 'p') + '::' + (sid || 's');
        const t = getTodos(sid, oCtx.profileId);
        const attWcId = panel.view.webContents.id;
        const attGen = generationState.get(attWcId, now);
        let attSessionTitle = null;
        try { if (oCtx.sessionStore && sid) attSessionTitle = oCtx.sessionStore.getSessionTitleById(sid); } catch (_) {}
        
        // 兜底：从网页本身的 <title> 取（修复误把含 DeepSeek 的标题过滤掉的问题）
        if (!attSessionTitle && panel.view && panel.view.webContents) {
          try {
            const wt = panel.view.webContents.getTitle();
            // 只要不是单纯的 'DeepSeek' 或 'LingYa'，就截取前缀
            if (wt && wt !== 'DeepSeek' && wt !== 'LingYa') {
              attSessionTitle = wt.replace(/\s*[-·]\s*DeepSeek.*$/i, '').trim();
            }
          } catch (_) {}
        }
        panels.push({
          webContentsId: attWcId,
          profileId: oCtx.profileId,
          profileName: oName,
          profileNumber: oNumber,
          sessionId: sid,
          sessionTitle: attSessionTitle,
          isHost: false,
          todos: t.todos,
          archived: t.archived,
          summary: summarizeTodos(t.todos),
          status: deriveStatus({
            todos: t.todos,
            activity: activityTracker.get(key),
            generating: !!(attGen && attGen.generating),
            now,
          }),
          activity: activityTracker.get(key),
          generating: attGen,
        });
      }

      out.push({ windowId: ctx.win && ctx.win.id, name, provider, panels });
    }

    return { success: true, windows: out, now };
  });

  // 清空当前会话待办（AI 明确说完成时 / 手动清）
  ipcMain.handle('clear-todos', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    clearTodos(sessionId, profileId);
    return { success: true };
  });

  // ========== 用户手动待办（与 AI 的 todoWrite 完全独立）==========
  // 存储：<userData>/lingya-user-todos.json，独立于 lingya-todos.json
  // 所有 handler 一律按 event.sender 定位窗口 —— 绝不能用 getMainContext()（最后激活窗口），
  // 那是多窗口串台的已知根因（openBrowserWindow 修过同类 bug）。

  /**
   * 广播用户待办变更：同时发给 AI 视图（覆盖层）与壳窗口（侧边栏）。
   * 带 sessionId，前端按当前会话过滤，避免跨会话串扰。
   */
  function broadcastUserTodos(sessionId, todos) {
    const payload = { sessionId: sessionId || null, todos };
    for (const ctx of windowState.getAllContexts()) {
      try {
        const wc = ctx.win && ctx.win.webContents;
        if (wc && !wc.isDestroyed()) wc.send('lingya-user-todos-updated', payload);
      } catch (_) {}
      try {
        const raw = ctx.rawWin;
        if (raw && !raw.isDestroyed() && raw.webContents) {
          raw.webContents.send('lingya-user-todos-updated', payload);
        }
      } catch (_) {}
    }
  }

  ipcMain.handle('user-todos-list', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    const todos = userTodoStore.list(sessionId, profileId);
    return { success: true, todos, sessionId };
  });

  ipcMain.handle('user-todos-add', async (event, { text } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    try {
      // 支持多行粘贴：parseBulk 在存储层，只有每行都带列表标记时才拆条
      const parts = userTodoStore.parseBulk(text);
      if (parts.length === 0) {
        return { success: false, error: '待办内容不能为空' };
      }
      const added = [];
      for (const p of parts) {
        added.push(userTodoStore.add(sessionId, profileId, p));
      }
      const todos = userTodoStore.list(sessionId, profileId);
      broadcastUserTodos(sessionId, todos);
      return { success: true, added, todos, sessionId };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('user-todos-update', async (event, { id, patch } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    try {
      const ok = userTodoStore.update(sessionId, profileId, String(id || ''), patch || {});
      if (!ok) return { success: false, error: '待办不存在' };
      const todos = userTodoStore.list(sessionId, profileId);
      broadcastUserTodos(sessionId, todos);
      return { success: true, todos };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('user-todos-delete', async (event, { id } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    try {
      const ok = userTodoStore.remove(sessionId, profileId, String(id || ''));
      if (!ok) return { success: false, error: '待办不存在' };
      const todos = userTodoStore.list(sessionId, profileId);
      broadcastUserTodos(sessionId, todos);
      return { success: true, todos };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 侧栏开合联动窗口宽度：展开时窗口加宽 280px（侧栏占新增空间，AI 对话区净宽不变）
  // 传入 { open: true/false, width: 280 }，主进程负责边界与最大化保护。
  ipcMain.handle('sidebar-resize-window', async (event, { open, width = 280 } = {}) => {
    try {
      const win = windowState.getMainWindow();
      if (!win || win.isDestroyed()) return { success: false, error: '窗口不存在' };
      if (win.isMaximized() || win.isFullScreen()) {
        // 最大化/全屏下不改尺寸（改也无意义），仅返回状态
        return { success: true, skipped: 'maximized' };
      }
      const { screen } = require('electron');
      const cur = win.getBounds();
      const wa = screen.getDisplayMatching(cur).workAreaSize;

      // 用 __lingyaBaseWidth 记录"未展开侧栏时的原始宽度"，避免累积误差
      if (open) {
        if (typeof win.__lingyaBaseWidth !== 'number') win.__lingyaBaseWidth = cur.width;
        const target = win.__lingyaBaseWidth + width;
        // 不超出屏幕工作区
        const finalW = Math.min(target, wa.width);
        win.setBounds({ x: cur.x, y: cur.y, width: finalW, height: cur.height });
        console.log('[LingYa] 侧栏展开：窗口 ' + cur.width + ' -> ' + finalW);
        return { success: true, width: finalW };
      } else {
        const base = (typeof win.__lingyaBaseWidth === 'number') ? win.__lingyaBaseWidth : (cur.width - width);
        win.setBounds({ x: cur.x, y: cur.y, width: base, height: cur.height });
        win.__lingyaBaseWidth = undefined;
        console.log('[LingYa] 侧栏收起：窗口 ' + cur.width + ' -> ' + base);
        return { success: true, width: base };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 读取项目文件树（只读，供 UI 文件页签浏览）
  ipcMain.handle('get-file-tree', async (event, { maxNodes } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const root = store && store.state ? store.state.selectedProjectDir : null;
      if (!root) return { success: false, error: '尚未选择项目目录（先点「初始化项目」）' };
      const { buildFileTree } = require('./file-tree');
      const r = buildFileTree(root, { maxNodes });
      if (r.error) return { success: false, error: r.error };
      return { success: true, root: root, tree: r.tree, truncated: r.truncated, nodeCount: r.nodeCount };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 读取单个文件内容（供预览；限 512KB 防超长文件卡死）
  ipcMain.handle('read-file-preview', async (event, { filePath } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const root = store && store.state ? store.state.selectedProjectDir : null;
      if (!root) return { success: false, error: '尚未选择项目目录' };
      if (!filePath) return { success: false, error: '缺少文件路径' };
      const path = require('path');
      const fs = require('fs');
      // 路径必须在项目目录内（防越权读取）
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(filePath);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        return { success: false, error: '文件不在项目目录内' };
      }
      const stat = fs.statSync(realFile);
      if (!stat.isFile()) return { success: false, error: '不是文件' };
      const MAX = 512 * 1024;
      if (stat.size > MAX) {
        return { success: true, content: '(文件过大，超过 512KB，暂不支持预览)', truncated: true, size: stat.size };
      }
      const content = fs.readFileSync(realFile, 'utf-8');
      return { success: true, content: content, truncated: false, size: stat.size };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 初始化项目
  ipcMain.handle('init-project', async (event, { skipPrompt = false, projectDir = null, isCompaction = false } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    // 【修复 2026-10-30】拿不到 ctx 时不再把 undefined 透传给 initProject，
    // 而是先打诊断日志再返回明确错误（initProject 内部已不允许静默回退主窗口）。
    if (!ctx) {
      logCtxLookupFailure(event.sender);
      return { success: false, error: '找不到当前窗口上下文（请重开该窗口后重试）' };
    }
    return initProject(skipPrompt, ctx, projectDir, isCompaction);
  });

  // 壳页面：选择项目目录（只更新目录，不发送初始提示词）
  ipcMain.handle('shell-choose-dir', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) {
        logCtxLookupFailure(event.sender);
        return { success: false, error: '找不到当前窗口上下文（请重开该窗口后重试）' };
      }
      const r = await initProject(true, ctx, null, false);   // skipPrompt=true
      return r;
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 壳页面：读取当前项目目录
  ipcMain.handle('shell-get-dir', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const dir = store && store.state ? store.state.selectedProjectDir : null;
      return { success: true, dir: dir || null };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 壳页面：删除文件（右键菜单用）—— 含项目目录越权防护 + 确认
  ipcMain.handle('shell-delete-file', async (event, { filePath, useTrash = true } = {}) => {
    try {
      if (!filePath) return { success: false, error: '缺少文件路径' };
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const root = store && store.state ? store.state.selectedProjectDir : null;
      if (!root) return { success: false, error: '尚未选择项目目录' };

      const path = require('path');
      const fs = require('fs');
      const realRoot = fs.realpathSync(root);
      let realFile;
      try { realFile = fs.realpathSync(filePath); }
      catch (e) { return { success: false, error: '文件不存在或无法访问' }; }

      // 越权防护：必须位于项目目录内，且不能是项目根本身
      if (realFile === realRoot || !realFile.startsWith(realRoot + path.sep)) {
        return { success: false, error: '文件不在项目目录内' };
      }
      const stat = fs.statSync(realFile);
      const isDir = stat.isDirectory();

      // 二次确认（主进程弹原生框，避免 renderer 伪造）
      const { dialog } = require('electron');
      const win = windowState.getMainWindow();
      const name = path.basename(realFile);
      const kind = isDir ? '文件夹' : '文件';
      const confirmRes = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['取消', useTrash ? '移到回收站' : '永久删除'],
        defaultId: 1,
        cancelId: 0,
        title: '确认删除',
        message: '确定要删除' + kind + '「' + name + '」吗？',
        detail: isDir
          ? (useTrash ? '该文件夹及其全部内容将移入系统回收站（可恢复）' : '该文件夹及其全部内容将被永久删除，不可恢复！')
          : (useTrash ? '文件将移入系统回收站（可恢复）' : '此操作不可恢复！'),
      });
      if (confirmRes !== 1) return { success: false, canceled: true };

      if (useTrash) {
        // shell.trashItem 同时支持文件与目录
        await require('electron').shell.trashItem(realFile);
        console.log('[LingYa] 已移到回收站:', realFile, isDir ? '(目录)' : '');
        return { success: true, path: realFile, trashed: true, isDir: isDir };
      } else {
        if (isDir) {
          fs.rmSync(realFile, { recursive: true, force: true });
        } else {
          fs.unlinkSync(realFile);
        }
        console.log('[LingYa] 已永久删除:', realFile, isDir ? '(目录)' : '');
        return { success: true, path: realFile, trashed: false, isDir: isDir };
      }
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 壳页面：复制文本到剪贴板（复制绝对路径用）
  ipcMain.handle('shell-copy-text', async (_event, { text } = {}) => {
    try {
      if (typeof text !== 'string' || !text) return { success: false, error: '无内容' };
      require('electron').clipboard.writeText(text);
      return { success: true, length: text.length };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // ========== 壳页面文件操作（新建/重命名/保存）==========
  // 共用：解析项目根 + 校验目标在根内
  function _resolveInProject(event, targetPath) {
    const path = require('path');
    const fs = require('fs');
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const root = store && store.state ? store.state.selectedProjectDir : null;
    if (!root) throw new Error('尚未选择项目目录');
    const realRoot = fs.realpathSync(root);
    if (!targetPath) throw new Error('缺少路径');
    // 目标可能尚不存在 → 用其父目录 realpath 校验
    let realTarget;
    if (fs.existsSync(targetPath)) {
      realTarget = fs.realpathSync(targetPath);
    } else {
      const parent = path.dirname(targetPath);
      if (!fs.existsSync(parent)) throw new Error('父目录不存在');
      const realParent = fs.realpathSync(parent);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new Error('目标不在项目目录内');
      }
      return { realRoot, absPath: path.join(realParent, path.basename(targetPath)) };
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('目标不在项目目录内');
    }
    return { realRoot, absPath: realTarget };
  }

  // 校验名称合法性（防路径穿越）
  function _checkName(name) {
    const s = String(name || '').trim();
    if (!s) throw new Error('名称不能为空');
    if (s === '.' || s === '..') throw new Error('名称非法');
    if (/[\\/:*?"<>|]/.test(s)) throw new Error('名称不能包含 \\ / : * ? " < > |');
    if (s.length > 200) throw new Error('名称过长');
    return s;
  }

  // 新建文件
  ipcMain.handle('shell-create-file', async (event, { parentDir, name } = {}) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const nm = _checkName(name);
      const r = _resolveInProject(event, path.join(parentDir || '', nm));
      if (fs.existsSync(r.absPath)) return { success: false, error: '已存在同名文件' };
      fs.writeFileSync(r.absPath, '', 'utf-8');
      console.log('[LingYa] 新建文件:', r.absPath);
      return { success: true, path: r.absPath };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 新建文件夹
  ipcMain.handle('shell-create-dir', async (event, { parentDir, name } = {}) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const nm = _checkName(name);
      const r = _resolveInProject(event, path.join(parentDir || '', nm));
      if (fs.existsSync(r.absPath)) return { success: false, error: '已存在同名文件夹' };
      fs.mkdirSync(r.absPath, { recursive: false });
      console.log('[LingYa] 新建文件夹:', r.absPath);
      return { success: true, path: r.absPath };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 重命名（文件或目录）
  ipcMain.handle('shell-rename', async (event, { targetPath, newName } = {}) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const nm = _checkName(newName);
      const r = _resolveInProject(event, targetPath);
      const parent = path.dirname(r.absPath);
      const newPath = path.join(parent, nm);
      if (fs.existsSync(newPath)) return { success: false, error: '已存在同名项' };
      fs.renameSync(r.absPath, newPath);
      console.log('[LingYa] 重命名:', r.absPath, '->', newPath);
      return { success: true, oldPath: r.absPath, newPath: newPath };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 保存文件内容
  ipcMain.handle('shell-write-file', async (event, { filePath, content } = {}) => {
    try {
      const fs = require('fs');
      if (typeof content !== 'string') return { success: false, error: '内容必须是字符串' };
      const r = _resolveInProject(event, filePath);
      const stat = fs.statSync(r.absPath);
      if (!stat.isFile()) return { success: false, error: '不是文件' };
      // 备份一份 .bak（首次保存时）
      const bak = r.absPath + '.lingya-bak';
      try { if (!fs.existsSync(bak)) fs.copyFileSync(r.absPath, bak); } catch (_) {}
      fs.writeFileSync(r.absPath, content, 'utf-8');
      console.log('[LingYa] 已保存:', r.absPath, '(' + content.length + ' 字符)');
      return { success: true, path: r.absPath, bytes: Buffer.byteLength(content, 'utf-8') };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 列出会话（带标题；返回 { sessionId, title, updatedAt }）
  ipcMain.handle('list-sessions', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || !store.state.selectedProjectDir) {
      return { success: true, sessions: [] };
    }
    const all = store.readSessionStore();
    const norm = typeof store.normalizeEntry === 'function' ? store.normalizeEntry : (e) => ({ projectDir: typeof e === 'string' ? e : (e && e.projectDir), title: e && e.title });
    const sessions = [];
    for (const id of Object.keys(all)) {
      const e = norm(all[id]);
      if (e && e.projectDir === store.state.selectedProjectDir) {
        sessions.push({
          sessionId: id,
          title: (e && e.title) || null,
          updatedAt: (e && e.updatedAt) || null,
          archivedAt: (e && e.archivedAt) || null,
        });
      }
    }
    return { success: true, sessions };
  });

  // 设置会话标题（AI 命名对话走 nameConversation 工具；此通道供前端手动改名）
  // 传 sessionId 时改该会话（会话列表里重命名任意对话）；不传则改当前会话。
  ipcMain.handle('set-session-title', async (event, { title, sessionId } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store) return { success: false, error: '会话存储未就绪' };
    if (sessionId) {
      if (typeof store.setSessionTitleById !== 'function') {
        return { success: false, error: '会话存储不支持按 ID 改名' };
      }
      return store.setSessionTitleById(sessionId, title);
    }
    if (typeof store.setSessionTitle !== 'function') {
      return { success: false, error: '会话存储未就绪' };
    }
    return store.setSessionTitle(title);
  });

  // 归档 / 取消归档会话
  ipcMain.handle('set-session-archived', async (event, { sessionId, archived } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.setSessionArchived !== 'function') {
      return { success: false, error: '会话存储未就绪' };
    }
    return store.setSessionArchived(sessionId, !!archived);
  });

  // 删除会话（从存储彻底移除）
  ipcMain.handle('delete-session', async (event, { sessionId } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.deleteSession !== 'function') {
      return { success: false, error: '会话存储未就绪' };
    }
    return store.deleteSession(sessionId);
  });

  // 删除项目（移除该项目下所有会话 + 清除归档状态）
  ipcMain.handle('delete-project', async (event, { dir } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.deleteProject !== 'function') {
      return { success: false, error: '会话存储未就绪' };
    }
    return store.deleteProject(dir);
  });

  // 导出指定会话为 Markdown（转发给 AI 视图从 IndexedDB 读全文）
  ipcMain.handle('export-session-md', async (event, { sessionId, title } = {}) => {
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口上下文不存在' };
    const view = ctx.view;
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      return { success: false, error: 'AI 视图不可用' };
    }
    // 转发给 AI 视图：AI 视图会读 IndexedDB、构建 markdown、调 conversation-export-md
    try {
      view.webContents.send('lingya-export-session-md', { sessionId, title: title || '' });
      return { success: true, forwarded: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导航到会话
  ipcMain.handle('navigate-session', async (event, { sessionId }) => {
    if (!sessionId) return { success: false, error: '缺少会话ID' };
    const ctx = windowState.getContextByWebContents(event.sender);
    const win = ctx ? ctx.win : null;
    if (!win || win.isDestroyed()) return { success: false, error: '窗口已关闭' };
    // 按当前 provider 拼会话 URL（智谱 cid=、DeepSeek /chat/s/、Claude /chat/）
    let url = null;
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(win.webContents.getURL());
      if (provider && typeof provider.sessionUrlBase === 'string' && provider.sessionUrlBase) {
        url = provider.sessionUrlBase + sessionId;
      }
    } catch (_) { /* provider 未识别 */ }
    if (!url) return { success: false, error: '无法确定会话 URL（当前平台未提供 sessionUrlBase）' };
    try {
      await win.webContents.loadURL(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 提示词草稿管理（2026-11-01 新增）==========
  const promptStore = require('./prompt-template-store');
  ipcMain.handle('prompt-tpl-list', async () => {
    try { return promptStore.listAll(); }
    catch (err) { return { success: false, error: err.message, templates: [] }; }
  });
  ipcMain.handle('prompt-tpl-create', async (_event, { name, content, fromId } = {}) => {
    try { return promptStore.createTemplate({ name, content, fromId }); }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('prompt-tpl-update', async (_event, { id, name, content } = {}) => {
    try { return promptStore.updateTemplate({ id, name, content }); }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('prompt-tpl-delete', async (_event, { id } = {}) => {
    try { return promptStore.deleteTemplate({ id }); }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('prompt-tpl-set-active', async (_event, { id } = {}) => {
    try { return promptStore.setActive({ id }); }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('prompt-tpl-duplicate', async (_event, { id, newName } = {}) => {
    try { return promptStore.duplicateTemplate({ id, newName }); }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('prompt-tpl-reset-builtin', async (_event, { id } = {}) => {
    try { return promptStore.resetBuiltin({ id }); }
    catch (err) { return { success: false, error: err.message }; }
  });

  // ========== 底部状态栏数据（对齐 Cuckoo-Code）==========
  // AI 页面推送 token / TPS → 主进程转发给壳页面
  ipcMain.handle('update-token-usage', async (event, payload) => {
    try {
      // 常规：事件来源就是某个窗口的壳/AI 视图
      let ctx = windowState.getContextByWebContents(event.sender);
      // 合并后：来源视图的原始 ctx 的壳窗口已销毁，需找回它当前所在的宿主窗口
      if (!ctx || !ctx.rawWin || ctx.rawWin.isDestroyed()) {
        const host = typeof windowState.findHostContextForView === 'function'
          ? windowState.findHostContextForView(event.sender)
          : null;
        if (host) ctx = host;
      }
      if (!ctx || !ctx.rawWin || ctx.rawWin.isDestroyed()) {
        return { success: false, error: '找不到可接收 token 更新的窗口' };
      }
      const out = Object.assign({}, payload || {});
      // 带上视图标识，让壳页面按视图分别记录用量（多视图分屏时各显示各的）
      try { out.viewKey = String(event.sender.id); } catch (_) {}
      ctx.rawWin.webContents.send('shell-token-updated', out);
    } catch (_) {}
    return { success: true };
  });
  ipcMain.handle('update-tps', async (event, { text } = {}) => {
    try {
      let ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx || !ctx.rawWin || ctx.rawWin.isDestroyed()) {
        const host = typeof windowState.findHostContextForView === 'function'
          ? windowState.findHostContextForView(event.sender)
          : null;
        if (host) ctx = host;
      }
      if (!ctx || !ctx.rawWin || ctx.rawWin.isDestroyed()) {
        return { success: false, error: '找不到可接收 tps 更新的窗口' };
      }
      const out = { tps: String(text || '') };
      try { out.viewKey = String(event.sender.id); } catch (_) {}
      ctx.rawWin.webContents.send('shell-tps-updated', out);
    } catch (_) {}
    return { success: true };
  });

  // ========== 侧栏「工作区」页（对齐 Cuckoo-Code）==========
  // 跨项目聚合所有会话 + 当前会话 + 已归档项目
  ipcMain.handle('list-all-sessions', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.listAllSessions !== 'function') {
      return { success: false, error: '会话存储未就绪', sessions: [], currentSessionId: null, archivedProjects: [] };
    }
    return store.listAllSessions();
  });

  // 归档 / 取消归档项目
  ipcMain.handle('set-project-archived', async (event, { dir, archived } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.setProjectArchived !== 'function') {
      return { success: false, error: '会话存储未就绪' };
    }
    return store.setProjectArchived(dir, !!archived);
  });

  // 读取目录信息（创建时间，用于工作区悬停卡片）
  ipcMain.handle('get-dir-info', async (event, { dir } = {}) => {
    if (!dir || typeof dir !== 'string') return { success: false, error: '缺少目录路径' };
    try {
      const fs = require('fs');
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return { success: false, error: '不是目录' };
      return { success: true, createdAt: st.birthtime.toISOString() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 在指定项目下新建对话（切换项目目录 + 导航到首页）
  ipcMain.handle('new-conversation-for-project', async (event, { projectDir } = {}) => {
    if (!projectDir || typeof projectDir !== 'string') return { success: false, error: '缺少项目目录' };
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口上下文不存在' };
    const store = ctx.sessionStore;
    if (store && store.state) {
      store.state.selectedProjectDir = projectDir;
      store.state.currentSessionId = null;
      try { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('project-dir-updated', projectDir); } catch (_) {}
    }
    // 导航到平台首页
    let homeUrl = 'https://chat.deepseek.com/';
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(ctx.view ? ctx.view.webContents.getURL() : '');
      if (provider && provider.homeUrl) homeUrl = provider.homeUrl;
    } catch (_) {}
    try {
      const target = (ctx.view && ctx.view.webContents) || (ctx.win && ctx.win.webContents);
      if (target) await target.loadURL(homeUrl);
      return { success: true, projectDir, url: homeUrl };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 执行命令
  ipcMain.handle('execute-command', async (event, { command, id }) => {
    if (!command || typeof command !== 'string') {
      return { id, success: false, error: '无效的命令' };
    }
    const trimmed = normalizeCommand(command.trim());
    if (!trimmed) return { id, success: false, error: '命令为空' };

    const ctx = windowState.getContextByWebContents(event.sender);
    const win = ctx ? ctx.win : windowState.getMainWindow();
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;

    const dangerWarning = isDangerous(trimmed) ? '\n\n⚠️ 警告：此命令可能存在风险，请谨慎确认！' : '';
    const result = await dialog.showMessageBox(win, {
      type: isDangerous(trimmed) ? 'warning' : 'question',
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      title: '确认执行命令',
      message: '将执行以下命令：',
      detail: trimmed + dangerWarning,
    });
    if (result.response !== 1) {
      return { id, success: false, error: '用户取消了执行', canceled: true };
    }
    return new Promise((resolve) => {
      const child = exec(
        trimmed,
        {
          cwd: selectedDir || process.env.USERPROFILE || app.getPath('home'),
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          resolve({
            id,
            success: !error,
            stdout: decodeOutput(stdout),
            stderr: decodeOutput(stderr),
            error: error ? error.message : null,
          });
        }
      );
    });
  });

  // 执行工具
  // 2026-11-02：preload 侧的脱敏引擎需要拉取规则表
  ipcMain.handle('get-redaction-rules', async (_e, scope) => {
    try {
      return require('./redaction-store').getActiveRules(scope || null);
    } catch (err) {
      console.warn('[Redaction] 拉取规则失败:', err.message);
      return [];
    }
  });

  // 脱敏规则 CRUD（供侧边栏面板使用）
  ipcMain.handle('redaction-rules-list', async () => {
    try {
      return require('./redaction-store').listRules();
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('redaction-rules-add', async (_e, rule) => {
    try {
      return require('./redaction-store').addRule(rule);
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('redaction-rules-update', async (_e, { name, patch }) => {
    try {
      return require('./redaction-store').updateRule(name, patch);
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('redaction-rules-delete', async (_e, { name }) => {
    try {
      return require('./redaction-store').deleteRule(name);
    } catch (err) {
      return { error: err.message };
    }
  });
  // 2026-11-02：自动扫描 + 批量操作
  ipcMain.handle('redaction-auto-scan', async () => {
    try {
      const store = require('./redaction-store');
      const memoryStore = require('./memory-store');
      const result = store.autoScanMemories(() => memoryStore.getAllMemories());
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('redaction-delete-all-auto', async () => {
    try {
      const count = require('./redaction-store').deleteAllAutoRules();
      return { success: true, deleted: count };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('redaction-promote-all-auto', async () => {
    try {
      const count = require('./redaction-store').promoteRecentAutoToGlobal();
      return { success: true, promoted: count };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('redaction-promote-one', async (_e, { name }) => {
    try {
      const r = require('./redaction-store').promoteToGlobal(name);
      return { success: true, rule: r };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('execute-tool', async (event, { toolName, params, callId }) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    // Agent 权限：plan 模式下禁用写/改/删工具
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    const agent = getAgent(agentStore.getAgentId(profileId));
    // 计划门禁：写类操作前必须先建立计划（每个会话最多拦一次）
    const gate = checkGate(toolName, params, sessionId, profileId);
    if (!gate.allowed) {
      return { callId, success: false, error: gate.error };
    }
    if ((agent.deniedTools || []).includes(toolName)) {
      return {
        callId,
        success: false,
        error: '当前 Agent 模式禁止使用工具 "' + toolName + '"（只读/规划模式）。请在回复中输出实现计划，由用户批准后切换到 Build 模式执行。',
      };
    }
    try {
      // 登记本次工具调用（本模块分配 ID + 会话隔离键）
      const sessionKey = (profileId || 'p') + '::' + (sessionId || 's');
      const tlId = toolLifecycle.register(sessionKey, toolName);
      const holder = { data: null, output: null, images: null };
      try {
        // 2026-11-02：AI 传进来的参数里如果有 ⟦占位符⟧，先还原成真词，
        // 否则工具拿到的路径/关键词都是占位符，会导致"文件找不到"之类的问题。
        const redactionStore = require('./redaction-store');
        const restoredParams = redactionStore.unredactDeep(params);
        const result = await toolRegistry.execute(toolName, {
          ...restoredParams,
          profileId,
          sessionId,
          projectDir: selectedDir,
          readonlyShell: !!agent.readonlyShell,
        });
        const payload = { callId, success: result.success, data: result.data, error: result.error };
        // 把本次结果挂到本模块登记的 ID 上（只记录引用，便于之后释放）
        toolLifecycle.attach(tlId, holder);
        holder.data = payload.data;
        holder.output = payload.error || null;
        toolLifecycle.markDone(tlId);
        // 只清理本会话已完成的条目（不碰其它会话，也不做全局 GC）
        toolLifecycle.sweepSession(sessionKey, 0);
        return payload;
      } catch (innerErr) {
        toolLifecycle.markDone(tlId);
        toolLifecycle.sweepSession(sessionKey, 0);
        throw innerErr;
      }
    } catch (err) {
      return { callId, success: false, error: err.message };
    }
  });

  // AI 回复完成时：窗口已聚焦则不打扰；否则弹通知并让任务栏/Dock 闪烁
  ipcMain.handle('show-ai-notification', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const win = ctx ? ctx.win : windowState.getMainWindow();

      if (win && !win.isDestroyed() && win.isFocused()) {
        // 用户正在查看该窗口，不弹通知、不闪烁
        return { success: true, skipped: true, reason: 'window-focused' };
      }

      if (win && !win.isDestroyed()) {
        let windowName = 'LingYa';
        if (ctx && ctx.profileId) {
          const profile = profileManager.getProfileById(ctx.profileId);
          if (profile && profile.name) windowName = profile.name;
        }

        const notification = new Notification({
          title: windowName + ' - AI任务已完成',
          body: 'AI 已完成回复',
        });
        notification.show();

        win.flashFrame(true);
        win.once('focus', () => {
          if (!win.isDestroyed()) win.flashFrame(false);
        });
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 停止当前任务：kill 所有活动子进程 + 置中止标志
  // 之后的工具/JS 调用会被 JsRunner/BashTool 检测到标志并拒绝执行
  ipcMain.handle('abort-execution', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    // 会话级隔离键：同一窗口内的 A 会话停止不应污染 B 会话。
    // 侧边栏（壳窗口）调用时 sender 是 shell.html，resolveSessionId 会回退到
    // sessionStore 维护的当前会话，保证与工具执行侧的键一致。
    const sessionId = resolveSessionId(ctx, event.sender);
    const key = activeProcesses.abortKey(profileId, sessionId);
    // 只杀本会话的子进程：A 会话停止不应中断 B 会话正在跑的命令
    const killed = activeProcesses.killAll(key);
    activeProcesses.markAborted(key);
    return { success: true, killed };
  });

  // 抢占当前会话的上一轮前台工具执行（后台任务保留）
  //
  // 与 abort-execution 的区别：
  //  - abort-execution 是用户点「停止」：killAll（前台+后台）+ 置中止标志
  //  - preempt-execution 是新工具调用抢占：killRunning（失效旧代际 + 只杀前台），
  //    刻意不置中止标志 —— 否则新脚本一启动就被自己拦住
  // 后台任务（bashBackground 起的构建/服务/爬虫）设计上就长跑，由 AI 自己
  // bashKill 收尾，抢占时误杀会让用户丢工作成果，因此必须区分。
  ipcMain.handle('preempt-execution', async (event, payload) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const profileId = (payload && payload.profileId) || (ctx ? ctx.profileId : null);
      const sessionId = (payload && payload.sessionId) || resolveSessionId(ctx, event.sender);
      const key = activeProcesses.abortKey(profileId, sessionId);
      // 先置标志再杀：让正在跑的 JS 沙箱下一次工具调用立刻返回失败，
      // 与 kill 并行生效，避免杀完进程后脚本还在继续往下走。
      // 【不能用 markAborted】抢占与新执行共用 abortKey，置中止标记会让
      // 紧随其后的新脚本一启动就被拦住 —— 功能完全不生效。改用代际失效。
      const killed = activeProcesses.killRunning(key);
      return { success: true, killed };
    } catch (err) {
      return { success: false, killed: 0, error: err.message };
    }
  });

  // ========== 内存诊断 / 手动回收 ==========
  ipcMain.handle('memory-status', async () => {
    try { return { success: true, ...memoryJanitor.status(), lifecycle: toolLifecycle.stats() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 工具生命周期统计（本模块登记的 ID 情况）
  ipcMain.handle('tool-lifecycle-stats', async () => {
    try { return { success: true, ...toolLifecycle.stats() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 手动清理指定会话的已完成工具条目（不传 sessionKey 则用当前窗口会话）
  ipcMain.handle('tool-lifecycle-sweep', async (event, { sessionKey } = {}) => {
    try {
      let key = sessionKey;
      if (!key) {
        const ctx = windowState.getContextByWebContents(event.sender);
        const pid = ctx ? ctx.profileId : null;
        const sid = resolveSessionId(ctx, event.sender);
        key = (pid || 'p') + '::' + (sid || 's');
      }
      const cleaned = toolLifecycle.sweepSession(key, 0);
      return { success: true, cleaned, sessionKey: key, ...toolLifecycle.stats() };
    } catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('memory-collect', async () => {
    try {
      const ok = memoryJanitor.collect(false);
      return { success: true, collected: ok, ...memoryJanitor.status() };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 用户下次发消息时清除中止标志，恢复正常执行
  ipcMain.handle('clear-abort', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    // 与 abort-execution 用同一粒度的键，否则清除会漏（标记残留 → 换会话仍被拦）
    const sessionId = resolveSessionId(ctx, event.sender);
    activeProcesses.clearAborted(activeProcesses.abortKey(profileId, sessionId));
    return { success: true };
  });

  // 执行 JS 脚本
  ipcMain.handle('execute-js', async (event, { code, callId }) => {
    if (!code || typeof code !== 'string') {
      return { callId, success: false, error: '无效的 JS 代码' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    // Agent 权限：plan 模式下写/改/删工具在 JsRunner 执行层被硬拒绝
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    const agent = getAgent(agentStore.getAgentId(profileId));
    try {
      const sessionKey = (profileId || 'p') + '::' + (sessionId || 's');
      const tlId = toolLifecycle.register(sessionKey, '__js_script__');
      const holder = { data: null, output: null, images: null };
      try {
        const result = await jsRunner.run(code, selectedDir, {
          deniedTools: agent.deniedTools,
          readonlyShell: !!agent.readonlyShell,
          profileId,
          sessionId,
        });
        // 挂引用 + 标记完成 + 只清本会话已完成条目
        toolLifecycle.attach(tlId, holder);
        holder.output = result.output || null;
        holder.images = result.images || null;
        toolLifecycle.markDone(tlId);
        toolLifecycle.sweepSession(sessionKey, 0);
        return { callId, ...result };
      } catch (innerErr) {
        toolLifecycle.markDone(tlId);
        toolLifecycle.sweepSession(sessionKey, 0);
        throw innerErr;
      }
    } catch (err) {
      return { callId, success: false, error: err.message };
    }
  });

  // 站点原生发送：向聚焦输入框注入真实级 Enter（智谱只响应 isTrusted=true 的输入，合成事件免疫）
  ipcMain.handle('chat-send-enter', async (event) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return false;
    try {
      sender.sendInputEvent({ type: 'keyDown', keyCode: 'Return', key: 'Enter' });
      sender.sendInputEvent({ type: 'char', keyCode: 'Return', key: '\r' });
      sender.sendInputEvent({ type: 'keyUp', keyCode: 'Return', key: 'Enter' });
      return true;
    } catch (err) {
      console.error('[LingYa] ❌ 原生 Enter 发送失败:', err.message);
      return false;
    }
  });

  // 模拟真实鼠标事件（isTrusted=true），用于需要原生点击的站点
  // action: 'move' | 'click'；x/y 为相对视口的 CSS 像素坐标
  ipcMain.handle('simulate-mouse', async (event, { action, x, y } = {}) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return false;
    const px = Math.round(Number(x) || 0);
    const py = Math.round(Number(y) || 0);
    try {
      if (action === 'move') {
        sender.sendInputEvent({ type: 'mouseMove', x: px, y: py });
      } else {
        sender.sendInputEvent({ type: 'mouseMove', x: px, y: py });
        sender.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
        sender.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
      }
      return true;
    } catch (err) {
      console.error('[LingYa] ❌ simulate-mouse 失败:', err.message);
      return false;
    }
  });

  // ========== Skill 系统 ==========
  // 列出所有技能
  // ========== Trusted input (isTrusted) ==========
  ipcMain.handle('trusted-click', async (event, args) => {
    try {
      const wc = event.sender;
      if (!wc || typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
        return { success: false, error: 'webContents unavailable' };
      }
      const x = Number(args && args.x);
      const y = Number(args && args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: 'invalid coordinates' };
      }
      let size = [0, 0];
      if (typeof wc.getSize === 'function') size = wc.getSize();
      const w = Number(size && size[0]) || 0;
      const h = Number(size && size[1]) || 0;
      let cx = Math.round(x);
      let cy = Math.round(y);
      if (w > 0) cx = Math.max(0, Math.min(cx, w - 1));
      if (h > 0) cy = Math.max(0, Math.min(cy, h - 1));
      wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
      wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('trusted-key', async (event, args) => {
    try {
      const wc = event.sender;
      if (!wc || typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
        return { success: false, error: 'webContents unavailable' };
      }
      const key = String(args && args.key || '');
      if (!key) return { success: false, error: 'invalid key' };
      const keyCode = key === 'Enter' ? 'Return' : key;
      wc.sendInputEvent({ type: 'keyDown', keyCode: keyCode, key: key });
      if (key === 'Enter') {
        wc.sendInputEvent({ type: 'char', keyCode: 'Return', key: String.fromCharCode(13) });
      }
      wc.sendInputEvent({ type: 'keyUp', keyCode: keyCode, key: key });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('skill-list', async () => {
    try {
      return { success: true, skills: skillStore.getAllSkills() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 新增/更新技能
  ipcMain.handle('skill-save', async (_event, { skill } = {}) => {
    try {
      const name = skillStore.saveSkill(skill || {});
      return { success: true, name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除技能
  ipcMain.handle('skill-delete', async (_event, { name } = {}) => {
    try {
      skillStore.deleteSkill(name);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 启用/禁用技能
  ipcMain.handle('skill-set-enabled', async (_event, { name, enabled } = {}) => {
    try {
      skillStore.setSkillEnabled(name, enabled);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 从本地文件夹导入技能
  ipcMain.handle('skill-import-folder', async () => {
    try {
      const win = windowState.getMainWindow();
      const result = dialog.showOpenDialogSync(win, {
        properties: ['openDirectory'],
        title: '选择包含 SKILL.md 的技能文件夹',
      });
      if (!result || result.length === 0) {
        return { success: false, canceled: true };
      }
      const res = skillStore.importFromFolder(result[0]);
      return { success: true, ...res };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== Agent 系统（Plan / Build 模式）==========
  // 列出所有 agent 定义 + 当前 profile 的当前 agent
  ipcMain.handle('agent-list', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const profileId = ctx ? ctx.profileId : null;
      return {
        success: true,
        agents: listAgents(),
        current: agentStore.getAgentId(profileId),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 切换当前 profile 的 agent
  ipcMain.handle('agent-set', async (event, { agentId } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const profileId = ctx ? ctx.profileId : null;
      if (!profileId) return { success: false, error: '无法确定当前窗口 profile' };
      const applied = agentStore.setAgentId(profileId, agentId);
      return { success: true, agentId: applied };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取当前 agent 的完整定义（含 section 文本，供前端提示用）
  ipcMain.handle('agent-current', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const profileId = ctx ? ctx.profileId : null;
      const id = agentStore.getAgentId(profileId);
      const agent = getAgent(id);
      return { success: true, agentId: id, name: agent.name, icon: agent.icon };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 记忆系统 ==========
  // 列出所有记忆
  ipcMain.handle('memory-list', async () => {
    try {
      return { success: true, memories: memoryStore.getAllMemories() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 新增记忆
  ipcMain.handle('memory-save', async (_event, { memory } = {}) => {
    try {
      const id = memoryStore.saveMemory(memory || {});
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新记忆
  ipcMain.handle('memory-update', async (_event, { memory } = {}) => {
    try {
      memoryStore.updateMemory(memory || {});
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除记忆
  ipcMain.handle('memory-delete', async (_event, { id } = {}) => {
    try {
      memoryStore.deleteMemory(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导入记忆（弹文件选择框，读取 JSON 后批量导入）
  ipcMain.handle('memory-import', async () => {
    try {
      const win = windowState.getMainWindow();
      const result = dialog.showOpenDialogSync(win, {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
        title: '选择记忆 JSON 文件',
      });
      if (!result || result.length === 0) {
        return { success: false, canceled: true };
      }
      const fs = require('fs');
      const raw = fs.readFileSync(result[0], 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return { success: false, error: 'JSON 解析失败: ' + err.message };
      }
      const stat = memoryStore.importMemories(parsed);
      return { success: true, ...stat };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导出记忆（弹保存框，写出 JSON）
  ipcMain.handle('memory-export', async () => {
    try {
      const win = windowState.getMainWindow();
      const defaultName = 'lingya-memories-' + new Date().toISOString().slice(0, 10) + '.json';
      const result = dialog.showSaveDialogSync(win, {
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        title: '导出记忆',
      });
      if (!result) {
        return { success: false, canceled: true };
      }
      const fs = require('fs');
      const data = memoryStore.exportMemories();
      fs.writeFileSync(result, JSON.stringify(data, null, 2), 'utf-8');
      return { success: true, count: data.length, path: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导出对话为 Markdown（渲染进程生成好内容，主进程只负责弹框写盘）
  ipcMain.handle('conversation-export-md', async (_event, { markdown, suggestedName } = {}) => {
    try {
      if (typeof markdown !== 'string' || !markdown) {
        return { success: false, error: '导出内容为空' };
      }
      const win = windowState.getMainWindow();
      // 兜底文件名：渲染进程没传 suggestedName 时用。
      // 主进程拿不到 document.title，所以只能给通用名，但时间格式与渲染进程保持一致
      // （YYYYMMDD-HHmm），避免两处命名风格割裂。
      const _d = new Date();
      const _pad = (n) => String(n).padStart(2, '0');
      const _stamp = _d.getFullYear() + _pad(_d.getMonth() + 1) + _pad(_d.getDate()) +
        '-' + _pad(_d.getHours()) + _pad(_d.getMinutes());
      const fallback = 'lingya-conversation-' + _stamp + '.md';
      const result = dialog.showSaveDialogSync(win, {
        defaultPath: suggestedName || fallback,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        title: '导出对话为 Markdown',
      });
      if (!result) return { success: false, canceled: true };
      const fs = require('fs');
      fs.writeFileSync(result, markdown, 'utf-8');
      console.log('[LingYa] 对话已导出:', result, '(' + markdown.length + ' 字符)');
      return { success: true, path: result, bytes: markdown.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 构建记忆注入块（手动插入时用）
  ipcMain.handle('memory-build-section', async (_event, { prompt } = {}) => {
    try {
      return { success: true, section: memoryStore.buildMemorySection({ prompt }) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 安全增强（CTF 注入 + 拒绝拦截）==========
  // 读取安全配置（脱敏：不返回 aiKey 明文，仅返回 aiKeyConfigured）
  ipcMain.handle('security-get-config', async () => {
    try {
      return { success: true, config: securityStore.getPublicConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新安全配置
  ipcMain.handle('security-update-config', async (_event, { config } = {}) => {
    try {
      const updated = securityStore.updateConfig(config || {});
      return { success: true, config: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 重置安全配置
  ipcMain.handle('security-reset-config', async () => {
    try {
      const cfg = securityStore.resetConfig();
      return { success: true, config: cfg };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取当前生效的 CTF 提示词（用于手动注入；自定义优先，否则内置模板）
  ipcMain.handle('security-get-ctf-prompt', async () => {
    try {
      const cfg = securityStore.getConfig();
      let ctfPrompt = (cfg.ctfPrompt || '').trim();
      if (!ctfPrompt) {
        const { PROMPT_DIR } = require('./project-context');
        const fs = require('fs');
        const path = require('path');
        const p = path.join(PROMPT_DIR, 'ctf.md');
        if (fs.existsSync(p)) ctfPrompt = fs.readFileSync(p, 'utf-8');
      }
      return { success: true, prompt: ctfPrompt, enabled: !!cfg.ctfInjectionEnabled };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 插件系统 ==========
  const pluginHost = require('./plugin-host');

  // 列出所有插件（含启用/加载状态）
  ipcMain.handle('plugin-restore-bundled', async () => {
    try {
      const res = await pluginHost.restoreBundledPlugins();
      return Object.assign({ plugins: pluginHost.listPlugins(), dir: pluginHost.getPluginsDir(), deletedCount: 0 }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugin-list', async () => {
    try {
      return { success: true, plugins: pluginHost.listPlugins(), dir: pluginHost.getPluginsDir(), deletedCount: require('./plugin-store').listDeleted().length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 启用/禁用插件（运行时生效，可逆注册）
  ipcMain.handle('plugin-set-enabled', async (_event, { id, enabled } = {}) => {
    try {
      const res = await pluginHost.setPluginEnabled(id, !!enabled);
      // 工具集可能变化：广播给所有渲染进程，让 preload 刷新工具名白名单
      broadcastToolsChanged();
      return Object.assign({ plugins: pluginHost.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 置顶/取消置顶插件（仅影响侧边栏排序）
  ipcMain.handle('plugin-set-pinned', async (_event, { id, pinned } = {}) => {
    try {
      const res = await pluginHost.setPluginPinned(id, !!pinned);
      return Object.assign({ plugins: pluginHost.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 重载插件（改代码后无需重启 LingYa）
  ipcMain.handle('plugin-reload', async (_event, { id } = {}) => {
    try {
      const res = await pluginHost.reloadPlugin(id);
      broadcastToolsChanged();
      return Object.assign({ plugins: pluginHost.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 工具集变化广播（AI 视图 + 壳窗口都要收到）
  function broadcastToolsChanged() {
    try {
      for (const ctx of windowState.getAllContexts()) {
        try {
          const wc = ctx.win && ctx.win.webContents;
          if (wc && !wc.isDestroyed()) wc.send('lingya-tools-changed');
        } catch (_) {}
        try {
          const raw = ctx.rawWin;
          if (raw && !raw.isDestroyed() && raw.webContents) raw.webContents.send('lingya-tools-changed');
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 打开插件目录（系统文件管理器）
  ipcMain.handle('plugin-open-dir', async () => {
    try {
      const { shell } = require('electron');
      const dir = pluginHost.getPluginsDir();
      if (dir) await shell.openPath(dir);
      return { success: true, dir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 工具名集合（供 preload 动态刷新白名单，含插件贡献的工具）==========
  ipcMain.handle('tool-list-names', async () => {
    try {
      return { success: true, names: toolRegistry.listNames() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 插件导入 / 导出 / 删除 ==========

  // 导出插件为 .zip（弹保存框）
  ipcMain.handle('plugin-export', async (event, { id } = {}) => {
    try {
      const res = pluginHost.exportPlugin(id);
      if (!res.success) return res;
      const win = windowState.getMainWindow();
      const saveRes = await dialog.showSaveDialog(win || undefined, {
        title: '导出插件',
        defaultPath: res.filename,
        filters: [{ name: 'LingYa 插件包', extensions: ['zip'] }],
      });
      if (saveRes.canceled || !saveRes.filePath) return { success: false, error: '已取消' };
      require('fs').writeFileSync(saveRes.filePath, res.data);
      return { success: true, path: saveRes.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 从 .zip 导入插件（弹打开框）
  ipcMain.handle('plugin-import', async () => {
    try {
      const win = windowState.getMainWindow();
      const openRes = await dialog.showOpenDialog(win || undefined, {
        title: '导入插件包',
        properties: ['openFile'],
        filters: [{ name: 'LingYa 插件包', extensions: ['zip'] }],
      });
      if (openRes.canceled || !openRes.filePaths || !openRes.filePaths.length) {
        return { success: false, error: '已取消' };
      }
      const buf = require('fs').readFileSync(openRes.filePaths[0]);
      const res = await pluginHost.importPlugin(buf);
      broadcastToolsChanged();
      return Object.assign({ plugins: pluginHost.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除插件（连带卸载 + 移除目录）
  ipcMain.handle('plugin-delete', async (_event, { id } = {}) => {
    try {
      const res = pluginHost.deletePlugin(id);
      broadcastToolsChanged();
      return Object.assign({ plugins: pluginHost.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 列出插件注册的视图（含渲染后的 HTML），供壳窗口动态挂载
  ipcMain.handle('plugin-views', async () => {
    try {
      return { success: true, views: pluginHost.listPluginViews() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 通用插件 IPC 调用入口：{ pluginId, channel, args }
  ipcMain.handle('plugin-invoke', async (event, { pluginId, channel, args } = {}) => {
    try {
      return await pluginHost.invokePluginIpc(pluginId, channel, args, event);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导出自带插件开发 Skill 包
  ipcMain.handle('plugin-export-skill', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    let tmpDir = '';
    try {
      const win = windowState.getMainWindow();
      let srcDir = path.join(__dirname, '..', 'assets', 'plugin-dev-skill');
      if (!fs.existsSync(srcDir)) throw new Error('内置 Skill 资源不存在，请检查打包配置');
      
      const saveRes = await dialog.showSaveDialog(win || undefined, {
        title: '导出插件开发 Skill',
        defaultPath: 'LingYa-Plugin-Dev-Skill.zip',
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (saveRes.canceled || !saveRes.filePath) return { success: false, error: '已取消' };

      // 1. 建临时目录
      tmpDir = path.join(os.tmpdir(), 'lingya-skill-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      
      // 2. 复制内置 Skill 目录
      function copyDir(src, dst) {
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f);
          const d = path.join(dst, f);
          if (fs.statSync(s).isDirectory()) copyDir(s, d);
          else fs.copyFileSync(s, d);
        }
      }
      copyDir(srcDir, tmpDir);

      // 3. 复制核心源码作为参考
      const srcCodeDir = path.join(tmpDir, 'source');
      fs.mkdirSync(srcCodeDir, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'plugin-host.js'), path.join(srcCodeDir, 'plugin-host.js'));
      fs.copyFileSync(path.join(__dirname, '..', 'preload', 'plugin-api.js'), path.join(srcCodeDir, 'plugin-api.js'));

      // 4. 打包
      const buf = require('./plugin-zip').zipDir(tmpDir, 'LingYa-Plugin-Dev-Skill');
      fs.writeFileSync(saveRes.filePath, buf);
      
      return { success: true, path: saveRes.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      // 5. 清理临时目录
      if (tmpDir && fs.existsSync(tmpDir)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  });

  // 收集插件 preload 脚本（供 AI 视图 preload 注入）
  ipcMain.handle('plugin-preloads', async () => {
    try {
      return { success: true, scripts: pluginHost.collectPreloadScripts() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== DSH 兼容层（外部 npm 插件）==========
  const dsh = require('./dsh');

  ipcMain.handle('dsh-list', async () => {
    try {
      return { success: true, plugins: dsh.listPlugins(), dir: require('./dsh/paths').getDshPluginsDir() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dsh-install', async (_e, { spec } = {}) => {
    try {
      const res = await dsh.installPlugin(spec);
      return Object.assign({ plugins: dsh.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dsh-uninstall', async (_e, { id } = {}) => {
    try {
      const res = await dsh.uninstallPlugin(id);
      return Object.assign({ plugins: dsh.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dsh-set-enabled', async (_e, { id, enabled } = {}) => {
    try {
      const res = await dsh.setEnabled(id, !!enabled);
      return Object.assign({ plugins: dsh.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dsh-reload', async (_e, { id } = {}) => {
    try {
      const res = await dsh.reloadPlugin(id);
      return Object.assign({ plugins: dsh.listPlugins() }, res);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('dsh-market', async (_e, { force } = {}) => {
    try {
      return await dsh.searchMarket({ force: !!force });
    } catch (err) {
      return { success: false, error: err.message, items: [] };
    }
  });

  ipcMain.handle('dsh-open-dir', async () => {
    try {
      const { shell } = require('electron');
      const dir = require('./dsh/paths').getDshPluginsDir();
      if (dir) await shell.openPath(dir);
      return { success: true, dir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 可信输入（CDP）==========
  // 走 CDP Input.insertText，触发 isTrusted=true 的 input 事件。
  // 替代 preload 里 nativeSetter + 合成 Event('input') 的做法。
  ipcMain.handle('trusted-insert-text', async (event, args) => {
    return handleTrustedInsertText(event, args);
  });

  // ========== CDP 捕获（替代页面内 hook）==========
  // 只在 provider 声明 useCdp: true 时生效（当前仅 deepseek）。
  // 注册 lingya-cdp-enable / lingya-cdp-disable 两个 handler。
  try {
    require('./cdp-wiring').install(ipcMain);
  } catch (err) {
    console.error('[LingYa] cdp-wiring 安装失败:', err && err.message);
  }

  // ==================== 【Harness 2026-11-02】纯净对话模式 IPC ====================

  /** 找发起事件的窗口上下文（含 harness 视图、AI 视图） */
  function getHarnessInfo(event) {
    let ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) {
      // 可能是从 harness 视图本身发起
      const all = windowState.getAllContexts();
      for (const c of all) {
        if (c.harnessView && !c.harnessView.webContents.isDestroyed() && c.harnessView.webContents === event.sender) {
          ctx = c;
          break;
        }
      }
    }
    if (!ctx) return null;
    const activeTab = ctx.tabs ? ctx.tabs.get(ctx.activeTabId) : null;
    const aiWc = (activeTab && activeTab.view && !activeTab.view.webContents.isDestroyed())
      ? activeTab.view.webContents
      : (ctx.view && !ctx.view.webContents.isDestroyed() ? ctx.view.webContents : null);
    return { ctx, aiWc };
  }

  ipcMain.handle('harness-toggle', async (event, { show } = {}) => {
    try {
      const info = getHarnessInfo(event);
      if (!info) return { success: false, error: '窗口不存在' };
      const rawWin = info.ctx.rawWin;
      if (!rawWin || typeof rawWin.__lingyaToggleHarness !== 'function') {
        return { success: false, error: '切换函数未就绪' };
      }
      rawWin.__lingyaToggleHarness(show);
      return { success: true, harness: !!info.ctx.harnessVisible };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-send', async (event, { text } = {}) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.aiWc) return { success: false, error: 'AI 视图不可用' };
      info.aiWc.send('harness-user-message', { text: String(text || '') });
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-exit', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info) return { success: false, error: '窗口不存在' };
      const rawWin = info.ctx.rawWin;
      if (rawWin && typeof rawWin.__lingyaToggleHarness === 'function') {
        rawWin.__lingyaToggleHarness(false);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-stop', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.aiWc) return { success: false, error: 'AI 视图不可用' };
      info.aiWc.send('harness-stop-signal');
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-reload', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.ctx.harnessView) return { success: false, error: 'harness 未创建' };
      info.ctx.harnessView.webContents.reloadIgnoringCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-new-conversation', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.aiWc) return { success: false, error: 'AI 视图不可用' };
      info.aiWc.send('lingya-new-chat-request');
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.handle('harness-get-state', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info) return { success: false, error: '窗口不存在' };
      const store = info.ctx.sessionStore;
      const projectDir = store && store.state ? store.state.selectedProjectDir : null;
      // Cuckoo harness 期待 { needInit }：无项目目录时为 true
      const needInit = !projectDir;
      return {
        success: true,
        needInit,
        projectDir: projectDir || '',
        harness: !!info.ctx.harnessVisible,
      };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  // 列出可用工具与技能（供 harness 斜杠菜单）
  ipcMain.handle('harness-list-tools', async () => {
    try {
      const descs = toolRegistry.getDescriptions ? toolRegistry.getDescriptions() : [];
      const tools = (descs || []).map((t) => ({
        name: t.name,
        description: t.description || '',
      }));
      let skills = [];
      try {
        const allSkills = skillStore.getAllSkills ? skillStore.getAllSkills() : [];
        skills = (allSkills || []).filter((s) => s.enabled !== false).map((s) => ({
          name: s.name,
          description: s.description || '',
          path: s.localPath || '',
        }));
      } catch (_) {}
      return { success: true, tools, skills };
    } catch (err) {
      return { success: false, error: err && err.message, tools: [], skills: [] };
    }
  });

  ipcMain.handle('harness-init-project', async (event) => {
    try {
      const info = getHarnessInfo(event);
      if (!info) return { success: false, error: '窗口不存在' };
      await initProject(false, info.ctx, null, false);
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  // 【Harness 2026-11-02】附件上传：CDP executeJavaScript 注入（对齐 Cuckoo）
  // 把文件转为 DataTransfer + File 对象，注入到 AI 页面的 input[type=file] 上
  ipcMain.handle('harness-attach', async (event, { files } = {}) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.aiWc) return { success: false, error: 'AI 视图不可用' };
      const arr = Array.isArray(files) ? files : [];
      if (arr.length === 0) return { success: false, error: '无文件' };

      // 构造注入脚本（每个文件依次上传）
      // 核心逻辑参考 Cuckoo src/app/ipc/harness.ts 的 attachFn：
      //   1. base64 → Uint8Array → File
      //   2. 找 input[type=file]（找不到则尝试点击上传按钮触发）
      //   3. DataTransfer 注入 + dispatchEvent('change')
      const uploadFn = `(async function(filesData) {
        function findInput() { return document.querySelector('input[type=file]'); }
        let input = findInput();
        if (!input) {
          // 尝试点击上传按钮触发 input 出现
          const keys = ['attach','upload','paperclip','file','image','图片','文件','上传','添加'];
          const cands = document.querySelectorAll('button, [role=button], [class*=attach], [class*=upload], [class*=file], [class*=plus], [class*=add]');
          for (let ci = 0; ci < cands.length; ci++) {
            const b = cands[ci];
            if (!b || b.offsetWidth === 0) continue;
            const sig = String(b.className || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
            const low = sig.toLowerCase();
            for (let ki = 0; ki < keys.length; ki++) {
              if (low.indexOf(keys[ki].toLowerCase()) !== -1) { b.click(); break; }
            }
            input = findInput();
            if (input) break;
          }
          if (!input) {
            const dl = Date.now() + 2500;
            while (Date.now() < dl && !input) {
              await new Promise(function(r) { setTimeout(r, 120); });
              input = findInput();
            }
          }
        }
        if (!input) return { success: false, error: '未找到文件上传输入框' };
        const results = [];
        for (let i = 0; i < filesData.length; i++) {
          const fd = filesData[i];
          try {
            const bin = atob(fd.data);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            const file = new File([bytes], fd.name, { type: fd.mime || 'application/octet-stream' });
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ name: fd.name, ok: true });
            await new Promise(function(r) { setTimeout(r, 400); });
          } catch (err) {
            results.push({ name: fd.name, ok: false, error: err.message });
          }
        }
        return { success: results.some(function(x) { return x.ok; }), results: results };
      })(` + JSON.stringify(arr) + `)`;

      const result = await info.aiWc.executeJavaScript(uploadFn, true);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || '注入上传失败', results: (result && result.results) || [] };
      }
      // 上传完成后，发一条提示消息给 AI（引导它查看附件）
      try {
        const names = arr.map((f) => f.name).filter(Boolean).join('、');
        if (names) info.aiWc.send('harness-user-message', { text: '我上传了附件：' + names });
      } catch (_) {}
      return { success: true, results: result.results };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  // bridge 上报事件 → 转发给 harness 视图
  // ===== 自定义数据目录 =====
  // 配置文件固定存在 appData 下（<appData>/<SESSION_DIR>/data-location.json），
  // 不随数据目录本身变化 —— 否则改了路径后下次启动就找不到配置了。
  function _getDataLocCfgPath() {
    const _path = require('path');
    const SESSION_DIR = process.env.LINGYA_SESSION_DIR || 'lingya-ai-pro-session';
    return _path.join(app.getPath('appData'), SESSION_DIR, 'data-location.json');
  }

  // 读取当前数据目录信息
  ipcMain.handle('data-path-get', async () => {
    try {
      const _path = require('path');
      const fs = require('fs');
      const cfgPath = _getDataLocCfgPath();
      let customDir = null;
      if (fs.existsSync(cfgPath)) {
        try { customDir = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).customDir || null; } catch (_) {}
      }
      return {
        success: true,
        currentDir: app.getPath('userData'),
        customDir: customDir,
        defaultDir: _path.join(_path.dirname(process.execPath), 'LingYa-Data'),
        appDataDir: app.getPath('appData'),
        configPath: cfgPath,
      };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 设置自定义数据目录（写入配置，重启后生效）
  ipcMain.handle('data-path-set', async (_e, { dir } = {}) => {
    try {
      const _path = require('path');
      const fs = require('fs');
      const target = String(dir || '').trim();
      if (!target) return { success: false, error: '路径不能为空' };
      const resolved = _path.resolve(target);
      // 可写性探测
      try {
        fs.mkdirSync(resolved, { recursive: true });
        const probe = _path.join(resolved, '.lingya-write-probe-' + Date.now());
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
      } catch (e) {
        return { success: false, error: '目录不可写: ' + e.message };
      }
      const cfgPath = _getDataLocCfgPath();
      fs.mkdirSync(_path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ customDir: resolved, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
      return { success: true, dir: resolved, needRestart: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 恢复默认（删除配置文件，重启后回到 exe 同目录 LingYa-Data）
  ipcMain.handle('data-path-reset', async () => {
    try {
      const fs = require('fs');
      const cfgPath = _getDataLocCfgPath();
      if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
      return { success: true, needRestart: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 弹目录选择框
  ipcMain.handle('data-path-choose', async (event) => {
    try {
      const { BrowserWindow } = require('electron');
      const win = (event.sender && BrowserWindow.fromWebContents(event.sender)) || null;
      const r = await dialog.showOpenDialog(win || undefined, {
        title: '选择 LingYa 数据保存目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || r.filePaths.length === 0) return { success: false, canceled: true };
      return { success: true, dir: r.filePaths[0] };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 重启应用使数据目录变更生效
  ipcMain.handle('data-path-restart', async () => {
    try {
      app.relaunch();
      setTimeout(() => app.exit(0), 200);
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('harness-event-report', async (event, payload) => {
    try {
      const info = getHarnessInfo(event);
      if (!info || !info.ctx.harnessView) return { success: true, dropped: true };
      const hv = info.ctx.harnessView;
      if (hv.webContents.isDestroyed()) return { success: true, dropped: true };
      hv.webContents.send('harness-event', payload || {});
      return { success: true };
    } catch (err) {
      return { success: false, error: err && err.message };
    }
  });

  ipcMain.on('harness-set-busy', () => { /* 预留 */ });
  ipcMain.on('harness-ready', () => { /* 预留 */ });

  // ==================== Harness IPC 结束 ====================
}

/**
 * 用 CDP Input.insertText 往当前焦点元素写文本。
 *
 * 相比 preload 里 nativeSetter + dispatchEvent(new Event('input')) 的做法，
 * 走 CDP 触发的是浏览器内核级输入，input 事件的 isTrusted 为 true
 * （2026-10-31 spike 实测验证），消除最密集的合成事件指纹。
 *
 * @param {Event} event IPC 事件（用 event.sender 拿 webContents）
 * @param {{ text: string }} args
 * @param {{ ensureAttached?: Function }} deps 仅测试注入，生产不传
 */
async function handleTrustedInsertText(event, args, deps) {
  const text = String((args && args.text) || '');
  if (!text) return { success: false, error: 'empty text' };
  const sender = event && event.sender;
  if (!sender) return { success: false, error: 'sender unavailable' };
  const ensure = (deps && deps.ensureAttached) || require('./cdp-capture').ensureAttached;
  try {
    const dbg = ensure(sender);
    await dbg.sendCommand('Input.insertText', { text });
    return { success: true };
  } catch (err) {
    return { success: false, error: err && err.message };
  }
}

module.exports = {
  registerIpcHandlers,
  __test: { handleTrustedInsertText },
};
