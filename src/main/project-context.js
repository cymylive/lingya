/**
 * 项目初始化：目录选择、系统提示词组合与发送
 * 由原 main.js 拆分而来，逻辑保持不变。
 */
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const windowState = require('./window');
const { toolRegistry } = require('./tool-registry');
const mcpClient = require('./mcp-client');
const memoryStore = require('./memory-store');
const skillStore = require('./skill-store');
const securityStore = require('./security-store');

// 提示词模板目录
const PROMPT_DIR = path.join(__dirname, '..', 'prompt');

/**
 * 同时输出到终端和对应平台的日志文件（与渲染进程日志同目录）
 */
function logWithFile(providerId, msg) {
  console.log(msg);
  try {
    if (!app.isPackaged) {
      const logDir = path.join(app.getPath('userData'), 'wyp', 'log');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, (providerId || 'default') + '.log');
      fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf-8');
    }
  } catch (_) {}
}

/**
 * 初始化项目：选择目录并发送 systemPrompt
 * 供 IPC 调用（用户点击初始化按钮时触发）
 * @param {boolean} skipPrompt - 如果为true，只更新目录映射，不发送初始提示（用于修改目录）
 * @param {object|null} windowContext - 窗口上下文
 * @param {string|null} presetDir - 预设项目目录（如压缩后自动初始化）。提供时跳过目录选择对话框。
 * @param {boolean} isCompaction - 是否为压缩后初始化（末尾追加"请继续你之前的工作"）
 */
async function initProject(skipPrompt = false, windowContext = null, presetDir = null, isCompaction = false) {
  const ctx = windowContext || windowState.getMainContext();
  const mainWindow = ctx ? ctx.win : windowState.getMainWindow();
  const sessionStore = ctx ? ctx.sessionStore : null;
  // providerId 来自窗口上下文（可能为空，表示未确定平台）
  const providerId = (ctx && ctx.providerId) || '';

  let selectedDir;
  if (presetDir) {
    // 预设目录（压缩后自动初始化）：直接用，不弹框
    selectedDir = presetDir;
    console.log('[LingYa] 使用预设目录（自动初始化）:', selectedDir);
  } else {
    // 先让用户选择目录
    const result = dialog.showOpenDialogSync(mainWindow, {
      properties: ['openDirectory'],
      buttonLabel: '选择目录',
      title: '请选择要分析的项目目录',
    });

    // 无论用户是否选择目录，对话框关闭后都恢复主窗口焦点（避免输入框失效）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }

    if (!result || result.length === 0) {
      console.log('[LingYa] 用户取消了目录选择');
      return { success: false, message: '用户取消了目录选择' };
    }
    selectedDir = result[0];
    console.log('[LingYa] 用户选择目录:', selectedDir);
  }
  const tStart = Date.now();
  const stepLog = (msg) => logWithFile(providerId, '[LingYa][耗时] ' + msg + ' +' + (Date.now() - tStart) + 'ms');

  // 保存选中的项目目录（若该窗口有独立的 sessionStore）
  if (sessionStore) {
    sessionStore.state.selectedProjectDir = selectedDir;

    // ========== 持久化存储会话-目录映射 ==========
    // 如果当前有会话ID，保存映射
    if (sessionStore.state.currentSessionId) {
      sessionStore.saveSessionDirMapping(sessionStore.state.currentSessionId, selectedDir);
      console.log(`[LingYa] 已保存会话 ${sessionStore.state.currentSessionId} -> ${selectedDir}`);
    } else {
      // 如果未能获取会话ID，尝试从当前URL提取
      let sessionId = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const url = mainWindow.webContents.getURL();
        sessionId = sessionStore.extractSessionIdFromUrl(url);
      }
      if (sessionId) {
        sessionStore.state.currentSessionId = sessionId;
        sessionStore.saveSessionDirMapping(sessionId, selectedDir);
        console.log(`[LingYa] 从URL提取会话ID并保存: ${sessionId} -> ${selectedDir}`);
      } else {
        // 无法获取会话ID，暂存项目目录，等待URL变化后绑定
        sessionStore.state.pendingProjectDir = selectedDir;
        console.log(`[LingYa] 暂存项目目录 ${selectedDir}，等待会话ID出现后绑定`);
      }
    }
  }

  stepLog('目录保存完成');
  // 发送目录更新事件到渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project-dir-updated', selectedDir);
  }

  // 如果只是修改目录，跳过发送初始提示
  if (skipPrompt) {
    return { success: true, message: '项目目录已更新' };
  }

  // 初始化项目时读取对应平台模板并替换占位符
  // 模板选择优先级：
  // 1. provider.getPromptTemplate() 返回的非空字符串
  // 2. src/prompt/{providerId}.md
  // 3. src/prompt/default.md
  const provider = require('../providers').getProvider(providerId);
  let templateContent = '';
  let templatePath = '';

  if (provider && typeof provider.getPromptTemplate === 'function') {
    try {
      const fromMethod = provider.getPromptTemplate();
      if (fromMethod && typeof fromMethod === 'string' && fromMethod.trim()) {
        templateContent = fromMethod;
        templatePath = '(provider.getPromptTemplate)';
      }
    } catch (err) {
      console.warn('[LingYa] 调用 provider.getPromptTemplate 失败:', err.message);
    }
  }

  if (!templateContent && providerId) {
    const candidate = path.join(PROMPT_DIR, providerId + '.md');
    if (fs.existsSync(candidate)) {
      templatePath = candidate;
    }
  }

  if (!templateContent && templatePath) {
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
    } catch (err) {
      console.error('[LingYa] 读取提示词模板失败:', err.message);
      return { success: false, message: '读取提示词模板失败: ' + err.message };
    }
  }

  if (!templateContent) {
    templatePath = path.join(PROMPT_DIR, 'default.md');
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
      console.warn('[LingYa] 未找到平台模板，使用默认模板:', templatePath);
    } catch (err) {
      console.error('[LingYa] 读取默认模板失败:', err.message);
      return { success: false, message: '读取默认提示词模板失败: ' + err.message };
    }
  }

  console.log('[LingYa] 已读取提示词模板:', templatePath);

  stepLog('读取模板完成');
  // 读取工具 API 类型定义（从 d.ts 文件读取，避免与模板重复维护）
  // 打包后文件位于 resources/tools/（asar 外），开发环境位于项目根 tools/
  // 注意：electron-builder 默认排除 *.d.ts 不进 asar，故通过 extraResources 复制
  let toolApiTypes = '';
  const toolApiTypePaths = [
    path.join(process.resourcesPath || '', 'tools', 'lingya-tools.d.ts'),
    path.join(__dirname, '..', '..', 'tools', 'lingya-tools.d.ts'),
  ];
  for (const p of toolApiTypePaths) {
    try {
      toolApiTypes = fs.readFileSync(p, 'utf-8');
      break;
    } catch (err) {
      // 继续尝试下一个候选路径
    }
  }
  if (!toolApiTypes) {
    console.error('[LingYa] 读取 lingya-tools.d.ts 失败：所有候选路径均不可读', toolApiTypePaths);
  }

  // 获取工具库描述（JS API 格式：AI 通过生成 JS 代码调用这些函数）
  const toolsDescription = toolRegistry.getFormattedJsApiForPrompt();

  // 获取工具使用指导（section 机制，仿 dsh）
  const promptSections = toolRegistry.getFormattedPromptSections();

  stepLog('工具描述生成完成');
  // 确保已启用的 MCP server 已连接（8 秒超时，避免阻塞初始化）
  try {
    await Promise.race([
      mcpClient.connectEnabledServers(),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);
  } catch (err) {
    console.error('[MCP] 初始化时连接失败:', err.message);
  }

  // MCP 章节：按需查看模式，不在提示词中全量注入工具列表
  const mcpSection = [
    '## MCP 能力',
    '',
    '本应用支持 MCP（Model Context Protocol）外部工具扩展。',
    '',
    '使用 MCP 前，请先查询可用能力：',
    '1. 调用 mcpListServers() 查看当前已配置的 MCP server 列表（含启用/连接状态）',
    '2. 调用 mcpGetTools(serverName) 查看指定 server 提供的工具和参数',
    '3. 确认后通过 mcpCall(server, tool, args) 调用具体工具',
    '',
    '注意：MCP server 可能未连接或未启用，以 mcpListServers() 的实时返回为准。'
  ].join('\n');

  // 长期记忆注入块（全局记忆，按 token 预算选择）
  let memorySection = '';
  try {
    memorySection = memoryStore.buildMemorySection({});
    console.log('[LingYa] 记忆注入块长度:', memorySection.length);
  } catch (err) {
    console.error('[LingYa] 构建记忆注入块失败:', err.message);
  }

  // 技能注入块（仅已启用技能，按 token 预算选择）
  let skillSection = '';
  try {
    skillSection = skillStore.buildSkillSection({});
    console.log('[LingYa] 技能注入块长度:', skillSection.length);
  } catch (err) {
    console.error('[LingYa] 构建技能注入块失败:', err.message);
  }

  // CTF 注入块（可选，由安全增强配置控制）
  let ctfSection = '';
  try {
    const secCfg = securityStore.getConfig();
    if (secCfg.ctfInjectionEnabled) {
      let ctfPrompt = (secCfg.ctfPrompt || '').trim();
      if (!ctfPrompt) {
        // 使用内置模板 src/prompt/ctf.md
        const ctfPath = path.join(PROMPT_DIR, 'ctf.md');
        if (fs.existsSync(ctfPath)) {
          ctfPrompt = fs.readFileSync(ctfPath, 'utf-8');
        }
      }
      if (ctfPrompt) {
        ctfSection = ctfPrompt;
        console.log('[LingYa] CTF 注入块长度:', ctfSection.length);
      }
    }
  } catch (err) {
    console.error('[LingYa] 构建 CTF 注入块失败:', err.message);
  }

  // 动态生成平台信息（不硬编码，根据实际运行环境）
  const platform = process.platform;
  const arch = process.arch;
  let platformInfo = '';
  if (platform === 'win32') {
    platformInfo = '- 操作系统：Windows（' + arch + '）\n  - bash 使用 cmd.exe（Windows 命令：cd / dir / echo %cd% / type / findstr）\n  - pwsh 使用 PowerShell（Get-Location / $env:VAR / Get-ChildItem）\n  - 路径分隔符为反斜杠 \\，传给工具的相对路径统一用正斜杠 /';
  } else if (platform === 'darwin') {
    platformInfo = '- 操作系统：macOS（' + arch + '）\n  - bash 使用 zsh/bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
  } else {
    platformInfo = '- 操作系统：Linux（' + arch + '）\n  - bash 使用 bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
  }

  // 读取项目介绍（LINGYA.md）
  let projectIntro = '';
  const lingyaMdPath = path.join(selectedDir, '.lingyaCode', 'LINGYA.md');
  if (fs.existsSync(lingyaMdPath)) {
    try {
      projectIntro = fs.readFileSync(lingyaMdPath, 'utf-8');
      console.log('[LingYa] 已读取 LINGYA.md 内容');
    } catch (err) {
      console.error('[LingYa] 读取 LINGYA.md 失败:', err.message);
    }
  }

  // 项目介绍占位符：无内容则整体置空
  const projectIntroSection = projectIntro
    ? '---\n## 项目介绍\n' + projectIntro
    : '';

  // 统一替换模板中的双花括号占位符（全量替换，支持同一占位符多次出现）
  const placeholders = {
    '{{TOOL_API_TYPES}}': toolApiTypes,
    '{{TOOLS_LIST}}': toolsDescription,
    '{{TOOL_SECTIONS}}': promptSections,
    '{{PLATFORM_INFO}}': platformInfo,
    '{{PROJECT_DIR}}': selectedDir,
    '{{PROJECT_INTRO_SECTION}}': projectIntroSection,
    '{{MCP_SECTION}}': mcpSection,
    '{{MEMORY_SECTION}}': memorySection,
    '{{SKILL_SECTION}}': skillSection,
    '{{CTF_SECTION}}': ctfSection,
  };
  let combined = templateContent;
  for (const [key, value] of Object.entries(placeholders)) {
    combined = combined.split(key).join(value);
  }

  // 压缩后初始化：末尾追加提示，让 AI 接着之前的工作继续
  if (isCompaction) {
    combined += '\n\n---\n\n请继续你之前的工作';
  }

  stepLog('提示词组装完成');
  console.log('[LingYa] 准备发送初始提示（不含目录树），长度:', combined.length);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('initial-prompt', combined);
  }
  stepLog('initial-prompt 已发送');

  return { success: true, message: '初始化完成，已发送系统提示词、工具规则和工具库' };
}

module.exports = { PROMPT_DIR, initProject };
