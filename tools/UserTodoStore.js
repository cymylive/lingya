/**
 * 用户手动待办清单存储
 *
 * 与 AI 的 todoWrite 计划（tools/TodoWriteTool.js）**完全独立**：
 *   - 独立文件：lingya-user-todos.json（AI 的用 lingya-todos.json）
 *   - 独立变量：本模块自己的 store，不共享任何状态
 *
 * 为什么必须分开：todoWrite 的语义是「替换完整列表」，AI 每次调用都会覆盖。
 * 若共用一份，用户手动记的待办会在 AI 执行任务时凭空消失。
 *
 * 数据结构：
 *   { "<sessionId>": { todos: [{ id, text, done, createdAt }], updatedAt } }
 *   无 sessionId 时键为 "pending:<profileId>"
 */
const fs = require('fs');
const path = require('path');

/** 存储文件名（与 AI 计划的 lingya-todos.json 严格区分） */
const STORE_FILENAME = 'lingya-user-todos.json';

/** 单条文本长度上限 */
const MAX_TEXT_LEN = 500;

/**
 * 系统消息前缀黑名单。
 *
 * 【为什么必须有】
 *   LingYa 会向对话里发送大量程序消息（【监督续跑】【自动续跑】【系统提示】等）。
 *   这些内容绝不应该变成用户的待办项 —— 但 AI 有可能被催促消息搞混，
 *   误把它们当成"用户要求记录的任务"；用户也可能误粘贴。
 *   在存储层直接拒绝，是最可靠的最后一道防线。
 */
const SYSTEM_PREFIXES = [
  '【监督续跑】',
  '【自动续跑】',
  '【系统提示】',
  '【工具执行结果】',
  '【JS 执行结果',
  '【计划续跑】',
  '【兜底续跑】',
  '【中断续跑】',
  '【队列异常重试】',
  '【拒绝改写',
  '【用户已确认执行】',
  '【计划已建立',
  '【计划已全部完成',
];

let STORE_FILE = null;
let store = {};

/**
 * 初始化存储目录（应用启动时调用一次）
 * @param {string} storeDir userData 目录
 */
function init(storeDir) {
  STORE_FILE = path.join(storeDir, STORE_FILENAME);
  store = readStore();
  console.log('[UserTodoStore] 存储文件:', STORE_FILE);
}

function readStore() {
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
  } catch (err) {
    // 文件损坏不崩溃：返回空，下次写入会覆盖成合法 JSON
    console.error('[UserTodoStore] 读取失败（将重置为空）:', err.message);
  }
  return {};
}

function writeStore() {
  try {
    if (!STORE_FILE) return;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[UserTodoStore] 写入失败:', err.message);
  }
}

/** 会话键：优先 sessionId，无则 pending:<profileId> */
function keyFor(sessionId, profileId) {
  if (sessionId) return String(sessionId);
  return 'pending:' + (profileId || '__default');
}

/** 取某会话的 todos 数组（内部可变引用，调用方不要直接改） */
function bucketOf(key) {
  if (!store[key] || !Array.isArray(store[key].todos)) {
    store[key] = { todos: [], updatedAt: Date.now() };
  }
  return store[key];
}

/** 校验并规范化文本 */
function normalizeText(text, action) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw new Error('todo text must not be empty');
  if (t.length > MAX_TEXT_LEN) {
    throw new Error('todo text too long (max ' + MAX_TEXT_LEN + ' chars, got ' + t.length + ')');
  }
  // 拒绝系统消息：它们不是用户的任务，混进来会污染清单
  for (const p of SYSTEM_PREFIXES) {
    if (t.startsWith(p)) {
      throw new Error('todo text must not be a system message (matched "' + p + '")');
    }
  }
  return t;
}

/** 生成唯一 id */
let _seq = 0;
function genId() {
  _seq = (_seq + 1) % 100000;
  return 'ut_' + Date.now().toString(36) + '_' + _seq.toString(36) +
    Math.random().toString(36).slice(2, 6);
}

/**
 * 读取某会话的全部待办（返回副本，防外部误改）
 * @returns {Array<{id:string, text:string, done:boolean, createdAt:number}>}
 */
function list(sessionId, profileId) {
  const key = keyFor(sessionId, profileId);
  const rec = store[key];
  if (!rec || !Array.isArray(rec.todos)) return [];
  return rec.todos.map((t) => ({
    id: t.id,
    text: t.text,
    done: !!t.done,
    createdAt: t.createdAt,
  }));
}

/**
 * 新增一条待办
 * @returns {{id,text,done,createdAt}}
 * @throws 文本为空或超长
 */
function add(sessionId, profileId, text) {
  const t = normalizeText(text);
  const key = keyFor(sessionId, profileId);
  const bucket = bucketOf(key);
  const item = { id: genId(), text: t, done: false, createdAt: Date.now() };
  bucket.todos.push(item);
  bucket.updatedAt = Date.now();
  writeStore();
  return { ...item };
}

/**
 * 更新一条待办（文本 / 勾选状态）
 * @param {string} id
 * @param {{text?: string, done?: boolean}} patch
 * @returns {boolean} false = id 不存在
 * @throws 文本为空或超长
 */
function update(sessionId, profileId, id, patch) {
  const key = keyFor(sessionId, profileId);
  const bucket = store[key];
  if (!bucket || !Array.isArray(bucket.todos)) return false;
  const item = bucket.todos.find((t) => t.id === id);
  if (!item) return false;

  const p = patch || {};
  if (p.text !== undefined) {
    item.text = normalizeText(p.text);
  }
  if (p.done !== undefined) {
    item.done = !!p.done;
  }
  bucket.updatedAt = Date.now();
  writeStore();
  return true;
}

/**
 * 删除一条待办
 * @returns {boolean} false = id 不存在
 */
function remove(sessionId, profileId, id) {
  const key = keyFor(sessionId, profileId);
  const bucket = store[key];
  if (!bucket || !Array.isArray(bucket.todos)) return false;
  const idx = bucket.todos.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  bucket.todos.splice(idx, 1);
  bucket.updatedAt = Date.now();
  writeStore();
  return true;
}

/** 清空某会话的全部待办 */
function clear(sessionId, profileId) {
  const key = keyFor(sessionId, profileId);
  if (store[key]) {
    delete store[key];
    writeStore();
  }
}

/**
 * 解析多行粘贴文本为多条待办。
 *
 * 规则：只有当**每一行**都带列表标记时才拆条；否则整段原样返回。
 * 理由：用户可能粘贴一段普通文字（含换行），不能误拆成多条。
 *
 * 支持的标记：1. / 1、 / 1) / - / * / •
 */
function parseBulk(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  // 列表标记正则。
  // 关键细节：标记后的分隔空格可以是 0 个（中文用户常写「1、买菜」不带空格），
  // 但「1.」后面若紧跟数字必须排除，否则「1.5折」会被误拆成「5折」。
  const MARKER_RE = /^(?:\d+[.、)](?!\d)|[-*•])\s*(.*)$/;

  // 单行：直接返回
  if (lines.length === 1) {
    const m = lines[0].match(MARKER_RE);
    return [m ? m[1].trim() : lines[0]].filter((s) => s.length > 0);
  }

  // 多行：每一行都必须匹配列表标记才拆
  const matched = lines.map((l) => l.match(MARKER_RE));
  const allMarked = matched.every((m) => m !== null);

  if (allMarked) {
    return matched.map((m) => m[1].trim()).filter((s) => s.length > 0);
  }

  // 非全标记：整段作为一个待办（保留原始换行）
  return [raw.trim()];
}

module.exports = {
  STORE_FILENAME,
  MAX_TEXT_LEN,
  SYSTEM_PREFIXES,
  init,
  list,
  add,
  update,
  remove,
  clear,
  parseBulk,
  keyFor,
};
