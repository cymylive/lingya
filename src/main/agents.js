/**
 * Agent 系统 — 内置 Agent 定义（移植自 opencode 的 agent/permission 模型）
 *
 * 设计：
 *   - build：默认 agent，拥有全部工具权限
 *   - plan：规划 agent，禁用所有「写/改/删」类工具（对齐 opencode plan 的 edit deny）
 *
 * deniedTools 同时作用于三处：
 *   1. 系统提示词中的工具清单（project-context 过滤）
 *   2. 工具使用指导 section（ToolRegistry 过滤）
 *   3. 执行层（JsRunner.hostBridge 硬拒绝）—— 决定性防线
 */

const AGENTS = {
  build: {
    id: 'build',
    name: 'Build',
    icon: '🔨',
    description: '默认模式。可读写文件、执行命令、完成实现任务。',
    deniedTools: [],
    readonlyShell: false,
    section: [
      '## 当前模式：Build（构建）',
      '',
      '你处于 **Build 模式**，拥有完整的工具权限：可以读取、创建、修改、删除文件，可以执行命令。',
      '直接执行用户的请求，主动使用工具完成实现、调试和验证。',
    ].join('\n'),
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    icon: '📋',
    description: '规划模式。只读探索，禁用写/改/删工具，产出的方案需用户批准后再实现。',
    // 对齐 opencode：plan agent 禁用 edit 类工具（write / edit / apply_patch 等）
    deniedTools: ['write', 'file_write', 'edit', 'file_edit', 'file_delete'],
    // 方案 B：bash / pwsh 只放行只读命令，写操作在守卫层被拦截
    readonlyShell: true,
    section: [
      '## 当前模式：Plan（规划）',
      '',
      '你处于 **Plan 模式**，这是一个**只读的规划阶段**。',
      '',
      '可用能力：',
      '- ✅ 读取文件（read / readLines）、搜索（glob / grep）',
      '- ✅ 执行**只读**命令（bash / pwsh，如 ls / cat / dir / type / git status / git log / git diff）',
      '- ✅ 分析代码、设计方案、梳理步骤',
      '- ❌ **禁止**创建/修改/删除任何文件（write / edit / deleteFile 会被系统硬性拒绝）',
      '- ❌ **禁止**在 bash / pwsh 中使用写操作（重定向 > >>、rm/cp/mv/mkdir/del/copy、git add/commit/push、npm install、sed -i 等会被守卫拦截）',
      '',
      '工作方式：',
      '1. 先充分探索代码库，理解现状与约束',
      '2. 产出一份清晰的实现计划（步骤、涉及文件、关键决策、风险点）',
      '3. 把计划呈现给用户，等待用户确认',
      '4. 用户批准后，请提示用户切换到 **Build 模式** 来落地实现',
      '',
      '如果你尝试调用被禁用的工具，会收到系统拒绝错误 —— 这是预期行为，请改为输出文字计划。',
    ].join('\n'),
  },
};

const DEFAULT_AGENT_ID = 'build';

/** 所有 agent 的 id 列表 */
function listAgentIds() {
  return Object.keys(AGENTS);
}

/** 获取 agent 定义（未知 id 回退到默认） */
function getAgent(agentId) {
  if (agentId && AGENTS[agentId]) return AGENTS[agentId];
  return AGENTS[DEFAULT_AGENT_ID];
}

/** 获取所有 agent 的公开信息（用于前端渲染切换按钮） */
function listAgents() {
  return Object.values(AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    description: a.description,
  }));
}

module.exports = { AGENTS, DEFAULT_AGENT_ID, listAgentIds, getAgent, listAgents };
