/**
 * Agent 模式面板：Plan / Build 双模式切换
 * 移植自 opencode 的 agent 系统，状态由主进程 agent-store 持久化（per-profile）。
 */
const { showToast } = require('./ui');

function el(id) {
  return document.getElementById(id);
}

let currentAgentId = 'build';
let agentDefs = [];

/**
 * 渲染切换按钮（高亮当前 agent）
 */
function renderAgentSwitch() {
  const container = el('lingya-agent-switch');
  if (!container) return;
  const btns = container.querySelectorAll('.lingya-agent-btn');
  btns.forEach((btn) => {
    btn.classList.toggle('lingya-agent-btn-active', btn.dataset.agent === currentAgentId);
  });

  // 提示条
  const hint = el('lingya-agent-hint');
  if (hint) {
    const def = agentDefs.find((a) => a.id === currentAgentId);
    if (def) {
      hint.textContent = def.description;
      hint.classList.toggle('lingya-agent-plan', currentAgentId === 'plan');
    }
  }
}

/**
 * 从主进程加载 agent 定义与当前值
 */
async function loadAgents() {
  try {
    const res = await window.electronAPI.listAgents();
    if (res && res.success) {
      agentDefs = res.agents || [];
      currentAgentId = res.current || 'build';
      renderAgentSwitch();
    }
  } catch (err) {
    console.error('[AgentPanel] 加载失败:', err.message);
  }
}

/**
 * 切换 agent
 * @param {string} agentId
 */
async function switchAgent(agentId) {
  if (agentId === currentAgentId) return;
  try {
    const res = await window.electronAPI.setAgent(agentId);
    if (!res || !res.success) {
      showToast('切换失败：' + ((res && res.error) || '未知错误'), 3000);
      return;
    }
    currentAgentId = res.agentId;
    renderAgentSwitch();
    const def = agentDefs.find((a) => a.id === currentAgentId);
    const label = def ? def.name : currentAgentId;
    showToast('已切换到 ' + label + ' 模式', 2500);
    if (currentAgentId === 'plan') {
      showToast('Plan 模式：写/改/删工具已禁用，AI 只会产出计划', 4000);
    }
  } catch (err) {
    showToast('切换失败：' + err.message, 3000);
  }
}

/**
 * 绑定 agent 面板事件
 */
function bindAgentPanelEvents() {
  const container = el('lingya-agent-switch');
  if (!container) return;
  container.querySelectorAll('.lingya-agent-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchAgent(btn.dataset.agent));
  });
  loadAgents();
}

module.exports = { bindAgentPanelEvents, loadAgents, switchAgent };
