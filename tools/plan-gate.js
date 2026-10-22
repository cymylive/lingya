/**
 * 计划门禁（Plan Gate）：保证多步任务先建立计划再执行。
 *
 * 规则：
 * - 只有"写类工具"受门禁约束（write/edit/delete/bash/pwsh/bash_background）
 * - 只读 bash（ls/cat/git status 等）放行 —— 探索是建计划的前提
 * - 每个会话在建立计划前，最多被拦一次；第二次直接放行
 *   （避免单步任务被卡死，也避免 AI 死循环重试）
 * - AI 调用 todoWrite 后立即解除门禁
 *
 * 状态按会话隔离（键优先级 sessionId > profileId > __default），与 todo 存储一致。
 */
const { inspectCommand } = require('./readonly-guard');

// 受门禁约束的写类工具
const WRITE_TOOLS = new Set([
  'write', 'file_write',
  'edit', 'file_edit',
  'file_delete',
  'bash', 'pwsh',
  'bash_background',
]);

// ===== 计划执行前人工确认 =====
// 需求：AI 制定计划后不要立即执行，等用户在计划面板点「确认执行」或回复确认。
//
// 默认关闭（向后兼容）——主进程启动时根据用户设置调用 setRequireConfirmEnabled()。
// 生产环境默认开启（设置项 planConfirm 缺省即视为 true）。
let requireConfirmEnabled = false;

/** 全局开关（主进程启动时调用一次） */
function setRequireConfirmEnabled(v) {
  requireConfirmEnabled = !!v;
}

function isRequireConfirmEnabled() {
  return requireConfirmEnabled;
}

// key -> { established, warned, confirmed, requireConfirm }
const gates = new Map();

function keyOf(sessionId, profileId) {
  return sessionId || profileId || '__default';
}

function getGate(sessionId, profileId) {
  const k = keyOf(sessionId, profileId);
  let g = gates.get(k);
  if (!g) {
    g = {
      established: false,
      warned: false,
      confirmed: false,
      // 初始值取自全局开关；setRequireConfirm() 可覆盖单个会话
      requireConfirm: requireConfirmEnabled,
    };
    gates.set(k, g);
  }
  return g;
}

/**
 * 标记该会话已建立计划。
 * 若该会话要求确认（requireConfirm=true），则 confirmed 置 false，等待用户确认；
 * 否则直接视为已确认（原有行为，不阻塞）。
 */
function markEstablished(sessionId, profileId) {
  const g = getGate(sessionId, profileId);
  const wasEstablished = g.established;
  g.established = true;
  // 【关键】只在「首次建立计划」时决定是否需要确认。
  // 后续 todoWrite（更新进度）不能再重置 confirmed ——
  // 否则用户确认过的计划，AI 每更新一次进度就又变回「等待确认」，永远执行不了。
  if (!wasEstablished) {
    g.confirmed = !g.requireConfirm;
  }
}

/**
 * 设置某会话是否需要「执行前确认」。
 * 供测试与按会话差异化场景使用；生产环境的默认值走 setRequireConfirmEnabled()。
 */
function setRequireConfirm(sessionId, profileId, v) {
  getGate(sessionId, profileId).requireConfirm = !!v;
}

/** 用户确认执行（点按钮 / 回复确认关键词后调用） */
function markConfirmed(sessionId, profileId) {
  getGate(sessionId, profileId).confirmed = true;
}

/** 是否正在等待用户确认（已建计划但尚未确认） */
function isAwaitingConfirm(sessionId, profileId) {
  const g = gates.get(keyOf(sessionId, profileId));
  if (!g) return false;
  return !!(g.established && g.requireConfirm && !g.confirmed);
}

/** 检查是否放行。返回 { allowed: bool, error?: string } */
function checkGate(toolName, params, sessionId, profileId) {
  if (!WRITE_TOOLS.has(toolName)) return { allowed: true };
  // 无任何会话标识 → 程序化调用（测试/内部），不施加门禁。
  // 真实 AI 调用必带 profileId（多窗口架构），故不会绕过。
  if (!sessionId && !profileId) return { allowed: true };

  // bash/pwsh：只读命令放行
  if (toolName === 'bash' || toolName === 'pwsh') {
    const cmd = String((params && params.command) || '').trim();
    if (!cmd) return { allowed: true };
    try {
      const guard = inspectCommand(cmd);
      if (!guard.write) return { allowed: true };
    } catch (_) { /* 判断失败 → 按写操作处理 */ }
  }

  const g = getGate(sessionId, profileId);
  if (g.established) {
    // 计划已建立，但要求用户确认且尚未确认 → 继续拦截
    if (g.requireConfirm && !g.confirmed) {
      return {
        allowed: false,
        error: '【等待确认】任务计划已建立，正在等待用户确认执行。' +
          '请不要继续调用任何工具（否则会被反复拒绝）。' +
          '请向用户展示计划要点，并明确说明「计划已就绪，请点击计划面板的【确认执行】按钮，或回复「确认执行」」。' +
          '用户确认后你会收到新的指令，届时再继续执行。',
      };
    }
    return { allowed: true };
  }
  if (g.warned) return { allowed: true }; // 已提示过一次，放行（兜底单步任务 / 防死循环）

  g.warned = true;
  return {
    allowed: false,
    error: '【计划门禁】你尚未建立任务计划。若本任务需要 2 步及以上，请先调用 todoWrite 建立完整计划，' +
      '然后再执行写操作。若确实是单步任务、无需计划，请直接再次调用本工具，将被放行。',
  };
}

/** 清空某会话门禁状态（测试/重置用） */
function resetGate(sessionId, profileId) {
  gates.delete(keyOf(sessionId, profileId));
}

module.exports = {
  checkGate,
  markEstablished,
  markConfirmed,
  setRequireConfirm,
  isAwaitingConfirm,
  setRequireConfirmEnabled,
  isRequireConfirmEnabled,
  resetGate,
  WRITE_TOOLS,
  keyOf,
};
