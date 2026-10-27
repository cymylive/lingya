const { Tool, ToolResult } = require('./ToolRegistry');
const skillStore = require('../src/main/skill-store');

function nl() {
  return String.fromCharCode(10);
}

function flat(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

class SkillListTool extends Tool {
  constructor() {
    super(
      "skill_list",
      "列出或检索已启用技能。默认返回名称/简介/路径；传 name 可查单个技能；传 includeInstructions=true 可取技能全文。",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "按名称/简介/正文关键词筛选" },
          name: { type: "string", description: "精确查询某个技能名" },
          limit: { type: "integer", description: "最多返回条数，默认 50" },
          includeInstructions: { type: "boolean", description: "是否返回技能全文；本地技能也可用 read SKILL.md" }
        },
        additionalProperties: false
      },
      "skillList({ query, name, limit, includeInstructions })"
    );
  }

  getPromptSection() {
    return {
      name: "tool:skill_list",
      order: 198,
      text: [
        "## 技能检索规则",
        "",
        "首条提示词只注入少量技能摘要。需要发现全量技能时调用 skillList()。",
        "任务与某个技能相关时：本地技能先 read 对应 SKILL.md；内联技能用 skillList({ name, includeInstructions: true }) 取全文。",
        "不要仅凭简介猜测具体流程。"
      ].join(nl())
    };
  }

  async execute(params) {
    try {
      const all = skillStore.getAllSkills().filter(function (s) {
        return s.enabled !== false;
      });
      const opts = params || {};

      if (opts.name) {
        const s = all.find(function (x) {
          return x.name === opts.name;
        });
        if (!s) return ToolResult.error('技能 "' + opts.name + '" 不存在或已禁用');

        // P1 埋点：查过就算用过
        try { skillStore.touchSkill(s.name); } catch (_) {}

        if (opts.includeInstructions) {
          return ToolResult.success("### " + s.name + nl() + String(s.instructions || ""));
        }

        const path = s.source === "local" && s.localPath ? " | 路径: " + s.localPath : " | 内联技能";
        return ToolResult.success("- " + s.name + ": " + flat(s.description, 200) + path);
      }

      let list = all;
      const q = opts.query ? String(opts.query).trim() : "";
      if (q) {
        // P4：分词模糊匹配 + 多字段加权排序（名字 > 描述 > 正文）
        const words = String(q).toLowerCase().split(/[\s,，、]+/).filter(function (w) { return w.length > 0; });
        const scored = [];
        for (const s of list) {
          const name = String(s.name || "").toLowerCase();
          const desc = String(s.description || "").toLowerCase();
          const body = String(s.instructions || "").toLowerCase();
          let score = 0;
          let hitAll = true;
          for (const w of words) {
            let hit = 0;
            if (name.indexOf(w) >= 0) hit += 100;
            if (desc.indexOf(w) >= 0) hit += 30;
            if (body.indexOf(w) >= 0) hit += 5;
            if (hit === 0) { hitAll = false; break; }
            score += hit;
          }
          if (hitAll && score > 0) scored.push({ skill: s, score });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        list = scored.map(function (x) { return x.skill; });
      } else {
        // 无 query：按使用频率 + 最近使用排序（P2 的一致性）
        list = list.slice().sort(function (a, b) {
          const ua = Math.log((a.useCount || 0) + 1);
          const ub = Math.log((b.useCount || 0) + 1);
          if (Math.abs(ua - ub) > 0.01) return ub - ua;
          return String(a.name).localeCompare(String(b.name));
        });
      }

      const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
      list = list.slice(0, limit);
      if (list.length === 0) return ToolResult.success("（无匹配技能）");

      const lines = list.map(function (s) {
        const path = s.source === "local" && s.localPath ? " | 路径: " + s.localPath : " | 内联技能";
        return "- " + s.name + ": " + flat(s.description, 120) + path;
      });

      return ToolResult.success(lines.join(nl()));
    } catch (err) {
      return ToolResult.error("列出技能失败: " + err.message);
    }
  }
}

module.exports = { SkillListTool };
