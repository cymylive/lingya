/**
 * 脱敏映射存储（2026-11-02）
 *
 * 双向脱敏：
 *   正向（preload → 网页端）：真词 → 占位符 ⟦项目A⟧
 *   反向（网页端 → 工具）：占位符 ⟦项目A⟧ → 真词
 *
 * 存储文件：<userData>/lingya-redaction.json
 *
 * 【设计原则】
 * 1. 占位符用 ⟦ ⟧ 包裹（U+27E6 / U+27E7），几乎是零碰撞的特殊符号。
 * 2. 每条规则 = { name, words[], desc, enabled, source, scope }。
 *    - name：占位符内容，如 "项目A"
 *    - words：命中的真词列表（多对一）
 *    - desc：给 AI 看的描述（不含真词）
 *    - enabled：是否启用
 *    - source：'manual'（用户手动加）| 'auto'（AI 扫描自动加）
 *    - scope：'global'（全链路生效）| 'memory-only'（只影响记忆检索）
 *    auto 规则默认 memory-only，防止误伤用户输入；manual 默认 global。
 * 3. 存储格式：{ version: 2, rules: [...] }
 */
const fs = require('fs');
const path = require('path');

let storePath = null;

function getStorePath() {
  if (storePath) return storePath;
  try {
    const { app } = require('electron');
    storePath = path.join(app.getPath('userData'), 'lingya-redaction.json');
  } catch (_) {
    storePath = path.join(process.cwd(), 'lingya-redaction.json');
  }
  return storePath;
}

/** 通用词黑名单：这些词不加脱敏规则（避免正常对话被误伤） */
const COMMON_WORDS = new Set([
  '上传', '下载', '接口', '文件', '脚本', '数据', '批量', '自动', '配置', '部署',
  '测试', '文档', '日志', '服务', '客户端', '服务器', '请求', '响应', '解析',
  '登录', '注册', '账号', '密码', '权限', '管理', '用户', '系统', '平台', '功能',
  '模块', '函数', '变量', '类', '对象', '数组', '字符串', '数字', '布尔',
  '项目', '任务', '工具', '流程', '进度', '状态', '结果', '输出', '输入',
  '文件上传', '文件下载', '错误', '异常', '提示', '消息', '通知', '记录',
  '创建', '删除', '修改', '查询', '更新', '同步', '导入', '导出', '备份'
]);

/** 默认规则表（仅首次启动写入；用户可增删改） */
const DEFAULT_RULES = {
  version: 2,
  rules: [
    { name: '项目A', words: ['bdwkup'], desc: '一个百度文库相关的自动化项目', enabled: true, source: 'manual', scope: 'global' },
    { name: '项目B', words: ['wenku_sim'], desc: '一个文库上传工具包', enabled: true, source: 'manual', scope: 'global' },
    { name: '项目C', words: ['acmcoder', 'eztest', 'joytest'], desc: '一个在线考试平台相关工具', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作1', words: ['养号', '账号养护'], desc: '账号维护流程', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作2', words: ['a_bogus', 'abogus'], desc: '某平台接口的签名参数', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作3', words: ['爬虫', '抓取接口', '接口逆向'], desc: '数据获取相关工作', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作4', words: ['风控', '限流', '封号'], desc: '平台限制相关内容', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作5', words: ['番茄签署', '批量签署'], desc: '批量合同操作', enabled: true, source: 'manual', scope: 'global' }
  ]
};

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  const p = getStorePath();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.rules)) {
        // 兼容旧版（v1 没有 source/scope），自动补默认值
        const normalized = [];
        let migrated = false;
        for (const r of data.rules) {
          const words = Array.isArray(r.words) ? r.words.slice() : [];
          const base = {
            name: r.name,
            words: words,
            desc: r.desc || '',
            enabled: r.enabled !== false,
            source: r.source || 'manual',
            scope: r.scope || 'global'
          };
          // 【审计修复 2026-11-02】多词规则自动拆分（防止反向还原丢失语义）
          if (words.length > 1) {
            migrated = true;
            for (let i = 0; i < words.length; i++) {
              normalized.push({
                name: r.name + '_' + (i + 1),
                words: [words[i]],
                desc: (r.desc || '') + ' (' + (i + 1) + '/' + words.length + ')',
                enabled: base.enabled,
                source: base.source,
                scope: base.scope
              });
            }
          } else {
            normalized.push(base);
          }
        }
        data.rules = normalized;
        cache = data;
        if (migrated) {
          console.log('[Redaction] 已迁移多词规则（拆分为单词语义）');
          persist();
        }
        return cache;
      }
    }
  } catch (err) {
    console.warn('[Redaction] 读取规则文件失败，使用默认:', err.message);
  }
  cache = JSON.parse(JSON.stringify(DEFAULT_RULES));
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
    console.log('[Redaction] 已初始化默认规则表:', p);
  } catch (err) {
    console.warn('[Redaction] 写入默认规则表失败:', err.message);
  }
  return cache;
}

function listRules() {
  const data = ensureLoaded();
  return (data.rules || []).map((r) => ({
    name: r.name,
    words: Array.isArray(r.words) ? r.words.slice() : [],
    desc: r.desc || '',
    enabled: r.enabled !== false,
    source: r.source || 'manual',
    scope: r.scope || 'global'
  }));
}

/** 只取启用的规则，供脱敏引擎用；scopeFilter 为 null=全部，'global'=只拿全局 */
function getActiveRules(scopeFilter) {
  const all = listRules().filter((r) => r.enabled);
  if (!scopeFilter) return all;
  if (scopeFilter === 'global') return all.filter((r) => r.scope === 'global');
  return all.filter((r) => r.scope === scopeFilter);
}

function addRule(rule) {
  const data = ensureLoaded();
  if (!rule || !rule.name) throw new Error('规则必须有 name');
  const words = Array.isArray(rule.words) ? rule.words.map(String) : [];
  if (words.length === 0) throw new Error('真词列表不能为空');

  // 【审计修复 2026-11-02】多词自动拆成多条规则
  // 为什么：一占位符对多词时，反向还原（AI 传参 → 工具）无法确定用哪个词，
  // 会全部还原成 words[0]，导致语义丢失（实测 acmcoder+eztest → 都变成 acmcoder）。
  // 拆成多条：⟦项目C_1⟧ → acmcoder, ⟦项目C_2⟧ → eztest, ... 100% 可逆。
  const out = [];
  if (words.length === 1) {
    out.push(applyOne(rule.name, words[0], rule));
  } else {
    const baseName = String(rule.name);
    for (let i = 0; i < words.length; i++) {
      const subName = baseName + '_' + (i + 1);
      const subDesc = (rule.desc || '') + ' (' + (i + 1) + '/' + words.length + ')';
      out.push(applyOne(subName, words[i], { ...rule, desc: subDesc }));
    }
    // 如果原 name 已存在（旧的多词规则），删掉它
    const oldIdx = (data.rules || []).findIndex((r) => r.name === baseName);
    if (oldIdx >= 0) data.rules.splice(oldIdx, 1);
  }
  persist();
  return words.length === 1 ? out[0] : out;
}

/** 辅助：应用单条规则到 data（内部用） */
function applyOne(name, word, rule) {
  const data = ensureLoaded();
  const idx = (data.rules || []).findIndex((r) => r.name === name);
  const normalized = {
    name: String(name),
    words: [String(word)],
    desc: String(rule.desc || ''),
    enabled: rule.enabled !== false,
    source: rule.source === 'auto' ? 'auto' : 'manual',
    scope: rule.scope === 'memory-only' ? 'memory-only' : 'global'
  };
  if (idx >= 0) {
    data.rules[idx] = normalized;
  } else {
    data.rules = data.rules || [];
    data.rules.push(normalized);
  }
  return normalized;
}

function updateRule(name, patch) {
  const data = ensureLoaded();
  const idx = (data.rules || []).findIndex((r) => r.name === name);
  if (idx < 0) throw new Error('规则不存在: ' + name);
  const cur = data.rules[idx];
  // 只允许改 words/desc/enabled/scope，不允许改 name/source
  if (patch.words) cur.words = patch.words.map(String);
  if (patch.desc != null) cur.desc = String(patch.desc);
  if (patch.enabled != null) cur.enabled = !!patch.enabled;
  if (patch.scope != null) cur.scope = (patch.scope === 'memory-only' ? 'memory-only' : 'global');
  persist();
  return cur;
}

function deleteRule(name) {
  const data = ensureLoaded();
  const before = (data.rules || []).length;
  data.rules = (data.rules || []).filter((r) => r.name !== name);
  if (data.rules.length === before) throw new Error('规则不存在: ' + name);
  persist();
  return true;
}

/** 一键撤销所有 auto 规则（保留 manual） */
function deleteAllAutoRules() {
  const data = ensureLoaded();
  const before = (data.rules || []).length;
  data.rules = (data.rules || []).filter((r) => r.source !== 'auto');
  persist();
  return before - data.rules.length;
}

/** 一键把某条 auto 规则扩展到全局 */
function promoteToGlobal(name) {
  const data = ensureLoaded();
  const r = (data.rules || []).find((x) => x.name === name);
  if (!r) throw new Error('规则不存在: ' + name);
  r.scope = 'global';
  persist();
  return r;
}

/** 批量把最近一次 auto 添加的规则扩展到全局 */
function promoteRecentAutoToGlobal() {
  const data = ensureLoaded();
  let count = 0;
  for (const r of (data.rules || [])) {
    if (r.source === 'auto' && r.scope === 'memory-only') {
      r.scope = 'global';
      count++;
    }
  }
  if (count > 0) persist();
  return count;
}

function persist() {
  const p = getStorePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Redaction] 落盘失败:', err.message);
  }
}

function redactText(text) {
  if (!text || typeof text !== 'string') return text;
  const rules = getActiveRules();
  const pairs = [];
  for (const r of rules) {
    for (const w of r.words) {
      if (w) pairs.push({ word: w, placeholder: '⟦' + r.name + '⟧' });
    }
  }
  pairs.sort((a, b) => b.word.length - a.word.length);
  let out = text;
  for (const { word, placeholder } of pairs) {
    if (out.indexOf(word) === -1) continue;
    out = out.split(word).join(placeholder);
  }
  return out;
}

function unredactText(text) {
  if (!text || typeof text !== 'string') return text;
  const rules = getActiveRules();
  let out = text;
  for (const r of rules) {
    if (!r.words || r.words.length === 0) continue;
    // 【审计 2026-11-02】多词规则理论上已被迁移成单词语义，这里保留兜底
    if (r.words.length > 1) {
      console.warn('[Redaction] 检测到未迁移的多词规则 ⟦' + r.name + '⟧，反向还原将只用第一个词 "' + r.words[0] + '"');
    }
    const placeholder = '⟦' + r.name + '⟧';
    if (out.indexOf(placeholder) === -1) continue;
    out = out.split(placeholder).join(r.words[0]);
  }
  return out;
}

function unredactDeep(obj) {
  if (typeof obj === 'string') return unredactText(obj);
  if (Array.isArray(obj)) return obj.map(unredactDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = unredactDeep(obj[k]);
    return out;
  }
  return obj;
}

function lookupPlaceholder(name) {
  const data = ensureLoaded();
  const clean = String(name || '').replace(/[⟦⟧]/g, '').trim();
  const r = (data.rules || []).find((x) => x.name === clean);
  if (!r) return null;
  return { name: r.name, desc: r.desc || '', enabled: r.enabled !== false, source: r.source || 'manual', scope: r.scope || 'global' };
}

/**
 * 自动扫描记忆，提取候选脱敏词并加规则。
 * 返回 { added: [...], skipped: [...], totalScanned }
 */
function autoScanMemories(getAllMemoriesFn) {
  const data = ensureLoaded();
  const memories = (typeof getAllMemoriesFn === 'function' ? getAllMemoriesFn() : []) || [];
  // 1) 收集现有规则已覆盖的词（含所有规则，不只 enabled，避免重复）
  const covered = new Set();
  for (const r of (data.rules || [])) {
    for (const w of (r.words || [])) covered.add(String(w).toLowerCase());
  }
  // 2) 从记忆里提取候选词（只扫 name 和 tags，不扫 content 避免噪声）
  const candidates = new Map(); // word -> { count, samples[] }
  for (const m of memories) {
    const text = [m.name || '', Array.isArray(m.tags) ? m.tags.join(' ') : ''].join(' ');
    // 提取英文/下划线/驼峰词（长度 >= 4）
    const enMatches = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [];
    for (const w of enMatches) {
      const lw = w.toLowerCase();
      if (covered.has(lw)) continue;
      if (w.length < 4) continue;
      // 过滤常见技术词
      if (/^(html|http|https|json|yaml|python|javascript|typescript|node|electron|react|vue|nginx|redis|mysql|api|url|uri|cookie|token|session|header|body|query|post|get|put|delete|patch|id|index|admin|user|password|email|phone|address|number|string|boolean|object|array|function|class|method|module|package|require|import|export|default|null|undefined|true|false)$/i.test(w)) continue;
      if (!candidates.has(w)) candidates.set(w, { count: 0, samples: [] });
      const c = candidates.get(w);
      c.count++;
      if (c.samples.length < 2 && m.name) c.samples.push(m.name);
    }
  }
  // 3) 排序按出现次数（多次出现的才算真正项目相关）
  const sorted = [...candidates.entries()].sort((a, b) => b[1].count - a[1].count);
  // 4. 最多加 10 条（防污染）
  const MAX_AUTO = 10;
  const added = [];
  const skipped = [];
  let autoIdx = 1;
  for (const [word, info] of sorted) {
    if (added.length >= MAX_AUTO) break;
    if (info.count < 2) {
      skipped.push({ word, reason: '仅出现 1 次' });
      continue;
    }
    // 生成占位符名：自动_N
    let name;
    do { name = '自动_' + autoIdx++; } while (data.rules.some((r) => r.name === name));
    const rule = {
      name: name,
      words: [word],
      desc: 'AI 识别：' + (info.samples[0] || '').slice(0, 40),
      enabled: true,
      source: 'auto',
      scope: 'memory-only'
    };
    data.rules.push(rule);
    added.push(rule);
  }
  if (added.length > 0) persist();
  return { added, skipped, totalScanned: memories.length };
}

function _clearCache() { cache = null; }

module.exports = {
  listRules,
  getActiveRules,
  addRule,
  updateRule,
  deleteRule,
  deleteAllAutoRules,
  promoteToGlobal,
  promoteRecentAutoToGlobal,
  redactText,
  unredactText,
  unredactDeep,
  lookupPlaceholder,
  autoScanMemories,
  COMMON_WORDS,
  _clearCache,
  getStorePath
};
