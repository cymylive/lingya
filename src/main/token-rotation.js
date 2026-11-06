/**
 * 跨窗口 Token 轮转 · 核心模块（主进程）
 *
 * 职责：
 *   1. 配置持久化（<storeDir>/token-rotation.json）
 *   2. 从窗口池中选出下一个目标窗口（纯函数 selectNextIndex）
 *   3. 迁移中继：submit 派发 → ack 回执 → 超时看门狗
 *   4. 候选窗口列表构建（buildCandidates）
 *
 * 不做的事：
 *   - 不直接操作目标窗口的 localStorage
 *   - 不直接删除任何会话（删旧会话永远由源窗口在 ack 成功后执行）
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 默认配置 */
const DEFAULT_CONFIG = {
  // 是否启用跨窗口轮转。关闭时行为与今天完全一致（走原地迁移）。
  enabled: false,
  // 阈值，单位「万 token」。10 表示 10 万 token。
  // 注意：与既有的 lingya-auto-compact-threshold（80 万）互不干扰，
  // 轮转启用时用本阈值判定，未启用时用原阈值。
  thresholdWan: 10,
  // 窗口池：[{ profileId, accountTag, enabled }]
  pool: [],
  // 环形游标：下一次从 pool[cursor] 之后开始找目标
  cursor: 0,
  // 连续轮转次数上限，防止死循环
  maxRotations: 5,
  // 单会话时长上限（小时）
  maxSessionHours: 4,
  // 是否优先选择不同账号的窗口
  preferDifferentAccount: true,
  // 目标窗口忙时最多等待多久（毫秒）
  targetBusyWaitMs: 60000,
  // 迁移载荷（历史 Markdown）字节上限，默认 2MB
  historyMaxBytes: 2097152,
};

/** 数值字段的归一化配置：{ 最小值 } */
const NUMERIC_FIELDS = {
  thresholdWan: { min: 1 },
  cursor: { min: 0 },
  maxRotations: { min: 1 },
  maxSessionHours: { min: 1 },
  targetBusyWaitMs: { min: 1 },
  historyMaxBytes: { min: 1 },
};

const BOOLEAN_FIELDS = ['enabled', 'preferDifferentAccount'];

let STORE_FILE = null;
let cache = null;

/**
 * 初始化存储位置。
 * @param {string} storeDir 数据目录
 */
function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'token-rotation.json');
  cache = null;
  console.log('[Rotation] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

/**
 * 归一化数值字段：非有限数或小于下限 → 回落默认值。
 */
function normalizeNumeric(value, fallback, min) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * 归一化窗口池：必须是数组；元素缺 profileId 的丢弃；
 * accountTag 转字符串（缺省空串）；enabled 严格布尔（缺省 true）。
 */
function normalizePool(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const profileId = item.profileId == null ? '' : String(item.profileId);
    if (!profileId) continue;
    out.push({
      profileId,
      accountTag: item.accountTag == null ? '' : String(item.accountTag),
      enabled: item.enabled !== false,
    });
  }
  return out;
}

/**
 * 把任意输入归一化成合法配置对象。以 DEFAULT_CONFIG 为底，逐字段覆盖。
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_CONFIG };

  for (const [key, { min }] of Object.entries(NUMERIC_FIELDS)) {
    out[key] = normalizeNumeric(src[key], DEFAULT_CONFIG[key], min);
  }
  for (const key of BOOLEAN_FIELDS) {
    out[key] = src[key] === true;
  }
  out.pool = normalizePool(src.pool);
  return out;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const text = fs.readFileSync(STORE_FILE, 'utf-8');
      const parsed = JSON.parse(text);
      cache = normalizeConfig(parsed);
      return cache;
    }
  } catch (err) {
    console.error('[Rotation] 读取失败:', err.message);
  }
  cache = { ...DEFAULT_CONFIG, pool: [] };
  return cache;
}

/**
 * 原子写入：先写临时文件再 rename，避免写一半崩溃留下损坏 JSON。
 */
function writeRaw(data) {
  cache = data;
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      const tmp = STORE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, STORE_FILE);
    }
  } catch (err) {
    console.error('[Rotation] 写入失败:', err.message);
  }
}

/**
 * 读取配置（返回深拷贝，调用方随便改不影响内部缓存）。
 */
function getConfig() {
  return JSON.parse(JSON.stringify(readRaw()));
}

/**
 * 局部更新配置。归一化后落盘，返回新配置的深拷贝。
 * @param {object} patch 要更新的字段（未传的保留原值）
 */
function updateConfig(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('配置更新必须是对象');
  }
  const current = readRaw();
  const merged = { ...current };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      merged[key] = patch[key];
    }
  }
  const next = normalizeConfig(merged);
  writeRaw(next);
  console.log('[Rotation] 配置已更新');
  return getConfig();
}

/**
 * 重置轮转运行状态：cursor 归零、轮转计数器清零。配置项（阈值/池等）保留。
 */
function resetState() {
  const current = readRaw();
  const next = normalizeConfig({ ...current, cursor: 0 });
  writeRaw(next);
  rotationCount = 0;
  sessionStartedAt = null;
  console.log('[Rotation] 状态已重置');
  return getConfig();
}

// ===== 运行时状态（不进配置文件）=====
let rotationCount = 0;
let sessionStartedAt = null;

function _resetForTest() {
  rotationCount = 0;
  sessionStartedAt = null;
}

module.exports = {
  DEFAULT_CONFIG,
  init,
  getStoreFile,
  getConfig,
  updateConfig,
  resetState,
  _resetForTest,
};


// ===== Task 2: 目标窗口选择（纯函数）=====

/**
 * 从窗口池中选出下一个目标窗口的下标。
 *
 * 扫描策略：
 *   1. 从 cursor+1 开始环形扫描一圈（i 从 1 到 pool.length）
 *   2. 跳过 enabled === false 的
 *   3. 跳过 isAvailable 返回 false 的
 *   4. preferDifferentAccount 为真时，第一遍只接受 accountTag !== sourceAccountTag
 *   5. 第一遍找不到且 preferDifferentAccount 为真 → 第二遍取消账号过滤
 *      （Review Focus 4：池里全是同账号时不能返回 -1，要降级为顺序选）
 *
 * @param {Array<{profileId:string, accountTag:string, enabled:boolean}>} pool
 * @param {number} cursor 起点（不含）
 * @param {(profileId:string)=>boolean} isAvailable 窗口是否可派发
 * @param {{preferDifferentAccount?:boolean, sourceAccountTag?:string}} opts
 * @returns {number} 池中下标；无可用返回 -1
 */
function selectNextIndex(pool, cursor, isAvailable, opts) {
  if (!Array.isArray(pool) || pool.length === 0) return -1;
  const options = opts && typeof opts === 'object' ? opts : {};
  const preferDifferent = options.preferDifferentAccount === true;
  const sourceTag = options.sourceAccountTag == null ? '' : String(options.sourceAccountTag);
  const start = Number.isFinite(Number(cursor)) ? Math.floor(Number(cursor)) : 0;

  /** 单遍扫描；accountFilter 为真时跳过同账号 */
  const scan = (accountFilter) => {
    for (let i = 1; i <= pool.length; i++) {
      const idx = ((start + i) % pool.length + pool.length) % pool.length;
      const item = pool[idx];
      if (!item || item.enabled === false) continue;
      if (accountFilter && String(item.accountTag || '') === sourceTag) continue;
      if (typeof isAvailable === 'function' && !isAvailable(item.profileId)) continue;
      return idx;
    }
    return -1;
  };

  const first = scan(preferDifferent);
  if (first !== -1) return first;
  if (!preferDifferent) return -1;
  // 降级：取消账号过滤再扫一遍
  return scan(false);
}

module.exports.selectNextIndex = selectNextIndex;

// ===== Task 3: 迁移中继与超时看门狗 =====

/** ack 超时（毫秒） */
const ACK_TIMEOUT_MS = 90000;

/** 进行中的迁移请求：requestId → {sourceProfileId, targetProfileId, targetIndex, timer, onResult} */
const pending = new Map();

let requestSeq = 0;

/** 生成 requestId：时间戳 + 自增序号 + 随机串，保证同毫秒内也不重复 */
function makeRequestId() {
  requestSeq = (requestSeq + 1) % 100000;
  return Date.now() + '-' + requestSeq + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 提交一次轮转迁移。
 *
 * @param {string} sourceProfileId 源窗口
 * @param {string} sourceAccountTag 源窗口账号标识
 * @param {object} data 迁移载荷（history / projectDir / oldSessionId / ...）
 * @param {object} deps
 *   - isAvailable(profileId): boolean 目标窗口是否可派发
 *   - dispatch(profileId, requestId, data): Promise<void> 实际派发
 *   - onResult(sourceProfileId, result): void 结果回告源窗口
 * @returns {Promise<{ok:boolean, requestId?:string, targetProfileId?:string, reason?:string}>}
 */
async function submit(sourceProfileId, sourceAccountTag, data, deps) {
  const config = readRaw();
  if (config.enabled !== true) {
    return { ok: false, reason: 'disabled' };
  }

  // 轮转次数上限（反目标 A3：不允许无限轮转）
  if (rotationCount >= config.maxRotations) {
    return { ok: false, reason: 'limit' };
  }
  // 会话时长上限
  const now = Date.now();
  if (sessionStartedAt == null) {
    sessionStartedAt = now;
  } else if (now - sessionStartedAt > config.maxSessionHours * 3600 * 1000) {
    return { ok: false, reason: 'limit' };
  }

  const depsObj = deps && typeof deps === 'object' ? deps : {};
  const isAvailable = typeof depsObj.isAvailable === 'function' ? depsObj.isAvailable : () => true;
  const dispatch = typeof depsObj.dispatch === 'function' ? depsObj.dispatch : async () => {};
  const onResult = typeof depsObj.onResult === 'function' ? depsObj.onResult : () => {};

  const pickOpts = {
    preferDifferentAccount: config.preferDifferentAccount,
    sourceAccountTag,
  };
  let targetIndex = selectNextIndex(config.pool, config.cursor, isAvailable, pickOpts);

  // Review Focus 1：目标窗口正忙时不能硬塞。等至多 targetBusyWaitMs，
  // 期间只要有一个窗口转空闲就立刻派发；期满仍全忙才放弃（回落原地迁移）。
  if (targetIndex === -1) {
    const waitMs = Math.max(0, Number(config.targetBusyWaitMs) || 0);
    const deadline = Date.now() + waitMs;
    const pollMs = 500;
    while (waitMs > 0 && Date.now() < deadline) {
      const sleepMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
      await new Promise((r) => {
        const t = setTimeout(r, sleepMs);
        // 仅在 Electron 主进程 unref；纯 Node 测试环境 unref 会让事件循环"空转结束"→ cancelledByParent
        if (t && typeof t.unref === 'function' && process.versions && process.versions.electron) t.unref();
      });
      targetIndex = selectNextIndex(config.pool, config.cursor, isAvailable, pickOpts);
      if (targetIndex !== -1) break;
    }
    if (targetIndex === -1) {
      return { ok: false, reason: 'no-target' };
    }
  }

  const target = config.pool[targetIndex];
  const requestId = makeRequestId();

  // 登记 pending + 启动看门狗
  const timer = setTimeout(() => {
    if (!pending.has(requestId)) return;
    pending.delete(requestId);
    try {
      onResult(sourceProfileId, { ok: false, requestId, reason: 'timeout' });
    } catch (err) {
      console.error('[Rotation] onResult 回调异常:', err.message);
    }
  }, ACK_TIMEOUT_MS);
  // 仅在 Electron 主进程 unref；纯 Node 测试环境 unref 会让事件循环"空转结束"→ cancelledByParent
  if (timer && typeof timer.unref === 'function' && process.versions && process.versions.electron) timer.unref();

  pending.set(requestId, {
    sourceProfileId,
    targetProfileId: target.profileId,
    targetIndex,
    timer,
    onResult,
  });

  try {
    await dispatch(target.profileId, requestId, data);
  } catch (err) {
    console.error('[Rotation] 派发失败:', err.message);
    if (pending.has(requestId)) {
      pending.delete(requestId);
      clearTimeout(timer);
    }
    return { ok: false, reason: 'dispatch-failed' };
  }

  return { ok: true, requestId, targetProfileId: target.profileId };
}

/**
 * 目标窗口回执。
 * @param {string} requestId
 * @param {boolean} ok 是否承接成功
 * @param {string} [error] 失败原因
 * @returns {boolean} 是否命中一条进行中的请求
 */
function ack(requestId, ok, error) {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);

  if (ok === true) {
    // 推进游标 + 累加轮转计数
    rotationCount += 1;
    updateConfig({ cursor: entry.targetIndex });
  }

  try {
    entry.onResult(entry.sourceProfileId, {
      ok: ok === true,
      requestId,
      targetProfileId: entry.targetProfileId,
      error: error || undefined,
    });
  } catch (err) {
    console.error('[Rotation] onResult 回调异常:', err.message);
  }
  return true;
}

/** 当前进行中的请求数（测试用） */
function _pendingSize() {
  return pending.size;
}

/** 清空 pending 与定时器（测试用） */
function _clearPending() {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  rotationCount = 0;
  sessionStartedAt = null;
}

/**
 * 构建候选窗口列表（供 UI 展示与选池）。
 *
 * @param {Array<{id:string, name:string}>} profiles profile 列表
 * @param {object} cfg 轮转配置（用于取 accountTag）
 * @param {(profileId:string)=>object|null} getCtx 取窗口上下文
 * @param {(profileId:string)=>boolean} isBusy 窗口是否在生成
 * @returns {Array<{profileId, name, accountTag, exists, busy}>}
 */
function buildCandidates(profiles, cfg, getCtx, isBusy) {
  if (!Array.isArray(profiles)) return [];
  const pool = cfg && Array.isArray(cfg.pool) ? cfg.pool : [];
  const tagMap = new Map();
  for (const item of pool) {
    if (item && item.profileId) tagMap.set(String(item.profileId), item.accountTag == null ? '' : String(item.accountTag));
  }
  const out = [];
  for (const p of profiles) {
    if (!p || !p.id) continue;
    const profileId = String(p.id);
    let ctx = null;
    try { ctx = typeof getCtx === 'function' ? getCtx(profileId) : null; } catch (_) { ctx = null; }
    const exists = !!ctx;
    let busy = false;
    if (exists) {
      try { busy = typeof isBusy === 'function' ? !!isBusy(profileId) : false; } catch (_) { busy = false; }
    }
    out.push({
      profileId,
      name: p.name == null ? '' : String(p.name),
      accountTag: tagMap.get(profileId) || '',
      exists,
      busy,
    });
  }
  return out;
}

module.exports.buildCandidates = buildCandidates;
module.exports.submit = submit;
module.exports.ack = ack;
module.exports._pendingSize = _pendingSize;
module.exports._resetForTest = _clearPending;

