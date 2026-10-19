/**
 * 工具调用幂等键 —— 让「重试」变安全
 *
 * 为什么需要：
 *   P1 引入状态机 + P2 DOM 兜底后，系统会在「不确定是否成功」时重试。
 *   但如果上次其实已经执行成功了（只是回传丢了），重试会造成重复副作用：
 *     - 重复写文件（内容相同，无害但要避免）
 *     - 重复删文件（第二次报 not found，会让 AI 困惑）
 *     - 重复执行 bash（可能是 git push、发消息等不可逆操作）
 *
 *   用「工具名 + 参数哈希」作为幂等键，命中缓存则直接返回上次结果，
 *   让上层可以放心重试。
 *
 * 注意：只对「确定性工具」启用。bash/pwsh 这类命令即使是同样文本也可能
 *   有副作用（时间、随机数、外部状态），默认不缓存，由调用方显式开启。
 */

const STORAGE_KEY = 'lingya-idempotent-calls';
const MAX_ENTRIES = 200;
// 缓存有效期：1 小时。太老的缓存没有复用价值，反而占空间
const TTL_MS = 60 * 60 * 1000;

// 默认参与幂等的工具 —— 仅限「纯读」操作。
//
// 【禁止加入写操作】todo_write / memory_save / memory_update 曾经被误列在这里，
// 后果是：AI 调它们时命中缓存 → 返回假的 success → 计划/记忆实际没更新，
// 但 AI 以为更新了，继续基于错误的计划往下走。这类错误不报错，极难发现。
//
// 判断标准：调用它会不会改变任何持久状态？会 → 不加入。
const IDEMPOTENT_TOOLS = new Set([
  // 文件读取
  'read', 'read_lines', 'read_lines_window',
  // 搜索
  'glob', 'grep',
  // 网络只读
  'web_fetch', 'web_search',
  // 记忆/插件/工具的查询（list 是读，save/update/delete 不是）
  'memory_list',
  'listPlugins',
  'mcp_list_servers', 'mcp_get_tools',
  // 图片查看（纯读）
  'view_image',
]);

/**
 * 简单稳定哈希（FNV-1a 32 位）。不需要密码学强度，只要同输入同输出。
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * 生成幂等键。参数用稳定序列化（键排序）保证同参数同键。
 *
 * 【必须带项目目录】否则跨项目会串数据：
 *   项目 A 里 read a.js 成功缓存 → 切到项目 B → 再 read a.js 命中 A 的缓存
 *   → AI 拿到 A 的文件内容，但以为是 B 的，基于错数据往下推理。
 *   glob / grep 更严重，会拿到另一个项目的完整搜索结果。
 *
 * @param {string} toolName
 * @param {object} params
 * @param {string} [projectDir] 当前项目目录（由调用方从 state.currentProjectDir 取）
 */
function makeKey(toolName, params, projectDir) {
  let serialized;
  try {
    // 键排序，避免 {a:1,b:2} 与 {b:2,a:1} 生成不同键
    const sorted = {};
    const keys = Object.keys(params || {}).sort();
    for (const k of keys) sorted[k] = params[k];
    serialized = JSON.stringify(sorted);
  } catch (_) {
    serialized = String(params);
  }
  // 项目目录参与哈希：不同项目即使参数相同也是不同键
  const scope = String(projectDir || '');
  return toolName + ':' + hashString(scope + '\u0000' + serialized);
}

/** 读取全部缓存条目 */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) { return {}; }
}

/** 写回缓存（按时间淘汰） */
function saveStore(store) {
  try {
    const now = Date.now();
    const entries = Object.keys(store)
      .map((k) => [k, store[k]])
      .filter(([, v]) => v && (now - v.at) < TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)  // 新的在前
      .slice(0, MAX_ENTRIES);
    const next = {};
    for (const [k, v] of entries) next[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (_) { /* 存储满时忽略，不影响功能 */ }
}

/**
 * 判断某个工具是否参与幂等缓存。
 * @param {string} toolName
 * @param {boolean} [force] 调用方显式要求（即使不在白名单也缓存）
 */
function isIdempotent(toolName, force) {
  if (force) return true;
  return IDEMPOTENT_TOOLS.has(toolName);
}

/**
 * 查缓存。命中返回上次结果，未命中返回 null。
 */
function lookup(toolName, params, projectDir) {
  const key = makeKey(toolName, params, projectDir);
  const store = loadStore();
  const hit = store[key];
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) return null;
  console.log('[LingYa][幂等] 命中缓存: ' + key + '（' + Math.round((Date.now() - hit.at) / 1000) + 's 前执行过）');
  return hit.result;
}

/**
 * 记录一次成功执行的结果。
 */
function record(toolName, params, result, projectDir) {
  // 只缓存成功结果：失败可能是暂时的（网络、锁），重试有意义
  if (!result || !result.success) return;
  const key = makeKey(toolName, params, projectDir);
  const store = loadStore();
  store[key] = { at: Date.now(), result: result };
  saveStore(store);
}

/** 清空缓存（用户主动要求 / 切换项目时） */
function clear() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

module.exports = { makeKey, isIdempotent, lookup, record, clear, IDEMPOTENT_TOOLS };
