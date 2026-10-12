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
function buildSkillSection(options = {}) {
  const skills = readRaw().skills.filter((s) => s.enabled !== false);
  if (skills.length === 0) return '';

  const indexLines = [];
  const inlineBlocks = [];

  for (const s of skills) {
    const hasPath = s.source === 'local' && s.localPath;
    if (hasPath) {
      const desc = firstSentence(s.description, 60);
      indexLines.push('- ' + s.name + (desc ? ': ' + desc : '') + ' | 路径: ' + s.localPath);
    } else {
      inlineBlocks.push('### ' + s.name + (s.description ? '（' + s.description + '）' : '') + '\n' + s.instructions);
    }
  }

  const parts = [];
  if (indexLines.length) {
    const body = indexLines.join('\n');
    const t = estimateTokens(body);
    parts.push(
      '### 技能索引（共 ' + indexLines.length + ' 个，按需读取全文）\n' +
      '以下技能只提供名称、简介和 SKILL.md 路径。当任务与某技能相关时，**必须先用 read 读取其 SKILL.md 全文**，再按其中指令执行。索引总占用约 ' + t + ' tokens：\n\n' +
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
function parseSkillDoc(content, fallbackName) {
  let text = String(content || '');
  let name = fallbackName || '';
  let description = '';
  let body = text;

  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (fm) {
    const header = fm[1];
    body = fm[2];
    for (const line of header.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      let value = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'name') name = value;
      else if (key === 'description') description = value;
    }
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
  setSkillEnabled,
  importFromFolder,
  parseSkillDoc,
  buildSkillSection,
};
