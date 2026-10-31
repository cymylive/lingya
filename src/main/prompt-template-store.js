/**
 * 初始化提示词模板草稿存储（JSON 持久化）
 * 存储文件：<userData>/lingya-prompt-templates.json
 *
 * 结构：
 * {
 *   activeId: string,            // 当前激活的草稿 ID
 *   templates: [
 *     { id, name, isBuiltin, content }
 *   ]
 * }
 *
 * 内置草稿（isBuiltin: true）：从 src/prompt/{providerId}.md / default.md 动态读取，
 * 不允许修改/删除，只能「另存为副本」。
 *
 * 用户草稿（isBuiltin: false）：可编辑、重命名、删除、设为激活。
 * 激活后，project-context.js 会优先使用其内容（跳过内置模板读取）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROMPT_DIR = path.join(__dirname, '..', 'prompt');
const BUILTIN_DEFAULT_ID = 'builtin-default';

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-prompt-templates.json');
  cache = null;
  console.log('[PromptStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function genId() {
  return 'user-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/** 读内置模板内容（从磁盘） */
function readBuiltinContent(builtinKey) {
  try {
    const p = path.join(PROMPT_DIR, builtinKey + '.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (_) {}
  return '';
}

/** 列出内置模板（2026-11-01）只有完整的初始化提示词模板才列出。
 *  core-rules.md / ctf.md 是片段（注入到占位符里），不是完整模板，不在此列。 */
const BUILTIN_TEMPLATES = [
  { key: 'deepseek', name: '内置：DeepSeek' },
  { key: 'claude', name: '内置：Claude' },
  { key: 'chatgpt', name: '内置：ChatGPT' },
  { key: 'default', name: '内置：通用（default）' },
];

function listBuiltins() {
  const out = [];
  for (const t of BUILTIN_TEMPLATES) {
    try {
      const p = path.join(PROMPT_DIR, t.key + '.md');
      if (!fs.existsSync(p)) continue;   // 模板文件不存在就跳过
      out.push({
        id: 'builtin-' + t.key,
        name: t.name,
        isBuiltin: true,
        builtinKey: t.key,
        content: '',   // 动态读取，不落存储
      });
    } catch (_) {}
  }
  return out;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.templates)) {
        cache = {
          activeId: String(parsed.activeId || ''),
          templates: parsed.templates.filter(t => t && t.id && t.name),
          // 【2026-11-01】内置模板的用户覆盖：{ 'builtin-deepseek': { content, updatedAt } }
          overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
        };
        return cache;
      }
    }
  } catch (err) {
    console.error('[PromptStore] 读取失败:', err.message);
  }
  cache = { activeId: '', templates: [], overrides: {} };
  return cache;
}

function writeRaw(data) {
  cache = data;
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[PromptStore] 写入失败:', err.message);
  }
}

/**
 * 列出所有模板（内置 + 用户）。
 * 内置的 content 是动态读取的；用户的 content 存在 JSON 中。
 */
function listAll() {
  const raw = readRaw();
  const overrides = raw.overrides || {};
  const builtins = listBuiltins().map(b => {
    const baseContent = readBuiltinContent(b.builtinKey);
    const ov = overrides[b.id];
    const hasOverride = !!(ov && typeof ov.content === 'string');
    return {
      ...b,
      content: hasOverride ? ov.content : baseContent,
      hasOverride,
      updatedAt: hasOverride ? ov.updatedAt : undefined,
    };
  });
  const users = raw.templates.map(t => ({ ...t, isBuiltin: false, hasOverride: false }));
  return {
    success: true,
    activeId: raw.activeId || '',
    templates: [...builtins, ...users],
  };
}

/**
 * 获取当前激活的模板（用于 project-context.js）
 * @returns {{ id: string, name: string, content: string } | null}
 *  - 若 activeId 指向内置：返回内置内容
 *  - 若指向用户：返回用户内容
 *  - 若未设置或找不到：null
 */
function getActiveTemplate() {
  const raw = readRaw();
  if (!raw.activeId) return null;
  // 用户模板
  const user = raw.templates.find(t => t.id === raw.activeId);
  if (user) {
    return { id: user.id, name: user.name, content: String(user.content || '') };
  }
  // 内置模板（优先用 override）
  if (raw.activeId.indexOf('builtin-') === 0) {
    const key = raw.activeId.slice('builtin-'.length);
    const ov = raw.overrides && raw.overrides[raw.activeId];
    const c = (ov && typeof ov.content === 'string') ? ov.content : readBuiltinContent(key);
    if (c) return { id: raw.activeId, name: '内置：' + key, content: c, isBuiltin: true, builtinKey: key, hasOverride: !!ov };
  }
  return null;
}

/**
 * 创建新草稿
 * @param {string} name 草稿名
 * @param {string} [content] 初始内容
 * @param {string} [fromId] 从哪个模板复制（内置或用户，可选）
 */
function createTemplate({ name, content, fromId } = {}) {
  const n = String(name || '').trim();
  if (!n) return { success: false, error: '草稿名不能为空' };
  const raw = readRaw();
  // 若 fromId 提供了，复制其内容
  let initialContent = String(content || '');
  if (fromId) {
    const all = listAll();
    const src = all.templates.find(t => t.id === fromId);
    if (src) initialContent = String(src.content || '');
  }
  const t = { id: genId(), name: n, content: initialContent };
  raw.templates.push(t);
  writeRaw(raw);
  return { success: true, id: t.id, template: { ...t, isBuiltin: false } };
}

/** 更新草稿内容或名字（内置模板支持：内容写入 overrides，不改磁盘原文件） */
function updateTemplate({ id, name, content } = {}) {
  if (!id) return { success: false, error: '缺少 id' };
  const raw = readRaw();
  // 内置模板：写入 overrides（改名对内置无意义，忽略 name）
  if (id.indexOf('builtin-') === 0) {
    if (content === undefined) return { success: false, error: '内置模板不支持改名，仅支持编辑内容' };
    if (!raw.overrides) raw.overrides = {};
    raw.overrides[id] = { content: String(content || ''), updatedAt: new Date().toISOString() };
    writeRaw(raw);
    return { success: true, template: { id, name: id.replace('builtin-', '内置：'), content: String(content || ''), isBuiltin: true, hasOverride: true } };
  }
  // 用户草稿
  const t = raw.templates.find(x => x.id === id);
  if (!t) return { success: false, error: '草稿不存在' };
  if (name !== undefined) {
    const n = String(name || '').trim();
    if (!n) return { success: false, error: '草稿名不能为空' };
    t.name = n;
  }
  if (content !== undefined) t.content = String(content || '');
  writeRaw(raw);
  return { success: true, template: { ...t, isBuiltin: false } };
}

/** 恢复内置模板为原始内容（删除 override） */
function resetBuiltin({ id } = {}) {
  if (!id || id.indexOf('builtin-') !== 0) return { success: false, error: '仅支持内置模板' };
  const raw = readRaw();
  if (raw.overrides && raw.overrides[id]) {
    delete raw.overrides[id];
    writeRaw(raw);
    return { success: true };
  }
  return { success: true, unchanged: true };
}

/** 删除用户草稿 */
function deleteTemplate({ id } = {}) {
  if (!id) return { success: false, error: '缺少 id' };
  const raw = readRaw();
  const idx = raw.templates.findIndex(t => t.id === id);
  if (idx < 0) return { success: false, error: '草稿不存在（内置模板不可删除）' };
  raw.templates.splice(idx, 1);
  if (raw.activeId === id) raw.activeId = '';
  writeRaw(raw);
  return { success: true };
}

/** 设置激活草稿（传 '' 或 null 取消激活，回到内置优先级） */
function setActive({ id } = {}) {
  const raw = readRaw();
  const newId = String(id || '');
  if (newId) {
    // 验证存在（内置或用户）
    const exists = newId.indexOf('builtin-') === 0 || raw.templates.some(t => t.id === newId);
    if (!exists) return { success: false, error: '草稿不存在' };
  }
  raw.activeId = newId;
  writeRaw(raw);
  return { success: true, activeId: newId };
}

/** 复制草稿（另存为副本） */
function duplicateTemplate({ id, newName } = {}) {
  if (!id) return { success: false, error: '缺少 id' };
  const all = listAll();
  const src = all.templates.find(t => t.id === id);
  if (!src) return { success: false, error: '源草稿不存在' };
  const n = String(newName || '').trim() || (src.name + ' 副本');
  return createTemplate({ name: n, fromId: id });
}

module.exports = {
  init,
  getStoreFile,
  listAll,
  getActiveTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setActive,
  duplicateTemplate,
  resetBuiltin,
};
