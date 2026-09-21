/**
 * 记忆工具 - AI 通过 lingya 代码块调用，管理长期记忆
 * 移植自 deepseek-pp 的 memory_save / memory_update / memory_delete。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const memoryStore = require('../src/main/memory-store');

class MemorySaveTool extends Tool {
  constructor() {
    super(
      'memory_save',
      '保存一条新的长期记忆。当用户提到身份/职业/偏好/习惯、纠正行为、或明确要求记住时调用。',
      {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'topic', 'reference'],
            description: '记忆类型：user=身份角色偏好, feedback=行为纠正, topic=讨论要点, reference=外部资源',
          },
          name: { type: 'string', description: '简短标题' },
          content: { type: 'string', description: '要保存的内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          pinned: { type: 'boolean', description: '是否置顶（重要记忆）' },
        },
        required: ['type', 'name', 'content'],
        additionalProperties: false,
      },
      'memorySave({ type, name, content, tags, pinned })'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:memory_save',
      order: 200,
      text: [
        '## 记忆保存规则',
        '',
        '当对话中出现以下任一情况时，你应当调用 memorySave 保存长期记忆：',
        '- 用户提到自己的身份、职业、角色',
        '- 用户表达偏好、习惯或工作方式',
        '- 用户纠正你的回答方式或行为',
        '- 出现重要的技术决策、架构选型',
        '- 用户明确说"记住""记下来""别忘了"等',
        '',
        '仅保存长期有价值的信息，不保存一次性问答。不要重复保存已存在的记忆（见上方"长期记忆"区块）。',
      ].join('\n'),
    };
  }

  async execute(params) {
    try {
      const id = memoryStore.saveMemory(params);
      return ToolResult.success('已保存记忆 #' + id + ': ' + params.name);
    } catch (err) {
      return ToolResult.error('保存记忆失败: ' + err.message);
    }
  }
}

class MemoryUpdateTool extends Tool {
  constructor() {
    super(
      'memory_update',
      '更新一条已有记忆（需提供 id）。',
      {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '记忆 ID' },
          type: { type: 'string', enum: ['user', 'feedback', 'topic', 'reference'], description: '记忆类型' },
          name: { type: 'string', description: '更新后的标题' },
          content: { type: 'string', description: '更新后的内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          pinned: { type: 'boolean', description: '是否置顶' },
        },
        required: ['id', 'name', 'content'],
        additionalProperties: false,
      },
      'memoryUpdate({ id, type, name, content, tags, pinned })'
    );
  }

  async execute(params) {
    try {
      memoryStore.updateMemory(params);
      return ToolResult.success('已更新记忆 #' + params.id);
    } catch (err) {
      return ToolResult.error('更新记忆失败: ' + err.message);
    }
  }
}

class MemoryDeleteTool extends Tool {
  constructor() {
    super(
      'memory_delete',
      '删除一条记忆（需提供 id）。',
      {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '记忆 ID' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      'memoryDelete(id)'
    );
  }

  async execute(params) {
    try {
      memoryStore.deleteMemory(params.id);
      return ToolResult.success('已删除记忆 #' + params.id);
    } catch (err) {
      return ToolResult.error('删除记忆失败: ' + err.message);
    }
  }
}

class MemoryListTool extends Tool {
  constructor() {
    super(
      'memory_list',
      '列出所有长期记忆（返回 id/类型/标题/内容）。',
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'topic', 'reference'], description: '按类型筛选（可选）' },
        },
        additionalProperties: false,
      },
      'memoryList({ type })'
    );
  }

  async execute(params) {
    try {
      let list = memoryStore.getAllMemories();
      if (params && params.type) {
        list = list.filter((m) => m.type === params.type);
      }
      if (list.length === 0) return ToolResult.success('（暂无记忆）');
      const lines = list.map((m) =>
        '#' + m.id + ' [' + m.type + ']' + (m.pinned ? ' [置顶]' : '') + ' ' + m.name + ': ' + m.content
      );
      return ToolResult.success(lines.join('\n'));
    } catch (err) {
      return ToolResult.error('列出记忆失败: ' + err.message);
    }
  }
}

module.exports = { MemorySaveTool, MemoryUpdateTool, MemoryDeleteTool, MemoryListTool };
