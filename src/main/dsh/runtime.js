/**
 * DSH 兼容层 - 最小运行时（CommonJS 版，移植自 cuckoo-code）
 *
 * 简化自 DSH 的 dsh-session / dsh-session-projection：
 *  - 内存事件流：append(type, data) → 存 + 驱动所有投影
 *  - 投影注册表：register({key,init,apply,view}) → get(key) 读视图
 *
 * 不做：checkpoint / watermark / change feed（DSH 的性能优化，用不着）。
 */

/** 内存会话：事件流 + 投影驱动的载体 */
class MemorySession {
  constructor(id, registry) {
    this.id = id;
    this.events = [];
    this._registry = registry;
    this._storage = null;
  }

  /** 接持久化：加载时读回历史事件重放；后续 append 同时落盘 */
  attachStorage(storage) {
    this._storage = storage;
    try {
      for (const ev of storage.readAll()) {
        if (ev && typeof ev.type === 'string') {
          this.events.push(ev);
          this._registry.drive(ev);
        }
      }
    } catch (_) { /* ignore */ }
  }

  /** 追加事件（对应 DSH 的 session.append） */
  append(type, data) {
    const ev = { type, data };
    this.events.push(ev);
    this._registry.drive(ev);
    if (this._storage) {
      try { this._storage.append(ev); } catch (_) { /* ignore */ }
    }
  }
}

/** 会话投影注册表（对应 DSH 的 ctx.sessionProjections） */
class ProjectionRegistry {
  constructor() {
    this._defs = new Map();
    this._states = new Map();
    this._history = [];
  }

  /** 注册一个投影 */
  register(def) {
    if (!def || typeof def.key !== 'string') throw new Error('projection: key 必须是字符串');
    this._defs.set(def.key, def);
    let state = typeof def.init === 'function' ? def.init({}) : null;
    // lazily build：投影后注册时，fold 已有历史事件
    for (const ev of this._history) {
      try { state = def.apply(state, ev); } catch (_) { /* ignore */ }
    }
    this._states.set(def.key, state);
    return () => { this._defs.delete(def.key); this._states.delete(def.key); };
  }

  /** 驱动所有投影（内部） */
  drive(event) {
    this._history.push(event);
    for (const [key, def] of this._defs) {
      try {
        const prev = this._states.get(key);
        const next = def.apply(prev, event);
        this._states.set(key, next);
      } catch (err) {
        console.error('[DSH投影] ' + key + ' apply 失败:', err && err.message);
      }
    }
  }

  /** 读某投影的视图 */
  get(key) {
    const def = this._defs.get(key);
    if (!def) return undefined;
    const state = this._states.get(key);
    return typeof def.view === 'function' ? def.view(state) : state;
  }

  has(key) { return this._defs.has(key); }
}

/** DSH 运行时（每个插件加载时创建一份） */
class DshRuntime {
  constructor(sessionId) {
    this.projections = new ProjectionRegistry();
    this.session = new MemorySession(sessionId || 'lingya-dsh-session', this.projections);
  }
}

module.exports = { DshRuntime, MemorySession, ProjectionRegistry };
