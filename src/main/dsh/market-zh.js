/**
 * DSH 插件中文描述映射表
 *
 * npm 上只有英文 description，这里内置官方插件的中文翻译。
 * key = 完整包名（@deepseek-ai/dsh-xxx），value = 中文描述。
 * 未收录的包回退英文原文。
 */
const ZH = {
  // ===== 工具类（给 AI 加能力）=====
  '@deepseek-ai/dsh-tool-fs': '文件系统工具：读取 / 写入 / 编辑文件',
  '@deepseek-ai/dsh-tool-fs-search': '文件搜索工具：glob 查找 + grep 内容搜索（内置 ripgrep）',
  '@deepseek-ai/dsh-tool-web': '网页工具：网页搜索 web_search + 抓取 web_fetch',
  '@deepseek-ai/dsh-tool-bash': 'Bash 命令执行工具（支持后台任务与沙箱提权）',
  '@deepseek-ai/dsh-tool-bash-persistent': '持久 Bash 工具：命令间保留状态（cd、export 不丢）',
  '@deepseek-ai/dsh-tool-pwsh': 'PowerShell 命令执行工具（Windows）',
  '@deepseek-ai/dsh-tool-pwsh-persistent': '持久 PowerShell 工具：命令间保留状态',
  '@deepseek-ai/dsh-tool-terminal': '终端工具（6 个）：持久 PTY 终端，支持打开/发送/读取/关闭',
  '@deepseek-ai/dsh-tool-todo': '任务清单工具 todo_write：记录并追踪多步任务进度',
  '@deepseek-ai/dsh-tool-subagent': '子代理委派工具：把任务交给独立上下文的子代理执行',
  '@deepseek-ai/dsh-tool-subagent-control': '子代理控制工具：send_message / interrupt_agent / list_agents',
  '@deepseek-ai/dsh-tool-subagent-report': '子代理汇报工具：子代理向主对话回报结果',
  '@deepseek-ai/dsh-tool-skill': '技能加载工具：显式加载技能全文（skill）',
  '@deepseek-ai/dsh-tool-goal': '目标管理工具：创建/查询/更新长期目标（create_goal / get_goal / update_goal）',
  '@deepseek-ai/dsh-tool-schedule': '定时任务工具：创建/查询/更新/删除定时提醒（schedule_*）',
  '@deepseek-ai/dsh-tool-jobs': '后台任务工具：查看输出/列出/终止后台任务（job_output / job_list / job_kill）',
  '@deepseek-ai/dsh-tool-lsp': '语言服务器工具：跳转定义、查找引用等代码智能（lsp）',
  '@deepseek-ai/dsh-tool-workflow': '工作流工具：运行 JavaScript 编排脚本（workflow）',
  '@deepseek-ai/dsh-tool-ask-user': '主动提问工具：向用户提问并等待回答（ask_user_question）',
  '@deepseek-ai/dsh-tool-present': '交付物工具：声明向用户交付的工作区文件（present）',
  '@deepseek-ai/dsh-tool-working-directory': '工作目录工具：读取/切换当前会话的工作目录',
  '@deepseek-ai/dsh-tool-str-replace-editor': '字符串替换编辑器：查看/创建/唯一替换/按行插入',
  '@deepseek-ai/dsh-tool-session-query': '会话查询工具（5 个）：搜索/追溯历史会话事件',
  '@deepseek-ai/dsh-tool-cordis': 'Cordis 自省工具：检查运行时插件注册表（只读）',
  '@deepseek-ai/dsh-tool-ralph': 'Ralph 循环工具：固定的前台工作流，每轮启动全新子代理',
  '@deepseek-ai/dsh-tool-workspace-dependencies': '工作区依赖工具：加载打包的 Python/Node.js 依赖',
  '@deepseek-ai/dsh-tool-call-timeout-policy': '工具超时策略：为每次工具调用设置截止时间',

  // ===== 组合包（profile 预设）=====
  '@deepseek-ai/dsh-base': 'DSH 共享核心：所有 profile 的基础层（模型+工具+会话+安全默认值）',
  '@deepseek-ai/dsh-web-app': 'Web 组合包：浏览器界面 + 运行时（含 dsh-base）',
  '@deepseek-ai/dsh-acp-app': 'ACP 组合包：JSON-RPC stdio 自动化',
  '@deepseek-ai/dsh-sdk-app': 'SDK 组合包：stdio JSON-RPC 服务',
  '@deepseek-ai/dsh-sdk-minimal': '最小 SDK 组合包：JSON-RPC + 单个 DeepSeek 适配器',
  '@deepseek-ai/dsh-headless': '无头组合包：无界面运行',

  // ===== 搜索后端 =====
  '@deepseek-ai/dsh-web-search-deepseek': '网页搜索后端：DeepSeek 官方搜索',
  '@deepseek-ai/dsh-web-search-exa': '网页搜索后端：Exa AI',
  '@deepseek-ai/dsh-web-search-perplexity': '网页搜索后端：Perplexity',
  '@deepseek-ai/dsh-web-fetch-http': '网页抓取后端：HTTP 实现',

  // ===== 子代理后端 =====
  '@deepseek-ai/dsh-subagent-claude-code': '子代理后端：Claude Code',
  '@deepseek-ai/dsh-subagent-codex': '子代理后端：Codex',
  '@deepseek-ai/dsh-subagent-acp': '子代理后端：ACP 协议',
  '@deepseek-ai/dsh-subagent-dsh-sdk': '子代理后端：DSH SDK',

  // ===== 实验性（常用）=====
  '@deepseek-ai/dsh-experimental-tool-agent-team': '多代理协作：spawn_teammate / team_task_* 等 9 个工具',
  '@deepseek-ai/dsh-experimental-tool-worktree': 'Git worktree 工具：创建隔离的工作树',
  '@deepseek-ai/dsh-experimental-browser-use-stagehand-native': '浏览器自动化：Stagehand 驱动（浏览/提取/截图）',
  '@deepseek-ai/dsh-experimental-speech-to-text': '语音转文字',
  '@deepseek-ai/dsh-experimental-translator': '翻译',
  '@deepseek-ai/dsh-experimental-voice-input': '语音输入',
  '@deepseek-ai/dsh-experimental-auto-review': '自动代码审查',
  '@deepseek-ai/dsh-experimental-session-search': '会话搜索（实验）',
  '@deepseek-ai/dsh-experimental-terminal-bundle': '终端组合包（实验）',
  '@deepseek-ai/dsh-experimental-schedule-bundle': '定时任务组合包（实验）',

  // ===== 核心服务（说明用途，一般不单独装）=====
  '@deepseek-ai/dsh-session': '会话核心：事件流 + 投影（框架零件）',
  '@deepseek-ai/dsh-tools': '工具注册表核心（框架零件）',
  '@deepseek-ai/dsh-agent': 'Agent 核心（框架零件）',
  '@deepseek-ai/dsh-llm': '模型适配核心（框架零件）',
  '@deepseek-ai/dsh-mcp-client': 'MCP 客户端：连接外部 MCP server',
  '@deepseek-ai/dsh-mcp-resources': 'MCP 资源：读取 MCP server 资源',
  '@deepseek-ai/dsh-skill': '技能核心：扫描/加载技能',
  '@deepseek-ai/dsh-skill-filesystem': '技能来源：文件系统',
  '@deepseek-ai/dsh-skill-office': '技能来源：Office 文档',
  '@deepseek-ai/dsh-goal': '目标管理核心',
  '@deepseek-ai/dsh-schedule': '定时任务核心',
  '@deepseek-ai/dsh-jobs': '后台任务核心',
  '@deepseek-ai/dsh-terminal': '终端核心',
  '@deepseek-ai/dsh-lsp': '语言服务器核心',
  '@deepseek-ai/dsh-web': '网页能力核心',
  '@deepseek-ai/dsh-fs': '文件系统核心',
  '@deepseek-ai/dsh-shell': 'Shell 核心',
  '@deepseek-ai/dsh-plugin-manager': '插件管理器：列出/启用/禁用/安装插件',
  '@deepseek-ai/dsh-plan-mode': '规划模式：exit_plan_mode 工具',
};

/** 取中文描述；未收录返回 undefined */
function getZh(name) {
  return ZH[name] || undefined;
}

module.exports = { ZH, getZh };
