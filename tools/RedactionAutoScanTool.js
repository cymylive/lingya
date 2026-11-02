/**
 * 脱敏规则自动扫描工具（2026-11-02）
 *
 * AI 可调，自动扫全部记忆提取候选脱敏词，加为 auto 规则（scope=memory-only）。
 * 返回报告：加了几条、跳了几条、分别是什么。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const redactionStore = require('../src/main/redaction-store');
const memoryStore = require('../src/main/memory-store');

const NL = String.fromCharCode(10);

class RedactionAutoScanTool extends Tool {
  constructor() {
    super(
      'redaction_auto_scan',
      '自动扫描全部记忆，提取候选脱敏词并加为 auto 规则（默认 scope=memory-only，只影响记忆检索，不影响用户输入）。用于用户说「整理脱敏规则」时调用。',
      {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      'redactionAutoScan()'
    );
  }

  getPromptSection() {
    const lines = [
      '## 脱敏规则自动整理',
      '',
      '当用户说「整理脱敏规则」「扫一下敏感词」「检查脱敏」时，调用 redactionAutoScan()。',
      '',
      '它会：',
      '1. 扫全部记忆的 name 和 tags，提取英文/下划线/驼峰词（长度 >= 4）',
      '2. 过滤已被现有规则覆盖的词、通用技术词、仅出现 1 次的词',
      '3. 出现 2 次以上的词自动加为规则（最多 10 条）',
      '4. 生成的规则：占位符 = ⟦自动_N⟧，scope = memory-only（只影响记忆检索，不影响用户输入）',
      '',
      '返回报告后，如实转述给用户：加了几条、跳过几条、跳过的原因。',
      '用户如果想应用到用户输入侧，可在侧边栏「设置 → 脱敏规则」点「全部采纳」。'
    ];
    return {
      name: 'tool:redaction_auto_scan',
      order: 199,
      text: lines.join(NL)
    };
  }

  async execute() {
    try {
      const result = redactionStore.autoScanMemories(() => memoryStore.getAllMemories());
      const lines = [];
      lines.push('扫描完成：共 ' + result.totalScanned + ' 条记忆');
      lines.push('自动添加 ' + result.added.length + ' 条规则（scope=memory-only）：');
      for (const r of result.added) {
        lines.push('  ⟦' + r.name + '⟧ ← ' + r.words.join(', ') + '  |  ' + r.desc);
      }
      if (result.skipped.length > 0) {
        lines.push('跳过 ' + result.skipped.length + ' 条（仅出现 1 次或通用词）');
      }
      if (result.added.length === 0) {
        lines.push('（没有新候选词，可能记忆里没有可脱敏的专有名词，或都已被现有规则覆盖）');
      }
      return ToolResult.success(lines.join(NL));
    } catch (err) {
      return ToolResult.error('扫描失败: ' + err.message);
    }
  }
}

module.exports = { RedactionAutoScanTool };
