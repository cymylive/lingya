const { Tool, ToolResult } = require('./ToolRegistry');

// 对齐 dsh STATUSES
const STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * 对齐 dsh toTodoList：校验并规范化 todo 列表。
 * - content trim 后非空
 * - content 不重复
 * - 串行模式：最多一条 in_progress
 */
function parseTodoList(todos, allowParallelInProgress) {
  if (!Array.isArray(todos)) {
    throw new Error('todos must be an array');
  }
  const result = [];
  const seen = new Set();
  let active = 0;
  for (const item of todos) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('invalid todo: item must be an object');
    }
    const content = String(item.content || '').trim();
    if (content.length === 0) {
      throw new Error('invalid todo: content must be a non-empty string');
    }
    if (seen.has(content)) {
      throw new Error('invalid todos: duplicate content ' + JSON.stringify(content));
    }
    seen.add(content);
    if (!STATUSES.includes(item.status)) {
      throw new Error('invalid todo status: ' + item.status + ' (expected pending/in_progress/completed)');
    }
    if (item.status === 'in_progress') active++;
    result.push({ content, status: item.status });
  }
  if (!allowParallelInProgress && active > 1) {
    throw new Error('invalid todos: at most one task may be in_progress (got ' + active + ')');
  }
  return result;
}

/**
 * 对齐 dsh render：返回统计确认消息。
 */
function formatTodoOutput(counts) {
  return 'Updated todo list: ' + counts.pending + ' pending, ' + counts.inProgress + ' in progress, ' + counts.completed + ' completed.';
}

/**
 * todo_write 工具 - 仿照 dsh 的 todo_write。
 * 全量替换待办列表。串行模式：最多一条 in_progress。
 */
class TodoWriteTool extends Tool {
  constructor() {
    super(
      'todo_write',
      '记录并更新当前工作的结构化任务列表。每次发送完整列表，替换之前的列表（无部分更新）。用于规划多步工作并展示进度。',
      {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整任务列表，替换之前任何列表。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: {
                  type: 'string',
                  description: '任务内容，简短的祈使句'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'pending（未开始）| in_progress（进行中）| completed（已完成）'
                }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos'],
        additionalProperties: false
      },
      'todoWrite(todos)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:todo_write',
      order: 110,
      text: '记录并更新当前工作的结构化任务列表。每次调用发送完整列表——它替换之前的列表（没有部分更新）。完成任务后立即标记为 completed。对于简单的单步任务可跳过列表。'
    };
  }

  async execute(params) {
    const { todos, projectDir } = params;

    try {
      // 串行模式：allowParallelInProgress = false
      const list = parseTodoList(todos, false);

      const count = (status) => list.filter(t => t.status === status).length;
      const counts = {
        pending: count('pending'),
        inProgress: count('in_progress'),
        completed: count('completed'),
      };

      // 无持久化，仅在内存中短暂存储（可选）
      if (!globalThis.__lingyaTodos) globalThis.__lingyaTodos = [];
      globalThis.__lingyaTodos = list;

      console.log('[TodoWriteTool] 更新待办列表:', JSON.stringify(counts));
      return ToolResult.success(formatTodoOutput(counts));
    } catch (err) {
      return ToolResult.error('更新待办列表失败: ' + err.message);
    }
  }
}

module.exports = { TodoWriteTool, parseTodoList, formatTodoOutput, STATUSES };
