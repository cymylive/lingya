/**
 * 记忆工具 - AI 通过 lingya 代码块调用，管理长期记忆
 * 移植自 deepseek-pp 的 memory_save / memory_update / memory_delete。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const memoryStore = require('../src/main/memory-store');

/** 单次 memoryList 回传的硬上限：超限截断，避免一次性把全部正文倒进网页端 */
const MAX_MEMORY_LIST_CHARS = 60000;

function truncateWithNote(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n…（内容过长已截断，缩小 query 范围可以更精确）';
}

/** 敏感记忆不外发（与 memory-store 的过滤规则一致） */
function isSensitiveMemory(m) {
  try {
    const { isSensitive } = require('../src/main/memory-redaction');
    return isSensitive(m);
  } catch (_) {
    return false;
  }
}

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
          scope: { type: 'string', description: "归属范围：'global'（通用）或项目名（如 'AI音乐自动发布机'）" },
          kind: { type: 'string', enum: ['identity', 'experience'], description: 'identity=身份偏好，experience=项目经验（项目 scope 强制 experience）' },
          confidence: { type: 'string', enum: ['verified', 'hypothesis'], description: 'verified=实测确认，hypothesis=推测' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          pinned: { type: 'boolean', description: '是否置顶（重要记忆）' },
        },
        required: ['type', 'name', 'content'],
        additionalProperties: false,
      },
      'memorySave({ type, name, content, scope, kind, confidence, tags, pinned })'
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
      const { id, conflicts } = memoryStore.saveMemoryWithConflictCheck(params);
      let msg = '已保存记忆 #' + id + ': ' + params.name;
      if (conflicts && conflicts.length > 0) {
        const top = conflicts.slice(0, 3).map((c) =>
          '#' + c.memory.id + '（相似度 ' + Math.round(c.similarity * 100) + '%）' + c.memory.name.slice(0, 30)
        );
        msg += '\n\n注意：发现 ' + conflicts.length + ' 条相似记忆，可能是重复或冲突，建议人工确认：\n' + top.join('\n');
      }
      return ToolResult.success(msg);
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

class MemoryRecallTool extends Tool {
  constructor() {
    super(
      'memory_recall',
      '检索长期记忆，只返回索引（id/标题/类型/字数/可信度），不含正文。先用它定位，再用 memoryGet 取正文。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，用项目名/技术名/操作名，越具体越准' },
          kind: { type: 'string', enum: ['identity', 'experience'], description: 'identity=身份偏好，experience=项目经验（可选）' },
          limit: { type: 'integer', description: '返回条数，默认 10，最多 20' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      'memoryRecall(query, { kind, limit })'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:memory_recall',
      order: 199,
      text: [
        '## 记忆检索规则',
        '',
        '你有一个本地长期记忆库（项目经验、踩过的坑、配置路径、历史决策）。**它不会自动出现在上下文里，必须主动检索。**',
        '',
        '遇到以下情况，先调 memoryRecall 再回答，不要凭印象：',
        '- 涉及具体项目名、文件路径、端口、账号、配置',
        '- 用户说"上次""之前""以前怎么做的""还记不记得"',
        '- 要执行发布 / 上传 / 部署 / 改配置等有历史教训的操作',
        '- 遇到报错，怀疑是踩过的坑',
        '',
        '**检索是两层的**：',
        '1. memoryRecall("关键词") → 拿索引（只有标题和字数，没有正文）',
        '2. memoryGet([id1, id2]) → 取你选中条目的正文',
        '',
        '标 [hypothesis] 的是当时的推测，引用时要说明不确定。',
      ].join('\n'),
    };
  }

  async execute(params) {
    try {
      const p = params || {};
      const query = String(p.query || '').trim();
      if (!query) return ToolResult.error('query 不能为空');

      const scope = p.projectDir
        ? memoryStore.normalizeScope(require('path').basename(p.projectDir))
        : memoryStore.MEMORY_SCOPES_GLOBAL;

      const limit = Math.max(1, Math.min(20, Number(p.limit) || 10));
      const hits = memoryStore.searchMemories(query, { scope, kind: p.kind, limit });

      if (hits.length === 0) {
        return ToolResult.success('没有找到相关记忆（query: ' + query + '）');
      }

      const lines = hits.map((h) => {
        const m = h.memory;
        const conf = m.confidence === 'hypothesis' ? '[hypothesis]' : '[verified]';
        const chars = String(m.content || '').length;
        return '#' + m.id + ' ' + conf + ' ~' + chars + '字  ' + m.name;
      });
      const ids = hits.map((h) => h.memory.id).join(',');
      lines.push('');
      lines.push('用 memoryGet([' + ids + ']) 取正文。');

      return ToolResult.success(truncateWithNote(lines.join('\n'), 3000));
    } catch (err) {
      return ToolResult.error('检索记忆失败: ' + err.message);
    }
  }
}

class MemoryGetTool extends Tool {
  constructor() {
    super(
      'memory_get',
      '按 id 取记忆正文（从 memoryRecall 的结果里选）。单条正文限 500 字，总输出限 3000 字。',
      {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: '记忆 id 数组' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      'memoryGet([1,2,3])'
    );
  }

  async execute(params) {
    try {
      const ids = Array.isArray(params && params.ids) ? params.ids.map(Number).filter(Number.isInteger) : [];
      if (ids.length === 0) return ToolResult.error('ids 不能为空');

      const out = [];
      for (const id of ids) {
        const m = memoryStore.getMemoryById(id);
        if (!m) { out.push('#' + id + ' 不存在'); continue; }
        if (isSensitiveMemory(m)) { out.push('#' + id + ' 不可访问'); continue; }
        const body = String(m.content || '');
        const clipped = body.length > 500 ? body.slice(0, 500) + '…（原文 ' + body.length + ' 字，用 memoryGetFull(' + id + ') 取全文）' : body;
        out.push('#' + m.id + ' [' + m.type + '] ' + m.name + '\n' + clipped);
      }
      memoryStore.touchMemories(ids);
      return ToolResult.success(truncateWithNote(out.join('\n\n'), 3000));
    } catch (err) {
      return ToolResult.error('取记忆失败: ' + err.message);
    }
  }
}

class MemoryGetFullTool extends Tool {
  constructor() {
    super(
      'memory_get_full',
      '按 id 取单条记忆完整原文。最后手段，只在 memoryGet 的 500 字不够用时调用。',
      {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '记忆 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      'memoryGetFull(id)'
    );
  }

  async execute(params) {
    try {
      const id = Number(params && params.id);
      if (!Number.isInteger(id)) return ToolResult.error('id 必须是整数');
      const m = memoryStore.getMemoryById(id);
      if (!m) return ToolResult.error('记忆 #' + id + ' 不存在');
      if (isSensitiveMemory(m)) return ToolResult.error('记忆 #' + id + ' 不可访问');
      memoryStore.touchMemories([id]);
      return ToolResult.success('#' + m.id + ' [' + m.type + '] ' + m.name + '\n\n' + String(m.content || ''));
    } catch (err) {
      return ToolResult.error('取记忆失败: ' + err.message);
    }
  }
}

// 兼容：保留旧类名指向新实现，避免外部引用断裂
class MemoryListTool extends MemoryRecallTool {
  constructor() {
    super();
    this.name = 'memory_list';
    this.signature = 'memoryList({ query })';
  }
}

module.exports = {
  MemorySaveTool, MemoryUpdateTool, MemoryDeleteTool,
  MemoryRecallTool, MemoryGetTool, MemoryGetFullTool,
  MemoryListTool,
};
