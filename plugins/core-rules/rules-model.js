'use strict';
/**
 * 核心规则数据模型（纯函数，无副作用）
 *
 * 从 index.js 抽出的原因：面板 UI 逻辑难测，但这三个函数是规则「存、拼、排」
 * 的全部核心语义，必须被回归测试锁住。
 *
 * 数据结构：
 *   { id: 'r_xxx', name: '需求先汇报', content: '## 铁律...', enabled: true, order: 0 }
 *
 * 旧数据迁移（1.1.0 → 2.0.0）：
 *   老配置形如 { enabled: true, reportText: '...' }，读到时自动转成单条规则，
 *   名称默认「需求先汇报」。迁移只发生在读内存时，下次保存才落盘。
 */

const DEFAULT_RULE_NAME = '需求先汇报';

function genId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 归一化配置：补全字段 + 旧数据迁移 + order 重排为 0..N-1
 * @param {object} config ctx.config
 * @returns {Array<{id,name,content,enabled,order}>}
 */
function normalizeRules(config) {
  const cfg = config || {};
  let raw = Array.isArray(cfg.rules) ? cfg.rules : null;

  // 旧数据迁移：无 rules 字段但有 reportText
  if (raw === null) {
    const legacy = typeof cfg.reportText === 'string' ? cfg.reportText.trim() : '';
    if (legacy) {
      raw = [{
        id: genId(),
        name: DEFAULT_RULE_NAME,
        content: legacy,
        enabled: cfg.enabled !== false,
        order: 0,
      }];
    } else {
      raw = [];
    }
  }

  const cleaned = raw.map((r, i) => {
    const src = r && typeof r === 'object' ? r : {};
    return {
      id: src.id ? String(src.id) : genId(),
      name: String(src.name || '未命名规则').trim() || '未命名规则',
      content: String(src.content || '').trim(),
      enabled: src.enabled !== false,
      order: Number.isFinite(src.order) ? src.order : i,
    };
  });

  cleaned.sort((a, b) => a.order - b.order);
  cleaned.forEach((r, i) => { r.order = i; });
  return cleaned;
}

/**
 * 生成注入 systemPrompt 的文本
 * 规则：过滤 disabled、过滤空内容、按 order 升序、用空行分隔
 * @param {Array} rules
 * @returns {string}
 */
function buildInjectionText(rules) {
  if (!Array.isArray(rules)) return '';
  return rules
    .filter((r) => r && r.enabled !== false && typeof r.content === 'string' && r.content.trim())
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((r) => r.content.trim())
    .join('\n\n');
}

/**
 * 上移 / 下移一条规则
 * @param {Array} rules
 * @param {string} id
 * @param {'up'|'down'} direction
 * @returns {Array} 新数组（不修改入参）。边界情况返回原数组引用。
 */
function moveRule(rules, id, direction) {
  if (!Array.isArray(rules) || !id) return rules;
  if (direction !== 'up' && direction !== 'down') return rules;
  const arr = rules.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = arr.findIndex((r) => r && r.id === id);
  if (idx < 0) return rules;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= arr.length) return rules;
  const tmp = arr[idx];
  arr[idx] = arr[target];
  arr[target] = tmp;
  return arr.map((r, i) => Object.assign({}, r, { order: i }));
}

/**
 * 合并规则集合（导入用）：按 id 合并。
 * - 同 id：覆盖 name / content / enabled（保留 base 顺序位置）
 * - 新 id：追加到末尾
 * - 结果 order 统一重排为 0..N-1
 * 不修改入参，返回新数组。base / incoming 非数组时按空数组处理。
 *
 * @param {Array<{id,name,content,enabled,order}>} base  当前规则
 * @param {Array<{id,name,content,enabled,order}>} incoming  导入的规则
 * @returns {Array<{id,name,content,enabled,order}>}
 */
function mergeRules(base, incoming) {
  const baseArr = Array.isArray(base) ? base : [];
  const inArr = Array.isArray(incoming) ? incoming : [];

  // 用 Map 记录 base 中的 id -> 下标，同时保持 base 原序
  const ordered = baseArr.map((r) => Object.assign({}, r));
  const indexById = new Map();
  ordered.forEach((r, i) => {
    if (r && r.id) indexById.set(String(r.id), i);
  });

  for (const inc of inArr) {
    if (!inc || !inc.id) continue;
    const id = String(inc.id);
    if (indexById.has(id)) {
      const i = indexById.get(id);
      const cur = ordered[i];
      if (inc.name != null) cur.name = String(inc.name);
      if (inc.content != null) cur.content = String(inc.content);
      if (typeof inc.enabled === 'boolean') cur.enabled = inc.enabled;
    } else {
      const add = {
        id,
        name: inc.name != null ? String(inc.name) : '未命名规则',
        content: inc.content != null ? String(inc.content) : '',
        enabled: inc.enabled !== false,
        order: ordered.length,
      };
      ordered.push(add);
      indexById.set(id, ordered.length - 1);
    }
  }

  ordered.forEach((r, i) => { r.order = i; });
  return ordered;
}

module.exports = { normalizeRules, buildInjectionText, moveRule, mergeRules, genId, DEFAULT_RULE_NAME };
