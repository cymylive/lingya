/**
 * Skill 技能存储（全局共享，JSON 持久化）
 * 支持：自定义技能 + 本地文件夹导入（扫描子目录中的 SKILL.md）。
 * 存储文件：<userData>/lingya-skills.json
 */
const fs = require('fs');
const path = require('path');

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-skills.json');
  cache = null;
  console.log('[SkillStore] 存储文件:', STORE_FILE);
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
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      };
      return cache;
    }
  } catch (err) {
    console.error('[SkillStore] 读取失败:', err.message);
  }
  cache = { skills: [] };
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
    console.error('[SkillStore] 写入失败:', err.message);
  }
}

function getAllSkills() {
  return readRaw().skills.map((s) => ({ ...s }));
}

function getSkillByName(name) {
  return readRaw().skills.find((s) => s.name === name) || null;
}

// ========== 提示词注入 ==========

/**
 * 简易 token 估算：CJK 约 0.6，ASCII 约 0.3（与 memory-store 口径一致）
 */
function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text || '')) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

/**
 * 构建技能注入块：仅含已启用的技能，按 token 预算截断
 * @param {{maxTokens?: number}} [options]
 * @returns {string}
 */
/** 取描述首句并截断到 maxLen（渐进式披露用，避免描述过长撑爆索引） */
function firstSentence(text, maxLen) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // 中文按 。！？ 断句；英文只在 ". " / "! " / "? " 或行尾断句（避免 "e.g." "v1.0" 被误截）
  const m = s.match(/^[^。！？\n]*?[。！？]|^[\s\S]*?[.!?](?=\s|$)/);
  if (m) s = m[0];
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

/**
 * 构建技能注入块：渐进式披露（对齐 Claude Code / Cuckoo Code）
 *
 * 旧实现按数组顺序拼「### name + description + instructions 全文」，超 4000 token 就 break，
 * 结果装了几十个技能时只有排最前的 2 个进得去，其余全部静默丢弃。
 *
 * 新实现分两类：
 *  - 有本地 SKILL.md 的技能（source=local 且 localPath）：只注入 name + 首句描述 + 路径，
 *    AI 在任务相关时用 read 读取全文 —— 索引体积远小于全文，可全部列出。
 *  - 无本地文件的技能：内联全文（AI 无法 read，只能直接给）。
 *
 * @param {{maxTokens?: number}} [options] maxTokens 仅用于兜底截断索引行数（默认 20000）
 * @returns {string}
 */
/**
 * 计算一组路径的公共目录前缀（不含最后一段）。
 * 把重复的路径根抽到索引头部，行内只留相对目录，削减首条消息体积。
 * 2026-10-24 DeepSeek 封号根因 ②：173 条索引每条都重复完整路径根。
 */
function commonPathPrefix(paths) {
  if (!paths || paths.length === 0) return '';
  const split = paths.map((p) => String(p).split(/[\\/]+/).filter(Boolean));
  const first = split[0];
  const segs = [];
  for (let i = 0; i < first.length - 1; i++) {
    const seg = first[i];
    if (split.every((s) => s[i] === seg)) segs.push(seg);
    else break;
  }
  return segs.join('\\');
}

/**
 * 选择“多数路径前缀”：统计所有祖先目录出现次数，选覆盖条目最多且至少 2 条的前缀。
 * 用于避免单个异根路径把全局公共前缀打成空串。
 *
 * 2026-10-24 实测：173 个本地技能中 172 个位于 H:\skills，1 个位于 C:\Users...；
 * 全局 commonPathPrefix 因这 1 条异根返回空串，导致 H:\skills\ 前缀无法剥离。
 */
function chooseDominantPathPrefix(paths) {
  const counts = new Map();
  for (const p of paths || []) {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    // 不包含最后一段文件名，只统计目录前缀。
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('\\');
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  // 选择“足够多数且尽可能深”的前缀：覆盖至少 60% 条目，在满足阈值的候选里取最长。
  // 这样可避免 H: 这种浅前缀因多覆盖 1 条异根而压过 H:\skills 的实际收益。
  const threshold = Math.max(2, Math.ceil((paths || []).length * 0.6));
  let best = '';
  counts.forEach((count, prefix) => {
    if (count >= threshold && prefix.length > best.length) {
      best = prefix;
    }
  });
  return best;
}

function pathStartsWith(p, prefix) {
  const ps = String(p).replace(/\//g, '\\').toUpperCase();
  const xs = String(prefix).replace(/\//g, '\\').toUpperCase();
  return ps === xs || ps.startsWith(xs + '\\');
}


function buildSkillSectionMinimal(options = {}) {
  const skills = readRaw().skills.filter(function (s) { return s.enabled !== false; });
  if (skills.length === 0) return "";
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  const topN = Math.max(1, Math.min(10, Number(options.topN || 5)));
  function byUpdated(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }

  // 相关性打分：传了 options.prompt 时，按 name/description 的关键词命中数排序，
  // 命中数相同再按 updatedAt 倒序。不传 prompt（旧调用方）时行为与原来完全一致。
  // 【为什么需要】原来只按 updatedAt 取最近 5 个，与当前项目毫无关系——
  // 173 个技能里挑出来的往往和用户手上在干的事完全不相干。
  const promptWords = String(options.prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(function (w) { return w.length >= 2; });
  function relevanceScore(s) {
    if (promptWords.length === 0) return 0;
    const hay = (String(s.name || '') + ' ' + String(s.description || '')).toLowerCase();
    let hit = 0;
    for (let i = 0; i < promptWords.length; i++) {
      if (hay.indexOf(promptWords[i]) !== -1) hit++;
    }
    return hit;
  }
  function byRelevance(a, b) {
    const d = relevanceScore(b) - relevanceScore(a);
    return d !== 0 ? d : byUpdated(a, b);
  }
  const sorter = promptWords.length > 0 ? byRelevance : byUpdated;
  function stripSkillMd(p) {
    p = String(p);
    const up = p.toUpperCase();
    if (up.length >= 9 && up.slice(-9) === BS + "SKILL.MD") return p.slice(0, -9);
    if (up.length >= 9 && up.slice(-9) === "/SKILL.MD") return p.slice(0, -9);
    return p;
  }
  const localSkills = skills.filter(function (s) { return s.source === "local" && s.localPath; });
  const inlineSkills = skills.filter(function (s) { return !(s.source === "local" && s.localPath); });
  const selectedLocal = localSkills.slice().sort(sorter).slice(0, topN);
  const selectedInline = inlineSkills.slice().sort(sorter).slice(0, Math.max(0, topN - selectedLocal.length));
  const prefix = (typeof chooseDominantPathPrefix === "function" && localSkills.length > 1) ? chooseDominantPathPrefix(localSkills.map(function (s) { return s.localPath; })) : "";
  const localLines = selectedLocal.map(function (s) {
    const desc = firstSentence(s.description, 40);
    let shown = String(s.localPath);
    if (prefix) {
      const normShown = shown.split("/").join(BS);
      const normPrefix = String(prefix).split("/").join(BS);
      const cmp = normShown.toUpperCase();
      const xcmp = normPrefix.toUpperCase();
      if (cmp === xcmp || cmp.indexOf(xcmp + BS) === 0) {
        shown = normShown.slice(xcmp.length);
        if (shown.charAt(0) === BS) shown = shown.slice(1);
      }
    }
    shown = stripSkillMd(shown);
    return "- " + s.name + (desc ? ": " + desc : "") + (shown ? " | " + shown : "");
  });
  const inlineLines = selectedInline.map(function (s) {
    const desc = firstSentence(s.description, 40);
    return "- " + s.name + (desc ? ": " + desc : "") + " | 内联技能（用 skillList({ name, includeInstructions: true }) 取全文）";
  });
  const parts = ["【技能】共 " + skills.length + " 个已启用技能；仅注入最近/默认 " + (localLines.length + inlineLines.length) + " 个摘要。"];
  if (prefix) parts.push("默认技能路径根：" + prefix + " 下的 SKILL.md。");
  if (localLines.length) parts.push("本地技能摘要：" + NL + localLines.join(NL));
  if (inlineLines.length) parts.push("内联技能摘要：" + NL + inlineLines.join(NL));
  parts.push("> 需要查找其他技能时调用 skillList({ query })；任务相关时，本地技能先 read 对应 SKILL.md，内联技能用 skillList({ name, includeInstructions: true }) 取全文后再执行。");
  return parts.join(NL);
}
/**
 * 计算技能与当前项目的相关度（P2）。
 * 三段加权：项目名命中描述 > 历史使用频率 > 最近使用时间。
 * @param {object} skill
 * @param {string[]} projectWords 当前项目名拆出的关键词（小写）
 */
function relevanceScore(skill, projectWords) {
  let score = 0;
  if (projectWords && projectWords.length > 0) {
    const hay = (String(skill.name || '') + ' ' + String(skill.description || '')).toLowerCase();
    for (const w of projectWords) {
      // 中文双字词（如"音乐""发布"）信息量足够，不能按英文的 >2 标准过滤
      const minLen = /[\u4e00-\u9fa5]/.test(w) ? 2 : 3;
      if (w.length >= minLen && hay.includes(w)) score += 100;
    }
  }
  // 使用频率：log 抑制长尾，用过的浮上来
  score += Math.log((skill.useCount || 0) + 1) * 10;
  // 最近使用：7 天内用过加权
  if (skill.lastUsedAt) {
    const days = (Date.now() - skill.lastUsedAt) / 86400000;
    if (days < 7) score += 20 * (1 - days / 7);
  }
  // 置顶/内置技能轻微加权（本地技能优先于内联）
  if (skill.source === 'local') score += 5;
  return score;
}

/**
 * 从项目路径里提取关键词（用于相关性打分）
 * 例：C:\...\AI音乐自动发布机 → ['ai音乐自动发布机', '音乐', '发布']
 */
function projectKeywords(projectDir) {
  if (!projectDir) return [];
  const base = String(projectDir).split(/[\\/]+/).filter(Boolean).pop() || '';
  const lower = base.toLowerCase();
  const out = [lower];
  // 中文按 2-4 字滑窗补一些短词（避免只命中全名）
  const cjk = base.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of cjk) {
    if (seg.length <= 4) out.push(seg);
    else { out.push(seg.slice(0, 2)); out.push(seg.slice(0, 3)); }
  }
  // 英文按非字母数字切
  const en = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set([...out, ...en])];
}

function buildSkillSection(options = {}) {
  const allSkills = readRaw().skills.filter((s) => s.enabled !== false);
  if (allSkills.length === 0) return '';

  const opts = options || {};
  const keywords = projectKeywords(opts.projectDir);

  // 先按相关度排序（稳定：同分按名字）
  const ranked = allSkills
    .map((s) => ({ skill: s, score: relevanceScore(s, keywords) }))
    .sort((a, b) => b.score - a.score || String(a.skill.name).localeCompare(String(b.skill.name)))
    .map((x) => x.skill);

  // 分层：有相关信号的进「推荐」区，其余进「全部」区
  const recommended = keywords.length > 0
    ? ranked.filter((s) => relevanceScore(s, keywords) >= 100).slice(0, 6)
    : [];
  const recommendedNames = new Set(recommended.map((s) => s.name));
  const rest = ranked.filter((s) => !recommendedNames.has(s.name));

  const skills = rest;
  const localSkills = skills.filter((s) => s.source === 'local' && s.localPath);
  const inlineSkills = skills.filter((s) => !(s.source === 'local' && s.localPath));
  // 仅当存在多个本地技能时才抽前缀：只有 1 个时前缀等于其完整父目录，
  // 行内相对目录会被清空，AI 将无法还原 SKILL.md 路径。
  //
  // 不用全局 commonPathPrefix：实测 1 条异根路径会让 172 条主技能根的公共前缀整体失效。
  // 改用多数根目录策略，少数异根条目在行内保留完整路径。
  const prefix = localSkills.length > 1
    ? chooseDominantPathPrefix(localSkills.map((s) => s.localPath))
    : '';

  const indexLines = localSkills.map((s) => {
    // P3：按句末标点切首句，上限 45 挡住极长单句（推荐区用完整描述，不受此限）
    const desc = firstSentence(s.description, 45);
    let rel = String(s.localPath);
    if (prefix && pathStartsWith(rel, prefix)) rel = rel.slice(prefix.length).replace(/^[\\/]+/, '');
    rel = rel.replace(/[\\/]SKILL\.md$/i, '');
    return '- ' + s.name + (desc ? ': ' + desc : '') + (rel ? ' | ' + rel : '');
  });

  const inlineBlocks = inlineSkills.map((s) =>
    '### ' + s.name + (s.description ? '（' + s.description + '）' : '') + '\n' + s.instructions);

  const parts = [];

  // 推荐区：与当前项目相关的技能，给完整描述不截断
  if (recommended.length > 0) {
    const recLines = recommended.map((s) => {
      const desc = String(s.description || '').replace(/\s+/g, ' ').trim();
      const rel = s.localPath
        ? (prefix && pathStartsWith(s.localPath, prefix)
          ? s.localPath.slice(prefix.length).replace(/^[\\/]+/, '').replace(/[\\/]SKILL\.md$/i, '')
          : String(s.localPath).replace(/[\\/]SKILL\.md$/i, ''))
        : '';
      return '- ' + s.name + (desc ? ': ' + desc : '') + (rel ? ' | ' + rel : '');
    });
    parts.push('### 当前项目推荐技能（' + recommended.length + ' 个）\n' + recLines.join('\n'));
  }

  if (indexLines.length) {
    const body = indexLines.join('\n');
    const t = estimateTokens(body);
    const rootNote = prefix ? '默认路径根：' + prefix + '\\<目录>\\SKILL.md\n' : '';
    parts.push(
      '### 其余技能（共 ' + indexLines.length + ' 个，约 ' + t + ' tokens）\n' +
      rootNote +
      '行内格式「名称: 简介 | 相对目录；少数异根条目为完整目录」。任务相关时先用 read 读取其 SKILL.md 全文再执行：\n\n' +
      body
    );
  }
  if (inlineBlocks.length) {
    parts.push('### 完整技能指令（无本地文件，直接注入）\n' + inlineBlocks.join('\n\n'));
  }
  return parts.join('\n\n');
}

function normalizeSkill(input) {
  const name = String(input.name || '').trim();
  const instructions = String(input.instructions || '').trim();
  if (!name) throw new Error('技能 name 不能为空');
  if (!instructions) throw new Error('技能 instructions 不能为空');
  return {
    name: name.slice(0, 100),
    description: String(input.description || '').slice(0, 500),
    instructions: instructions.slice(0, 50000),
    source: input.source === 'local' ? 'local' : 'custom',
    memoryEnabled: input.memoryEnabled !== false,
    enabled: input.enabled !== false,
    localPath: input.localPath || null,
    // 使用统计（P1）：用于索引排序，判断哪些技能真的在用
    useCount: Number(input.useCount) || 0,
    lastUsedAt: Number(input.lastUsedAt) || null,
    updatedAt: Date.now(),
  };
}

/**
 * 保存（新增或按 name 覆盖）自定义技能
 */
function saveSkill(input) {
  const skill = normalizeSkill({ ...input, source: input.source || 'custom' });
  const data = readRaw();
  const idx = data.skills.findIndex((s) => s.name === skill.name);
  if (idx >= 0) {
    data.skills[idx] = { ...data.skills[idx], ...skill };
  } else {
    data.skills.push({ ...skill, createdAt: Date.now() });
  }
  writeRaw(data);
  console.log('[SkillStore] 已保存技能: ' + skill.name);
  return skill.name;
}

function deleteSkill(name) {
  const data = readRaw();
  const before = data.skills.length;
  data.skills = data.skills.filter((s) => s.name !== name);
  if (data.skills.length === before) throw new Error('技能 "' + name + '" 不存在');
  writeRaw(data);
  console.log('[SkillStore] 已删除技能: ' + name);
  return true;
}

/**
 * 记录技能被使用（P1）。
 * 调用点：skillList({ name }) 查到技能时、read SKILL.md 后由上层调用。
 * @param {string|string[]} names 技能名或名字数组
 */
function touchSkill(names) {
  const arr = Array.isArray(names) ? names : [names];
  if (arr.length === 0) return;
  const data = readRaw();
  const now = Date.now();
  let changed = false;
  for (const s of data.skills) {
    if (arr.includes(s.name)) {
      s.useCount = (s.useCount || 0) + 1;
      s.lastUsedAt = now;
      changed = true;
    }
  }
  if (changed) writeRaw(data);
}

function setSkillEnabled(name, enabled) {
  const data = readRaw();
  const skill = data.skills.find((s) => s.name === name);
  if (!skill) throw new Error('技能 "' + name + '" 不存在');
  skill.enabled = !!enabled;
  skill.updatedAt = Date.now();
  writeRaw(data);
  return true;
}

// ========== 本地文件夹导入 ==========

/**
 * 解析 SKILL.md：可选 YAML frontmatter（--- 包裹）+ 正文
 * @returns {{ name, description, instructions }}
 */
/**
 * 解析 YAML frontmatter 头部（只处理 SKILL.md 会用到的最小子集）。
 *
 * 支持三种值形态：
 *   1. 单行：  name: apk-reverse
 *   2. 折叠块：description: >       （> 折成空格，>- 去掉末尾换行，| 保留换行）
 *             多行文本
 *             继续多行
 *   3. 引号：  description: "xxx"
 *
 * 【为什么必须支持折叠块】173 个本地技能里有 9 个用 `description: >` 写多行描述。
 * 旧实现只取冒号后那一行，结果 description 变成字面量 ">" / ">-" / "|"，
 * 这 9 个技能在索引里等于隐身（AI 看到「apk-reverse: >」完全不知道是干什么的）。
 *
 * @param {string} header frontmatter 内部文本（不含 --- 分隔线）
 * @returns {Record<string, string>}
 */
function parseFrontmatter(header) {
  const out = {};
  const lines = String(header || '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }

    const key = m[1].toLowerCase();
    let rest = m[2].trim();

    // 折叠块标记：> | >- |- | >+ | |+
    const blockMatch = /^([>|])([+-]?)\s*$/.exec(rest);
    if (blockMatch) {
      const style = blockMatch[1];       // '>' 折成空格，'|' 保留换行
      const chomp = blockMatch[2];       // '-' 去尾换行，'+' 保留全部
      const collected = [];
      i++;
      // 后续行：以空白开头，或空行（空行属于块内）
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { collected.push(''); i++; continue; }
        if (!/^\s/.test(l)) break;      // 回到顶格 → 块结束
        collected.push(l.replace(/^\s+/, ''));
        i++;
      }
      // 去掉尾部空行（chomp '-' 或默认行为）
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      rest = style === '|'
        ? collected.join('\n')
        : collected.join(' ').replace(/\s+/g, ' ').trim();
      out[key] = rest;
      continue;
    }

    // 单行值：去引号
    rest = rest.replace(/^["']|["']$/g, '');
    out[key] = rest;
    i++;
  }
  return out;
}

function parseSkillDoc(content, fallbackName) {
  let text = String(content || '');
  let name = fallbackName || '';
  let description = '';
  let body = text;

  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (fm) {
    const header = fm[1];
    body = fm[2];
    const fields = parseFrontmatter(header);
    if (fields.name) name = fields.name;
    if (fields.description) description = fields.description;
  }

  const instructions = body.trim();
  if (!name) throw new Error('SKILL.md 缺少 name（frontmatter 或目录名）');
  if (!instructions) throw new Error('SKILL.md 正文为空');
  return { name, description, instructions };
}

/**
 * 从本地文件夹导入技能：扫描 rootPath 下含 SKILL.md 的目录（含根本身）
 * @returns {{ imported: number, skills: string[], warnings: string[] }}
 */
function importFromFolder(rootPath) {
  const warnings = [];
  const importedSkills = [];
  if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error('目录不存在: ' + rootPath);
  }

  const dirs = [rootPath];
  try {
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(rootPath, entry.name));
    }
  } catch (err) {
    throw new Error('读取目录失败: ' + err.message);
  }

  for (const dir of dirs) {
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const raw = fs.readFileSync(skillFile, 'utf-8');
      const fallbackName = path.basename(dir);
      const parsed = parseSkillDoc(raw, fallbackName);
      saveSkill({
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        source: 'local',
        localPath: skillFile,
      });
      importedSkills.push(parsed.name);
    } catch (err) {
      warnings.push(path.basename(dir) + ': ' + err.message);
    }
  }

  if (importedSkills.length === 0 && warnings.length === 0) {
    warnings.push('未找到任何 SKILL.md 文件');
  }
  return { imported: importedSkills.length, skills: importedSkills, warnings };
}

module.exports = {
  init,
  getStoreFile,
  getAllSkills,
  getSkillByName,
  saveSkill,
  deleteSkill,
  touchSkill,
  setSkillEnabled,
  importFromFolder,
  parseSkillDoc,
  buildSkillSection,
  buildSkillSectionMinimal,
};
