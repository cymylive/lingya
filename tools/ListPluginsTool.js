/**
 * listPlugins 工具 —— 让 AI 在运行时主动发现已安装的插件及其能力
 *
 * 场景：用户说"用插件帮我做 X"，AI 不知道装了哪些插件 → 先调 listPlugins() 查看。
 * 对齐 dsh 的 cordis_inspect_list 思路（运行时自省）。
 */
const { Tool, ToolResult } = require('./ToolRegistry');

class ListPluginsTool extends Tool {
  constructor() {
    super(
      'listPlugins',
      '列出已安装的插件（本地插件 + DSH 外部插件）及其提供的工具/能力。当用户提到"插件"或需要额外能力时先调用它。',
      { type: 'object', properties: {} },
      'listPlugins()'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:listPlugins',
      order: 115,
      text: [
        '**插件能力（重要）**：本应用支持插件扩展（本地插件 + DSH 外部插件），插件会为 AI 增加工具。',
        '**主动发现**：当用户提到"插件"，或任务需要额外能力（如外部服务、特定功能）时，**先调用 listPlugins()** 查看已安装的插件及其工具调用签名。',
        'listPlugins() 返回 usableToolCalls（可直接调用的函数签名）——照着调即可，与内置工具用法相同。',
        '插件工具与内置工具没有区别，直接用 await 调用。不确定有哪些能力时，先 listPlugins() 再动手。',
        '用户想装更多插件时，提示其在左侧「插件」面板操作（本地插件 / DSH 插件市场）。',
      ].join('\n'),
    };
  }

  async execute() {
    try {
      // 从工具注册表查 jsApi 签名（AI 需要知道怎么调）
      const { registry } = require('./index');
      const sigOf = (name) => {
        try { const t = registry.get(name); return (t && t.jsApi) ? t.jsApi : name; } catch (_) { return name; }
      };
      const shape = (p) => ({
        id: p.id, name: p.name, version: p.version, enabled: p.enabled, loaded: p.loaded,
        // 工具：名 + 调用签名（AI 可直接照签名调）
        tools: (p.toolNames || []).map((n) => ({ name: n, call: sigOf(n) })),
      });
      const out = { local: [], dsh: [] };
      try {
        const pluginHost = require('../src/main/plugin-host');
        out.local = pluginHost.listPlugins().map(shape);
      } catch (_) {}
      try {
        const dsh = require('../src/main/dsh');
        out.dsh = dsh.listPlugins().map(shape);
      } catch (_) {}
      const total = out.local.length + out.dsh.length;
      const usableTools = [];
      for (const p of [...out.local, ...out.dsh]) {
        if (p.enabled && p.loaded) for (const t of p.tools) usableTools.push(t.call);
      }
      return ToolResult.success({
        summary: '共 ' + total + ' 个插件（本地 ' + out.local.length + '，DSH 外部 ' + out.dsh.length + '）；' +
          '当前可用插件工具 ' + usableTools.length + ' 个',
        usableToolCalls: usableTools,
        local: out.local,
        dsh: out.dsh,
        hint: '调用上面 usableToolCalls 里的函数即可使用插件能力（与内置工具用法相同，用 await）。',
      });
    } catch (err) {
      return ToolResult.error('列出插件失败: ' + (err && err.message ? err.message : String(err)));
    }
  }
}

module.exports = { ListPluginsTool };
