/**
 * DSH 兼容层 - ctx.skills 服务（CommonJS）
 *
 * 对齐 dsh-tool-skill 需要的 skills 服务：list/get/snapshot。
 * 复用 LingYa 的 skill-store（已启用的技能）。
 */

class SkillsService {
  constructor() {}

  /** 列出技能摘要（对齐 ctx.skills.list） */
  list(lookup) {
    try {
      const skillStore = require('../skill-store');
      const all = (skillStore.getAllSkills && skillStore.getAllSkills()) || [];
      return all.map((s) => ({
        name: s.name,
        description: s.description || '',
        source: s.source || 'lingya',
        // dsh 用 modelInvocable 判断是否可被模型调用
        modelInvocable: s.enabled !== false,
        enabled: s.enabled !== false,
      }));
    } catch (e) {
      return [];
    }
  }

  /** 取某技能详情（对齐 ctx.skills.get） */
  get(name, lookup) {
    try {
      const skillStore = require('../skill-store');
      const s = skillStore.getSkillByName ? skillStore.getSkillByName(name) : null;
      if (!s) return undefined;
      return {
        name: s.name,
        description: s.description || '',
        content: s.content || s.instructions || '',
        source: s.source || 'lingya',
        modelInvocable: s.enabled !== false,
      };
    } catch (_) {
      return undefined;
    }
  }

  /** 快照（对齐 ctx.skills.snapshot） */
  snapshot(lookup) {
    return this.list(lookup);
  }
}

module.exports = { SkillsService };
