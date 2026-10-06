/**
 * 工具生命周期追踪器
 *
 * 目的：给每次工具调用分配一个「本模块自己的 ID」，工具用完后标记完成，
 * 后续扫描只清理「本模块登记过、且已完成」的条目，释放其持有的大对象。
 *
 * 严格约束（用户要求）：
 *  1. ID 由本模块分配，不复用外部传入的 callId —— 避免误清别人的对象。
 *  2. 只清理 entries 里登记过的 ID；外部 ID 一概不碰。
 *  3. 按会话隔离：sessionKey = profileId::sessionId，可只清某个会话。
 *  4. 已完成的条目超过 TTL 后才释放，避免影响正在返回途中的结果。
 */

const DEFAULT_TTL = 2000;   // 完成后多久释放（毫秒）
const MAX_ENTRIES = 500;    // 条目上限，超过时强制清理最老的已完成条目

let seq = 0;
const entries = new Map(); // id -> entry

function nextId() {
  seq += 1;
  return 'tl_' + Date.now().toString(36) + '_' + seq.toString(36);
}

/**
 * 登记一次工具调用。
 * @param {string} sessionKey 会话隔离键（profileId::sessionId）
 * @param {string} toolName 工具名（仅用于诊断）
 * @returns {string} 本模块分配的 ID
 */
function register(sessionKey, toolName) {
  const id = nextId();
  entries.set(id, {
    id,
    sessionKey: sessionKey || 'global',
    toolName: toolName || 'unknown',
    status: 'running',
    createdAt: Date.now(),
    doneAt: null,
    holder: null,
  });
  // 防无限增长：超过上限时强制清理最老的已完成条目
  if (entries.size > MAX_ENTRIES) {
    sweep(0, true);
  }
  return id;
}

/**
 * 绑定本次调用产生的「可释放对象」（调用方持有引用，本模块只记录，不复制）。
 * @returns {boolean} 是否为本模块登记的 ID
 */
function attach(id, holder) {
  const e = entries.get(id);
  if (!e) return false; // 非本模块登记的 ID：忽略，绝不清理
  e.holder = holder || null;
  return true;
}

/**
 * 标记某次调用完成。
 * @returns {boolean} 是否为本模块登记的 ID
 */
function markDone(id) {
  const e = entries.get(id);
  if (!e) return false; // 非本模块登记的 ID：忽略
  e.status = 'done';
  e.doneAt = Date.now();
  return true;
}

/** 释放条目持有的大对象（只清本模块 attach 进来的引用） */
function release(e) {
  const h = e.holder;
  if (h) {
    try { if (h.data) h.data = null; } catch (_) {}
    try { if (h.output) h.output = ''; } catch (_) {}
    try { if (h.images) h.images = []; } catch (_) {}
  }
  e.holder = null;
}

/**
 * 扫描并清理已完成的条目（仅本模块登记的）。
 * @param {number} ttlMs 完成后多久才清理，默认 DEFAULT_TTL
 * @param {boolean} force true 时忽略 TTL（仅用于超限保护）
 * @returns {number} 清理数量
 */
function sweep(ttlMs, force) {
  const ttl = typeof ttlMs === 'number' ? ttlMs : DEFAULT_TTL;
  const now = Date.now();
  let cleaned = 0;
  const doneList = [...entries.values()]
    .filter((e) => e.status === 'done')
    .sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  for (const e of doneList) {
    if (force && (entries.size - cleaned) <= MAX_ENTRIES) break;
    const expired = force ? true : (now - (e.doneAt || 0) >= ttl);
    if (expired) {
      release(e);
      entries.delete(e.id);
      cleaned += 1;
    }
  }
  return cleaned;
}

/**
 * 只清理指定会话的已完成条目。
 * @returns {number} 清理数量
 */
function sweepSession(sessionKey, ttlMs) {
  const ttl = typeof ttlMs === 'number' ? ttlMs : 0;
  const now = Date.now();
  let cleaned = 0;
  for (const [id, e] of entries) {
    if (e.sessionKey !== sessionKey) continue; // 会话隔离：别的会话不碰
    if (e.status !== 'done') continue;
    if (now - (e.doneAt || 0) >= ttl) {
      release(e);
      entries.delete(id);
      cleaned += 1;
    }
  }
  return cleaned;
}

/** 统计（供诊断） */
function stats() {
  let running = 0, done = 0;
  const bySession = {};
  for (const e of entries.values()) {
    if (e.status === 'running') running += 1; else done += 1;
    bySession[e.sessionKey] = (bySession[e.sessionKey] || 0) + 1;
  }
  return { total: entries.size, running, done, bySession };
}

module.exports = { register, attach, markDone, sweep, sweepSession, stats };
