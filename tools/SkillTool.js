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

        if (opts.includeInstructions) {
          return ToolResult.success("### " + s.name + nl() + String(s.instructions || ""));
        }

        const path = s.source === "local" && s.localPath ? " | 路径: " + s.localPath : " | 内联技能";
        return ToolResult.success("- " + s.name + ": " + flat(s.description, 120) + path);
      }

      let list = all;
      const q = opts.query ? String(opts.query).toLowerCase().trim() : "";
      if (q) {
        list = list.filter(function (s) {
          const hay = String(s.name + " " + s.description + " " + s.instructions).toLowerCase();
          return hay.indexOf(q) >= 0;
        });
      }

      const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
      list = list.slice(0, limit);
      if (list.length === 0) return ToolResult.success("（无匹配技能）");

      const lines = list.map(function (s) {
        const path = s.source === "local" && s.localPath ? " | 路径: " + s.localPath : " | 内联技能";
        return "- " + s.name + ": " + flat(s.description, 100) + path;
      });

      return ToolResult.success(lines.join(nl()));
    } catch (err) {
      return ToolResult.error("列出技能失败: " + err.message);
    }
  }
}

module.exports = { SkillListTool };
