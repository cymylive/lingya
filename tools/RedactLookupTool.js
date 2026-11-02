/**
 * 脱敏占位符查询工具（2026-11-02）
 *
 * AI 在回复里看到 ⟦项目A⟧ 这种占位符时，可以调用本工具查询其含义（desc）。
 * 只返回描述，不返回真词，防止 AI 从工具返回值里拿到敏感词后回传。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const redactionStore = require('../src/main/redaction-store');

const NL = String.fromCharCode(10);

class RedactLookupTool extends Tool {
  constructor() {
    super(
      'redact_lookup',
      '查询脱敏占位符的含义。看到 ⟦xxx⟧ 这种占位符但不确定它指代什么时调用。只返回描述，不返回真词。',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: '占位符内的名字，如 "项目A"（不要带 ⟦ ⟧ 符号）' }
        },
        required: ['name'],
        additionalProperties: false
      },
      'redactLookup(name)'
    );
  }

  getPromptSection() {
    const lines = [
      '## 占位符查询',
      '',
      '在工具返回值、用户输入或记忆里看到 ⟦xxx⟧ 形式的占位符时（例如 ⟦项目A⟧、⟦操作1⟧），',
      '说明该名字属于脱敏规则——真正的名字在本地，但不会出现在网页端。',
      '',
      '如果你不确定某个占位符指代什么：',
      '- 调用 redactLookup("项目A") 查描述（不带 ⟦ ⟧ 符号）',
      '- 描述只说明大致用途，不含真词',
      '',
      '**重要**：不要把占位符当成真词传给工具。工具内部会自动还原，你只需要原样传递即可。',
      '例如：read("⟦项目A⟧/xxx.py") 会被自动还原为 read("真路径/xxx.py")。'
    ];
    return {
      name: 'tool:redact_lookup',
      order: 199,
      text: lines.join(NL)
    };
  }

  async execute(params) {
    try {
      const name = String((params && params.name) || '').trim();
      if (!name) return ToolResult.error('name 不能为空');
      const info = redactionStore.lookupPlaceholder(name);
      if (!info) return ToolResult.error('占位符不存在: ' + name);
      if (info.enabled === false) {
        return ToolResult.success('占位符 ⟦' + info.name + '⟧ 已停用（原描述：' + info.desc + '）');
      }
      return ToolResult.success('⟦' + info.name + '⟧ → ' + info.desc);
    } catch (err) {
      return ToolResult.error('查询失败: ' + err.message);
    }
  }
}

module.exports = { RedactLookupTool };
