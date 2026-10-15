/**
 * DSH 兼容层 - 最小 Agent 运行时（CommonJS）
 *
 * 让依赖 agent 生命周期的 DSH 插件（goal/todo/subagent 等）能真正执行。
 *
 * 从 dsh-tool-goal 源码提取的必需接口：
 *   exec.agent                         → { id, status:'running', session:{ events } }
 *   ctx.agents.get(agent.id) === agent
 *   ctx.agents.currentInitiator() === agent
 *   ctx.agents.roots()                 → 根 agent 列表
 *   agent.session.events               → 事件流（turn/start 作边界）
 *   agent.session.append(type, data)   → 追加事件
 *
 * 事件类型（对齐 dsh-session）：
 *   turn/start  {  }                     模型回合开始
 *   turn/end    {  }                     模型回合结束
 *   user/message { source: { kind:'user'|'goal', goalId? }, content }
 *   tool/call, tool/result, todo/write, goal/change ...
 */

let _seq = 0;
function nextId(prefix) { return prefix + '-' + (++_seq) + '-' + Date.now().toString(36); }

/** 一条会话事件 */
class SessionLog {
  constructor(agentId) {
    this.agentId = agentId;
    this.events = [];
    this._listeners = new Set();
  }
  append(type, data) {
    const ev = { type, data: data || {}, at: Date.now() };
    this.events.push(ev);
    for (const fn of this._listeners) { try { fn(ev); } catch (_) {} }
    return ev;
  }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  /** 当前打开的 turn 窗口（对齐 dsh-tool-goal 的 openTurn） */
  openTurn() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const b = this.events[i];
      if (b.type === 'turn/end') return null;
      if (b.type === 'turn/start') return { start: b, events: this.events.slice(i + 1) };
    }
    return null;
  }
}

/** 一个 agent 句柄 */
class Agent {
  constructor(id, opts) {
    this.id = id || nextId('agent');
    this.status = 'running';
    this.kind = (opts && opts.kind) || 'root';
    this.name = (opts && opts.name) || this.id;
    this.session = new SessionLog(this.id);
    // session.header：对齐 dsh-session（skill 插件读 header.cwd）
    this.session.header = {
      cwd: (opts && opts.cwd) || process.cwd(),
      agentId: this.id,
    };
  }
  followup(msg) { this.session.append('user/message', { source: { kind: 'user' }, content: msg }); }
  steer(msg) { return this.followup(msg); }
}

/** Agent 注册表（对齐 ctx.agents） */
class AgentRegistry {
  constructor() {
    this._agents = new Map();
    this._initiator = null;   // 当前活跃的发起者（root agent）
  }
  /** 创建一个 root agent 并设为当前发起者 */
  createRoot(name) {
    const a = new Agent(null, { kind: 'root', name: name || 'root' });
    this._agents.set(a.id, a);
    this._initiator = a;
    return a;
  }
  register(agent) { this._agents.set(agent.id, agent); return agent; }
  get(id) { return this._agents.get(id); }
  currentInitiator() { return this._initiator; }
  roots() { return [...this._agents.values()].filter((a) => a.kind === 'root'); }
  list() { return [...this._agents.values()]; }
  /** 把某 agent 设为当前发起者（插件调用前由宿主设置） */
  setInitiator(agent) { this._initiator = agent; }
}

/** 运行时单例（一次加载流程用一份） */
class DshAgentRuntime {
  constructor() {
    this.agents = new AgentRegistry();
    this.root = this.agents.createRoot('lingya-root');
  }
  /** 开一个新 turn（返回 agent，供 exec 用） */
  openTurn(source) {
    const a = this.root;
    a.session.append('turn/start', {});
    a.session.append('user/message', { source: source || { kind: 'user' }, content: '' });
    this.agents.setInitiator(a);
    return a;
  }
  /** 结束当前 turn */
  closeTurn() {
    this.root.session.append('turn/end', {});
  }
}

module.exports = { DshAgentRuntime, Agent, AgentRegistry, SessionLog, nextId };
