/**
 * 记忆存储与选择器（全局共享，JSON 持久化）
 * 移植自 deepseek-pp 的 core/memory（selector + store 简化版）。
 * 存储文件：<userData>/lingya-memory.json
 */
const fs = require('fs');
const path = require('path');
const { isSensitive } = require('./memory-redaction');

const MEMORY_TYPES = ['user', 'feedback', 'topic', 'reference'];
const MEMORY_TOKEN_BUDGET = 1500;

// ===== 记忆系统 v2 数据模型 =====
// scope: 记忆归属范围。'global' 或 'project:<项目名>'
// kind:  identity=身份偏好（常驻注入）；experience=项目经验（按需检索）
// confidence: verified=实测确认；hypothesis=推测
const MEMORY_SCOPES_GLOBAL = 'global';
const MEMORY_KINDS = ['identity', 'experience'];
const MEMORY_CONFIDENCE = ['verified', 'hypothesis'];

/** 把任意 scope 输入规范化为 'global' 或 'project:xxx' */
function normalizeScope(input) {
  const s = String(input || '').trim();
  if (!s || s === 'global') return MEMORY_SCOPES_GLOBAL;
  if (s.startsWith('project:')) {
    const name = s.slice('project:'.length).trim();
    return name ? 'project:' + name : MEMORY_SCOPES_GLOBAL;
  }
  // 裸项目名 → 补前缀
  return 'project:' + s;
}

/** 从 scope 里取项目名（global 返回 null） */
function getScopeProject(scope) {
  const s = String(scope || '');
  return s.startsWith('project:') ? s.slice('project:'.length) : null;
}

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
 * 名称相似度（0~1），用于冲突检测。
 * 用字符二元组 Jaccard 相似度，对中文友好，无需分词。
 */
function nameSimilarity(a, b) {
  const s1 = String(a || '').replace(/\s+/g, '');
  const s2 = String(b || '').replace(/\s+/g, '');
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const g1 = grams(s1), g2 = grams(s2);
  if (g1.size === 0 || g2.size === 0) return 0;
  let inter = 0;
  for (const g of g1) if (g2.has(g)) inter++;
  return inter / (g1.size + g2.size - inter);
}

/**
 * 检测新记忆与已有记忆的冲突（同名/高相似）。
 * 不自动合并——只返回候选，由调用方提示人工裁决。
 * @returns {Array<{memory, similarity, sameContent}>}
 */
function findConflicts(candidate, opts) {
  const o = opts || {};
  const threshold = typeof o.threshold === 'number' ? o.threshold : 0.8;
  const scope = normalizeScope(candidate.scope);
  const pool = getAllMemories().filter((m) => m.id !== candidate.id && m.scope === scope && !m.supersededBy);
  const out = [];
  for (const m of pool) {
    const sim = nameSimilarity(candidate.name, m.name);
    if (sim >= threshold) {
      out.push({
        memory: m,
        similarity: sim,
        sameContent: String(m.content || '').trim() === String(candidate.content || '').trim(),
      });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

/**
 * 扫描所有记忆的 content，检查里面提到的绝对路径是否存在。
 * 不存在的标记 stale=true（检索时降权），不删除。
 * @returns {{checked:number, stale:number, restored:number}}
 */
function refreshStaleFlags() {
  const data = readRaw();
  let checked = 0, stale = 0, restored = 0;
  const re = /[A-Za-z]:\\[^\s"'<>|*?\n，。；：、）】]+/g;
  for (const m of data.memories) {
    const hits = String(m.content || '').match(re);
    if (!hits || hits.length === 0) continue;
    checked++;
    let anyMissing = false;
    for (const p of hits.slice(0, 5)) {
      try { if (!fs.existsSync(p.replace(/[\\/]+$/, ''))) { anyMissing = true; break; } } catch (_) {}
    }
    if (anyMissing && !m.stale) { m.stale = true; stale++; }
    else if (!anyMissing && m.stale) { m.stale = false; restored++; }
  }
  writeRaw(data);
  return { checked, stale, restored };
}

/**
 * 四路融合检索（记忆系统 v2）
 *
 * score = 0.35*关键词 + 0.25*scope匹配 + 0.20*新鲜度 + 0.10*使用频率 + 0.10*可信度
 *
 * @param {string} query 查询词
 * @param {object} [opts]
 *   - scope: 当前项目 scope（'global' 或 'project:xxx'）；不传则只查 global
 *   - kind:  'identity' | 'experience' | undefined
 *   - limit: 返回条数上限，默认 10
 *   - includeCold: 是否包含冷记忆（默认 false）
 *   - includeSuperseded: 是否包含已被取代的（默认 false）
 * @returns {Array<{memory, score, parts}>}
 */
function searchMemories(query, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(50, Number(o.limit) || 10));
  const curScope = o.scope ? normalizeScope(o.scope) : MEMORY_SCOPES_GLOBAL;
  const promptWords = segmentText(query || '');
  const now = Date.now();

  let pool = getAllMemories().filter((m) => !isSensitive(m));

  if (!o.includeSuperseded) pool = pool.filter((m) => !m.supersededBy);
  if (o.kind) pool = pool.filter((m) => m.kind === o.kind);

  // scope 硬过滤：global + 当前项目
  pool = pool.filter((m) => m.scope === MEMORY_SCOPES_GLOBAL || m.scope === curScope);

  if (!o.includeCold) {
    pool = pool.filter((m) => {
      const cold = (m.accessCount || 0) < 3 && (now - (m.lastAccessedAt || 0)) > 180 * 86400000;
      return !cold;
    });
  }

  const scored = pool.map((m) => {
    const kw = keywordScore(promptWords, m);
    const kwNorm = Math.min(1, kw / 60);

    const scopeMatch = (m.scope && m.scope === curScope) ? 1 : 0;

    const days = (now - (m.lastAccessedAt || m.updatedAt || m.createdAt || 0)) / 86400000;
    const freshness = Math.max(0, 1 - days / 90);   // 90 天半衰期

    const usage = Math.min(1, Math.log((m.accessCount || 0) + 1) / Math.log(21));

    const conf = m.confidence === 'verified' ? 1 : 0;
    // 路径失效的记忆降权 50%
    const stalePenalty = m.stale ? 0.5 : 1;

    const score = (0.35 * kwNorm + 0.25 * scopeMatch + 0.20 * freshness + 0.10 * usage + 0.10 * conf) * stalePenalty;
    return { memory: m, score, parts: { kw: kwNorm, scope: scopeMatch, fresh: freshness, usage, conf, stale: !!m.stale } };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
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
      const raw = Array.isArray(parsed.memories) ? parsed.memories : [];
      // 惰性迁移：老记录缺 v2 字段时就地补齐（只在内存，下次写入时落盘）
      cache = {
        memories: raw.map(migrateMemoryFields),
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

/**
 * 给存量记忆补 v2 字段（惰性迁移）。
 * 幂等：已有正确字段的记录原样返回。
 */
function migrateMemoryFields(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (!out.scope) out.scope = MEMORY_SCOPES_GLOBAL;
  if (out.scope !== MEMORY_SCOPES_GLOBAL) {
    out.kind = 'experience';
  } else if (!MEMORY_KINDS.includes(out.kind)) {
    out.kind = (out.type === 'user' || out.type === 'feedback') ? 'identity' : 'experience';
  }
  if (!MEMORY_CONFIDENCE.includes(out.confidence)) out.confidence = 'verified';
  if (out.supersededBy === undefined) out.supersededBy = null;
  return out;
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
  const scope = normalizeScope(input.scope);
  // 项目 scope 的记忆一律是 experience（项目规则不是身份）
  const kind = scope === MEMORY_SCOPES_GLOBAL
    ? (MEMORY_KINDS.includes(input.kind) ? input.kind : (type === 'user' || type === 'feedback' ? 'identity' : 'experience'))
    : 'experience';
  const confidence = MEMORY_CONFIDENCE.includes(input.confidence) ? input.confidence : 'verified';
  return {
    type,
    kind,
    scope,
    confidence,
    name: name.slice(0, 200),
    content: content.slice(0, 8000),
    description: String(input.description || '').slice(0, 1000),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
      : [],
    pinned: input.pinned === true,
    supersededBy: null,
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

/**
 * 保存记忆并返回冲突候选（供工具层提示人工裁决）。
 * @returns {{id:number, conflicts:Array}}
 */
function saveMemoryWithConflictCheck(input) {
  const id = saveMemory(input);
  try {
    const saved = getMemoryById(id);
    const conflicts = findConflicts(saved, { threshold: 0.8 });
    return { id, conflicts };
  } catch (_) {
    return { id, conflicts: [] };
  }
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
 * 初始化注入用：选出记忆并格式化为文本块，并始终附带全部记忆的索引。
 *
 * 只注入"被选中的记忆正文"是不够的——模型看不到未选中记忆的存在，就不会主动检索。
 * 因此这里额外附一份**全部记忆的索引**（仅 id/类型/名称，不含正文，成本极低），
 * 让模型明确知道"有哪些记忆可用"，从而在需要时主动 memoryList() 取全文。
 */
// 2026-10-24 DeepSeek 封号根因 ②：421 条索引每条重复写全 type 名（reference 等），
// 缩成单字母，零信息损失（type 只有 4 种，且索引仅用于"知道有这条记忆"）。
const MEMORY_TYPE_ABBR = { reference: 'r', user: 'u', topic: 't', feedback: 'f' };

/** 过滤掉敏感记忆，返回可外发列表 */
function getVisibleMemories() {
  return getAllMemories().filter(function (m) { return !isSensitive(m); });
}


/**
 * 记忆系统 v2：生成结构化摘要（替代全量索引注入）
 *
 * 结构：
 *   【你】identity 记忆（限 15 条 / 500 字符）
 *   【当前项目】experience 记忆标题（限 5 条 / 200 字符）
 *   检索指令
 *
 * @param {object} [options] { projectDir?: string }
 * @returns {string}
 */
function buildMemoryDigest(options) {
  const o = options || {};
  const visible = getVisibleMemories();
  if (visible.length === 0) return '';

  const curScope = o.projectDir
    ? normalizeScope(path.basename(o.projectDir))
    : MEMORY_SCOPES_GLOBAL;
  const projectName = getScopeProject(curScope);

  const lines = [];

  // ---- 身份层：全量，按 pinned + 使用频率排序 ----
  const identities = visible
    .filter((m) => m.kind === 'identity')
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.accessCount || 0) - (a.accessCount || 0))
    .slice(0, 15);

  if (identities.length > 0) {
    let budget = 500;
    const parts = [];
    for (const m of identities) {
      const seg = m.name;
      if (budget - seg.length < 0) break;
      parts.push(seg);
      budget -= seg.length + 2;
    }
    if (parts.length > 0) lines.push('【你】' + parts.join(' · '));
  }

  // ---- 经验层：只给当前项目标题 ----
  const projectMemories = visible.filter((m) => m.kind === 'experience' && m.scope === curScope);
  if (projectName && projectMemories.length > 0) {
    const top = projectMemories
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.accessCount || 0) - (a.accessCount || 0))
      .slice(0, 5);
    lines.push('');
    lines.push('【当前项目：' + projectName + '】' + projectMemories.length + ' 条经验');
    lines.push(top.map((m) => m.name).join(' · '));
  }

  // ---- 检索指令 ----
  lines.push('');
  lines.push('> 记忆库共 ' + visible.length + ' 条，不会自动出现在上下文。遇到具体项目/路径/配置/报错/发布操作，先调 memoryRecall("关键词") 再回答，别凭印象。');

  return lines.join('\n');
}

function buildMemorySectionMinimal(options = {}) {
  const memories = getVisibleMemories();
  if (memories.length === 0) return formatMemoriesBlock([]);
  const NL = String.fromCharCode(10);
  const topN = Math.max(1, Math.min(5, Number(options.topN || 3)));
  const selected = selectMemories(memories, Object.assign({}, options, { budget: 1000000 })).slice(0, topN);
  if (selected.length > 0) touchMemories(selected.map(function (m) { return m.id; }));
  const lines = selected.map(function (m) {
    const abbr = MEMORY_TYPE_ABBR[m.type] || String(m.type || "r")[0];
    const name = String(m.name || "").slice(0, 60);
    const content = String(m.content || "");
    const preview = content.slice(0, 100);
    return "-#" + m.id + abbr + " " + name + (preview ? "：" + preview + (content.length > 100 ? "…" : "") : "");
  });
  return ["【长期记忆】共 " + memories.length + " 条；仅注入最相关 " + selected.length + " 条摘要。", lines.join(NL), "> 凡任务可能涉及凭证/token/密钥/路径/配置/端口/账号、用户偏好、历史决策、之前项目，或不确定是否已有相关记忆，先调用 memoryList() 取全文，不要凭猜测、不要等用户提醒。"].join(NL + NL);
}
function buildMemorySection(options) {
  const memories = getVisibleMemories();
  if (memories.length === 0) return formatMemoriesBlock([]);
  const selected = selectMemories(memories, options);
  if (selected.length > 0) touchMemories(selected.map((m) => m.id));
  let block = formatMemoriesBlock(selected);

  const selectedIds = new Set(selected.map((m) => m.id));
  const omitted = memories.filter((m) => !selectedIds.has(m.id));
  if (omitted.length > 0) {
    block += '\n\n【全部记忆索引】（仅标题；正文未覆盖下列条目，需要时用 memoryList() 取全文）：\n' +
      omitted.map((m) => '-#' + m.id + (MEMORY_TYPE_ABBR[m.type] || String(m.type || 'r')[0]) + ' ' + m.name).join('\n');
  }
  block += '\n\n> 判断标准：只要任务可能与上述任一条目相关（如用到凭证/token/路径/配置/历史决策/用户偏好），就应**先调用 memoryList() 取全文**，不要凭猜测行事、也不要等用户提醒。';
  return block;
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
  buildMemorySectionMinimal,
  getVisibleMemories,
  searchMemories,
  buildMemoryDigest,
  findConflicts,
  refreshStaleFlags,
  saveMemoryWithConflictCheck,
  nameSimilarity,
  normalizeScope,
  getScopeProject,
  migrateMemoryFields,
  MEMORY_SCOPES_GLOBAL,
  MEMORY_KINDS,
  MEMORY_CONFIDENCE,
  importMemories,
  exportMemories,
};
