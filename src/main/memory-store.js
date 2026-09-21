/**
 * 记忆存储与选择器（全局共享，JSON 持久化）
 * 移植自 deepseek-pp 的 core/memory（selector + store 简化版）。
 * 存储文件：<userData>/lingya-memory.json
 */
const fs = require('fs');
const path = require('path');

const MEMORY_TYPES = ['user', 'feedback', 'topic', 'reference'];
const MEMORY_TOKEN_BUDGET = 1500;

// 中文停用词（移植自 deepseek-pp constants）
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '里', '之', '中', '与', '而', '为',
  '以', '及', '等', '被', '把', '让', '给', '从', '向', '对', '但', '如果', '因为',
  '所以', '虽然', '可以', '能', '想', '知道', '时候', '没', '什么', '怎么', '这个',
  '那个', '还', '过', '吗', '呢', '吧', '啊', '嗯', '哦', '呀', '啦', '使用',
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'she', 'or', 'an', 'will', 'my', 'one', 'all',
]);

// token 估算（移植自 deepseek-pp token/estimator）
function estimateTokens(text) {
  let tokens = 0;
  for (const char of String(text)) {
    tokens += char.charCodeAt(0) > 0x7f ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

// 中文分词（移植自 deepseek-pp selector）
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  : null;

function segmentText(text) {
  const s = String(text || '');
  if (segmenter) {
    return [...segmenter.segment(s)]
      .filter((seg) => seg.isWordLike)
      .map((seg) => seg.segment.toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  }
  return s.toLowerCase().split(/[\s,，。！？；：、\-_/]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// 时间衰减打分（移植自 deepseek-pp selector.decayScore）
function decayScore(memory) {
  const daysSinceAccess = (Date.now() - (memory.lastAccessedAt || 0)) / 86400000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount || 0, 20) + freshness;
}

// 关键词匹配打分（移植自 deepseek-pp selector.keywordScore）
function keywordScore(promptWords, memory) {
  const promptSet = new Set(promptWords);
  let tagHits = 0;
  for (const tag of (memory.tags || [])) {
    const tagLower = tag.toLowerCase();
    if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
    for (const pw of promptWords) {
      if (pw.length > 2 && tagLower.includes(pw) && tagLower !== pw) tagHits += 0.5;
    }
  }
  let nameHits = 0;
  for (const w of segmentText(memory.name)) {
    if (promptSet.has(w)) nameHits++;
  }
  let contentHits = 0;
  for (const w of segmentText(memory.content)) {
    if (promptSet.has(w)) contentHits++;
  }
  return tagHits * 20 + nameHits * 15 + contentHits * 5;
}

// 格式化单条记忆为注入行（移植自 deepseek-pp selector.formatMemoryLine）
function formatMemoryLine(m) {
  const idPrefix = m.id != null ? '#' + m.id + ' ' : '';
  return '- ' + idPrefix + '[' + m.type + '] ' + m.name + ': ' + m.content;
}

function formatMemoriesBlock(memories) {
  if (!memories || memories.length === 0) return '（暂无长期记忆）';
  return memories.map(formatMemoryLine).join('\n');
}

/**
 * 选择要注入的记忆：pinned 优先 + 时间衰减 + （可选）关键词匹配，按 token 预算截断
 * @param {Array} allMemories
 * @param {object} [options] { prompt?: string, budget?: number }
 */
function selectMemories(allMemories, options) {
  const opts = options || {};
  if (!allMemories || allMemories.length === 0) return [];
  const budget = typeof opts.budget === 'number' ? opts.budget : MEMORY_TOKEN_BUDGET;
  const promptWords = opts.prompt ? segmentText(opts.prompt) : [];

  const scored = allMemories.map((m) => ({
    memory: m,
    score: (m.pinned ? 1000 : 0) + keywordScore(promptWords, m) + decayScore(m),
  }));
  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  let remaining = budget;
  for (const item of scored) {
    const cost = estimateTokens(formatMemoryLine(item.memory));
    if (remaining - cost < 0 && selected.length > 0) break;
    selected.push(item.memory);
    remaining -= cost;
  }
  return selected;
}

// ========== 存储 ==========
let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-memory.json');
  cache = null;
  console.log('[MemoryStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      cache = {
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        nextId: typeof parsed.nextId === 'number' ? parsed.nextId : 1,
      };
      return cache;
    }
  } catch (err) {
    console.error('[MemoryStore] 读取失败:', err.message);
  }
  cache = { memories: [], nextId: 1 };
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
    console.error('[MemoryStore] 写入失败:', err.message);
  }
}

function getAllMemories() {
  return readRaw().memories.map((m) => ({ ...m }));
}

function getMemoryById(id) {
  return readRaw().memories.find((m) => m.id === id) || null;
}

function normalizeNewMemory(input) {
  const type = MEMORY_TYPES.includes(input.type) ? input.type : 'reference';
  const name = String(input.name || '').trim();
  const content = String(input.content || '').trim();
  if (!name) throw new Error('记忆 name 不能为空');
  if (!content) throw new Error('记忆 content 不能为空');
  return {
    type,
    name: name.slice(0, 200),
    content: content.slice(0, 8000),
    description: String(input.description || '').slice(0, 1000),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
      : [],
    pinned: input.pinned === true,
  };
}

function saveMemory(input) {
  const norm = normalizeNewMemory(input);
  const data = readRaw();
  const now = Date.now();
  const record = {
    id: data.nextId,
    ...norm,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
  };
  data.nextId += 1;
  data.memories.push(record);
  writeRaw(data);
  console.log('[MemoryStore] 已保存记忆 #' + record.id + ': ' + record.name);
  return record.id;
}

function updateMemory(input) {
  const id = Number(input.id);
  if (!Number.isInteger(id)) throw new Error('记忆 id 必须是整数');
  const data = readRaw();
  const idx = data.memories.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error('记忆 #' + id + ' 不存在');
  const norm = normalizeNewMemory(input);
  data.memories[idx] = {
    ...data.memories[idx],
    ...norm,
    updatedAt: Date.now(),
  };
  writeRaw(data);
  console.log('[MemoryStore] 已更新记忆 #' + id);
  return true;
}

function deleteMemory(id) {
  const numId = Number(id);
  const data = readRaw();
  const before = data.memories.length;
  data.memories = data.memories.filter((m) => m.id !== numId);
  if (data.memories.length === before) throw new Error('记忆 #' + id + ' 不存在');
  writeRaw(data);
  console.log('[MemoryStore] 已删除记忆 #' + numId);
  return true;
}

function touchMemories(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const data = readRaw();
  const target = new Set(ids);
  const now = Date.now();
  for (const m of data.memories) {
    if (target.has(m.id)) {
      m.accessCount = (m.accessCount || 0) + 1;
      m.lastAccessedAt = now;
    }
  }
  writeRaw(data);
}

/**
 * 初始化注入用：选出记忆并格式化为文本块
 */
function buildMemorySection(options) {
  const memories = getAllMemories();
  const selected = selectMemories(memories, options);
  if (selected.length > 0) touchMemories(selected.map((m) => m.id));
  return formatMemoriesBlock(selected);
}

// 去重键：内容小写、压缩空白
function dedupeKey(content) {
  return String(content || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 导入记忆（兼容 deepseek-pp 导出格式与 lingya 自身格式）
 * 接受：数组，或 { memories: [...] }
 * 按 content 去重。返回 { imported, duplicates, rejected }
 */
function importMemories(input) {
  const list = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.memories) ? input.memories : null);
  if (!list) throw new Error('导入数据格式错误：应为数组或 { memories: [...] }');

  const data = readRaw();
  const existingKeys = new Set(data.memories.map((m) => dedupeKey(m.content)));
  const seenKeys = new Set();
  const now = Date.now();
  let imported = 0;
  let duplicates = 0;
  let rejected = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { rejected++; continue; }
    const content = String(item.content || '').trim();
    if (!content) { rejected++; continue; }
    const key = dedupeKey(content);
    if (existingKeys.has(key) || seenKeys.has(key)) { duplicates++; continue; }
    seenKeys.add(key);

    const type = MEMORY_TYPES.includes(item.type) ? item.type : 'reference';
    const firstLine = content.split(/\r?\n/).find((l) => l.trim()) || '';
    const name = (String(item.name || '').trim() || firstLine.slice(0, 80) || '导入的记忆').slice(0, 200);
    const tags = Array.isArray(item.tags)
      ? [...new Set(item.tags.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
      : [];

    const record = {
      id: data.nextId,
      type,
      name,
      content: content.slice(0, 8000),
      description: String(item.description || '').slice(0, 1000),
      tags,
      pinned: item.pinned === true,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
      accessCount: typeof item.accessCount === 'number' ? item.accessCount : 0,
      lastAccessedAt: typeof item.lastAccessedAt === 'number' ? item.lastAccessedAt : now,
    };
    data.nextId += 1;
    data.memories.push(record);
    imported++;
  }

  writeRaw(data);
  console.log('[MemoryStore] 导入完成: 新增 ' + imported + ', 重复 ' + duplicates + ', 拒绝 ' + rejected);
  return { imported, duplicates, rejected };
}

/**
 * 导出记忆为 deepseek-pp 兼容格式（数组）
 */
function exportMemories() {
  const data = readRaw();
  return data.memories.map((m) => {
    let syncId = m.syncId;
    if (!syncId) {
      try { syncId = require('crypto').randomUUID(); } catch (_) { syncId = 'mem-' + m.id; }
    }
    return {
      syncId,
      scope: 'global',
      type: m.type,
      name: m.name,
      content: m.content,
      description: m.description || '',
      tags: m.tags || [],
      pinned: !!m.pinned,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      accessCount: m.accessCount || 0,
      lastAccessedAt: m.lastAccessedAt,
      id: m.id,
    };
  });
}

module.exports = {
  MEMORY_TYPES,
  MEMORY_TOKEN_BUDGET,
  estimateTokens,
  segmentText,
  selectMemories,
  formatMemoryLine,
  formatMemoriesBlock,
  init,
  getStoreFile,
  getAllMemories,
  getMemoryById,
  saveMemory,
  updateMemory,
  deleteMemory,
  touchMemories,
  buildMemorySection,
  importMemories,
  exportMemories,
};
