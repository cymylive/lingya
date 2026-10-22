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
const refusalRewriter = require('./refusal-rewriter');
const { decodeOutput, normalizeCommand } = require('../../tools/decodeOutput');
const activeProcesses = require('../../tools/active-processes');
const { registerFeishuIpc } = require('./feishu-ipc');
const { todoEvents, getTodos, clearTodos } = require('../../tools/TodoWriteTool');
const userTodoStore = require('../../tools/UserTodoStore');
const planGate = require('../../tools/plan-gate');
const { checkGate } = require('../../tools/plan-gate');
const memoryJanitor = require('../../tools/memory-janitor');
const toolLifecycle = require('../../tools/tool-lifecycle');

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

function registerIpcHandlers() {
  // 飞书同步 IPC
  registerFeishuIpc();

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
  });

  // 读取当前窗口/会话的待办列表（严格按会话隔离，返回 archived 标记）
  ipcMain.handle('get-todos', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const profileId = ctx ? ctx.profileId : null;
    const sessionId = resolveSessionId(ctx, event.sender);
    const r = getTodos(sessionId, profileId);
    return { success: true, todos: r.todos, archived: r.archived, sessionId };
  });

  // ===== 计划执行前人工确认 =====
  // 用户点计划面板「确认执行」按钮 → 解除该会话的等待确认状态
  // @param opts.silent 用户已自己发了消息（如回复「确认」），只需解锁、不必程序代发
  ipcMain.handle('plan-confirm', async (event, opts) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '窗口不存在' };
      const profileId = ctx.profileId;
      const sessionId = resolveSessionId(ctx, event.sender);
      planGate.markConfirmed(sessionId, profileId);
      const silent = !!(opts && opts.silent);
      console.log('[LingYa] 用户确认执行计划: session=' + (sessionId || 'null') +
        (silent ? '（silent，用户已自行发消息）' : '（需程序代发继续指令）'));
      // 点按钮时用户没发消息，AI 停在那里不会自己动 → 需要程序发一条。
      // 回复确认词时用户的消息本身就会到达 AI → 不能再发，否则重复两轮。
      if (!silent) {
        try {
          const target = ctx.view && ctx.view.webContents && !ctx.view.webContents.isDestroyed()
            ? ctx.view.webContents
            : (ctx.win && ctx.win.webContents);
          if (target) target.send('lingya-plan-confirmed-continue', { sessionId });
        } catch (_) {}
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 查询当前是否在等待确认（面板据此决定是否显示「确认执行」按钮）
  ipcMain.handle('plan-confirm-status', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '窗口不存在' };
      const profileId = ctx.profileId;
      const sessionId = resolveSessionId(ctx, event.sender);
      return {
        success: true,
        awaiting: planGate.isAwaitingConfirm(sessionId, profileId),
        enabled: planGate.isRequireConfirmEnabled(),
        sessionId,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
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
  ipcMain.handle('get-file-tree', async (event, { maxNodes = 5000 } = {}) => {
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
    return initProject(skipPrompt, ctx, projectDir, isCompaction);
  });

  // 壳页面：选择项目目录（只更新目录，不发送初始提示词）
  ipcMain.handle('shell-choose-dir', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
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
        const result = await toolRegistry.execute(toolName, {
          ...params,
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
    // 只杀本窗口的子进程：A 窗口停止不应中断 B 窗口正在跑的命令
    const killed = activeProcesses.killAll(profileId);
    activeProcesses.markAborted(profileId);
    return { success: true, killed };
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
    activeProcesses.clearAborted(profileId);
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
      const fallback = 'lingya-conversation-' + new Date().toISOString().slice(0, 10) + '.md';
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
      // 计划确认开关变化时同步到 plan-gate（否则改了设置不生效）
      if (config && Object.prototype.hasOwnProperty.call(config, 'planConfirmEnabled')) {
        try {
          planGate.setRequireConfirmEnabled(updated.planConfirmEnabled !== false);
          console.log('[LingYa] 计划确认开关已更新: ' + (updated.planConfirmEnabled !== false ? '开启' : '关闭'));
        } catch (e) {
          console.error('[LingYa] 同步计划确认开关失败:', e.message);
        }
      }
      return { success: true, config: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 重置安全配置
  ipcMain.handle('security-reset-config', async () => {
    try {
      const cfg = securityStore.resetConfig();
      try {
        planGate.setRequireConfirmEnabled(cfg.planConfirmEnabled !== false);
      } catch (_) {}
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

  // 手动触发拒绝改写：侧边栏按钮 → 转发给该窗口的 AI 视图执行 → 等待结果
  // 为什么走事件而不是直接调用：改写逻辑（本地规则 / 当前对话改写）全在 preload，
  // 主进程只负责路由意图。
  // I1：handler 返回 Promise 等待 AI 视图回传结果（带 requestId + 15s 超时），
  //     否则侧边栏会在 manualRewrite 实际失败时误报「已触发改写」。
  const manualRewritePending = new Map(); // requestId -> { resolve, timer }

  ipcMain.on('security-manual-rewrite-result', (_event, { requestId, result } = {}) => {
    const p = manualRewritePending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    manualRewritePending.delete(requestId);
    p.resolve(result || { success: false, error: '空结果' });
  });

  ipcMain.handle('security-manual-rewrite', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '未找到窗口上下文' };
      let target = null;
      try {
        if (ctx.view && ctx.view.webContents && !ctx.view.webContents.isDestroyed()) {
          target = ctx.view.webContents;
        } else if (ctx.win && ctx.win.webContents && !ctx.win.webContents.isDestroyed()) {
          target = ctx.win.webContents;
        }
      } catch (_) {}
      if (!target) return { success: false, error: 'AI 视图不可用' };

      const requestId = 'mr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const resultPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          manualRewritePending.delete(requestId);
          resolve({ success: false, error: '等待改写结果超时（15 秒）' });
        }, 15000);
        manualRewritePending.set(requestId, { resolve, timer });
      });

      target.send('lingya-manual-rewrite', { requestId });
      return await resultPromise;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // AI 改写拒绝回复（preload 检测到拒绝后调用）
  ipcMain.handle('security-rewrite-refusal', async (_event, { refusalText } = {}) => {
    try {
      const cfg = securityStore.getConfig();
      let ctfPrompt = (cfg.ctfPrompt || '').trim();
      if (!ctfPrompt && cfg.ctfInjectionEnabled) {
        const { PROMPT_DIR } = require('./project-context');
        const fs = require('fs');
        const path = require('path');
        const p = path.join(PROMPT_DIR, 'ctf.md');
        if (fs.existsSync(p)) ctfPrompt = fs.readFileSync(p, 'utf-8');
      }
      const text = await refusalRewriter.rewriteRefusal(refusalText || '', ctfPrompt);
      return { success: true, text };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 插件系统 ==========
  const pluginHost = require('./plugin-host');

  // 列出所有插件（含启用/加载状态）
  ipcMain.handle('plugin-list', async () => {
    try {
      return { success: true, plugins: pluginHost.listPlugins(), dir: pluginHost.getPluginsDir() };
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
      const res = pluginHost.importPlugin(buf);
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
}

module.exports = { registerIpcHandlers };
