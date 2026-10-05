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

// key -> { established: bool, warned: bool }
const gates = new Map();

function keyOf(sessionId, profileId) {
  return sessionId || profileId || '__default';
}

function getGate(sessionId, profileId) {
  const k = keyOf(sessionId, profileId);
  let g = gates.get(k);
  if (!g) { g = { established: false, warned: false }; gates.set(k, g); }
  return g;
}

/** 标记该会话已建立计划（解除门禁） */
function markEstablished(sessionId, profileId) {
  getGate(sessionId, profileId).established = true;
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
  if (g.established) return { allowed: true };
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

module.exports = { checkGate, markEstablished, resetGate, WRITE_TOOLS, keyOf };
