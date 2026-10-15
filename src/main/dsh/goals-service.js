/**
 * DSH 兼容层 - ctx.goals 服务（CommonJS）
 *
 * 对齐 dsh-tool-goal 需要的 goals 服务：get/create/edit/pause/resume/complete/block。
 * 目标状态按 agent 存储（内存 + 可选落盘）。
 */

let _goalSeq = 0;
function nextGoalId() { return 'goal-' + (++_goalSeq) + '-' + Date.now().toString(36); }

/** 按 agent 隔离的目标存储 */
class GoalsService {
  constructor(onChange) {
    this._byAgent = new Map();   // agentId -> goal
    this._onChange = onChange || null;
  }

  _key(agent) { return agent && agent.id ? agent.id : '__none'; }

  /** 取某 agent 的当前目标（无则 undefined） */
  get(agent) {
    return this._byAgent.get(this._key(agent));
  }

  /** 创建目标（对齐 ctx.goals.create） */
  create(agent, input) {
    const goal = {
      id: nextGoalId(),
      revision: 1,
      objective: String((input && input.objective) || ''),
      maxGoalRounds: (input && input.maxGoalRounds) || undefined,
      status: 'active',
      round: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._byAgent.set(this._key(agent), goal);
    this._fire(agent, goal, 'create');
    return goal;
  }

  edit(agent, patch) {
    const g = this.get(agent);
    if (!g) return undefined;
    if (patch && patch.objective !== undefined) g.objective = String(patch.objective);
    if (patch && patch.maxGoalRounds !== undefined) g.maxGoalRounds = patch.maxGoalRounds;
    g.revision++;
    g.updatedAt = Date.now();
    this._fire(agent, g, 'edit');
    return g;
  }

  pause(agent) { return this._setStatus(agent, 'paused', 'pause'); }
  resume(agent) { return this._setStatus(agent, 'active', 'resume'); }
  complete(agent) { return this._setStatus(agent, 'completed', 'complete'); }
  block(agent, reason) {
    const g = this._setStatus(agent, 'blocked', 'block');
    if (g) g.blockedReason = reason;
    return g;
  }

  _setStatus(agent, status, action) {
    const g = this.get(agent);
    if (!g) return undefined;
    g.status = status;
    g.revision++;
    g.updatedAt = Date.now();
    this._fire(agent, g, action);
    return g;
  }

  _fire(agent, goal, action) {
    try {
      if (agent && agent.session && agent.session.append) {
        agent.session.append('goal/change', { action, goal });
      }
      if (this._onChange) this._onChange(agent, goal, action);
    } catch (_) {}
  }
}

module.exports = { GoalsService };
