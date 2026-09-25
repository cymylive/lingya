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

function registerIpcHandlers() {
  // 初始化项目
  ipcMain.handle('init-project', async (event, { skipPrompt = false, projectDir = null, isCompaction = false } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    return initProject(skipPrompt, ctx, projectDir, isCompaction);
  });

  // 列出会话
  ipcMain.handle('list-sessions', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || !store.state.selectedProjectDir) {
      return { success: true, sessions: [] };
    }
    const all = store.readSessionStore();
    const sessions = Object.keys(all).filter(id => all[id] === store.state.selectedProjectDir);
    return { success: true, sessions };
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
    const agent = getAgent(agentStore.getAgentId(profileId));
    if ((agent.deniedTools || []).includes(toolName)) {
      return {
        callId,
        success: false,
        error: '当前 Agent 模式禁止使用工具 "' + toolName + '"（只读/规划模式）。请在回复中输出实现计划，由用户批准后切换到 Build 模式执行。',
      };
    }
    try {
      const result = await toolRegistry.execute(toolName, {
        ...params,
        projectDir: selectedDir,
        readonlyShell: !!agent.readonlyShell,
      });
      return { callId, success: result.success, data: result.data, error: result.error };
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
  ipcMain.handle('abort-execution', async () => {
    const killed = activeProcesses.killAll();
    activeProcesses.markAborted();
    return { success: true, killed };
  });

  // 用户下次发消息时清除中止标志，恢复正常执行
  ipcMain.handle('clear-abort', async () => {
    activeProcesses.clearAborted();
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
    const agent = getAgent(agentStore.getAgentId(profileId));
    try {
      const result = await jsRunner.run(code, selectedDir, {
        deniedTools: agent.deniedTools,
        readonlyShell: !!agent.readonlyShell,
      });
      return { callId, ...result };
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
      return { success: true, config: securityStore.resetConfig() };
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
}

module.exports = { registerIpcHandlers };
