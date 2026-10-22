const { Tool, ToolResult } = require('./ToolRegistry');
const { EventEmitter } = require('events');
const { markEstablished, isAwaitingConfirm } = require('./plan-gate');
const fs = require('fs');
const path = require('path');

// 对齐 dsh STATUSES
const STATUSES = ['pending', 'in_progress', 'completed'];

// 待办存储：<userData>/lingya-todos.json
// 结构：{ "<sessionId>": { todos: [...], archived: bool, updatedAt } }
// 严格按 sessionId 隔离；新建会话（sessionId 未就绪）用临时键 "pending:<profileId>"，
// 会话 ID 出现后由 migratePendingTodos 迁移到真实键。
let STORE_FILE = null;
let store = {};          // 内存缓存（与磁盘同步）
const todoEvents = new EventEmitter();

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-todos.json');
  store = readStore();
  console.log('[TodoStore] 存储文件:', STORE_FILE);
}

function readStore() {
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (err) {
    console.error('[TodoStore] 读取失败:', err.message);
  }
  return {};
}

function writeStore() {
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[TodoStore] 写入失败:', err.message);
  }
}

/** 当前会话的存储键：优先 sessionId，无则临时键 */
function keyFor(sessionId, profileId) {
  if (sessionId) return sessionId;
  return 'pending:' + (profileId || '__default');
}

/**
 * 读某会话的待办。严格隔离：只读本会话的键，不回退到其它会话。
 * @returns {{ todos: Array, archived: boolean }}
 */
function getTodos(sessionId, profileId) {
  const key = keyFor(sessionId, profileId);
  const rec = store[key];
  if (!rec || !Array.isArray(rec.todos)) return { todos: [], archived: false };
  return { todos: rec.todos.slice(), archived: !!rec.archived };
}

/**
 * 会话 ID 出现时，把临时键（pending:<profileId>）的待办迁移到真实 sessionId 键。
 * 由 session-store.handleUrlChange 在拿到 sessionId 后调用。
 */
function migratePendingTodos(sessionId, profileId) {
  if (!sessionId) return false;
  const tempKey = 'pending:' + (profileId || '__default');
  const rec = store[tempKey];
  if (!rec || !Array.isArray(rec.todos) || rec.todos.length === 0) return false;
  // 目标键已有数据则不覆盖（避免误吞）
  if (store[sessionId] && Array.isArray(store[sessionId].todos) && store[sessionId].todos.length > 0) {
    delete store[tempKey];
    writeStore();
    return false;
  }
  store[sessionId] = { todos: rec.todos, archived: !!rec.archived, updatedAt: Date.now() };
  delete store[tempKey];
  writeStore();
  console.log('[TodoStore] 迁移临时待办', tempKey, '→', sessionId, '共', rec.todos.length, '项');
  return true;
}

/** 清空某会话待办（AI 明确说完成时 / 手动清） */
function clearTodos(sessionId, profileId) {
  const key = keyFor(sessionId, profileId);
  if (store[key]) {
    delete store[key];
    writeStore();
  }
}

/**
 * 对齐 dsh toTodoList：校验并规范化 todo 列表。
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

function formatTodoOutput(counts) {
  return 'Updated todo list: ' + counts.pending + ' pending, ' + counts.inProgress + ' in progress, ' + counts.completed + ' completed.';
}

class TodoWriteTool extends Tool {
  constructor() {
    super(
      'todo_write',
      '记录并更新当前工作的结构化任务列表，向用户展示进度。多步任务（2步及以上）开始时必须先调用本工具建立完整计划再执行；执行中每完成一项必须立即单独调用本工具更新状态（严禁攒批）。每次发送完整列表，替换之前的列表（无部分更新）。',
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
                content: { type: 'string', description: '任务内容，简短的祈使句' },
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
      text: '记录并更新当前工作的结构化任务列表，用于向用户展示进度。' +
        '【强制规则一】凡是需要 2 步及以上才能完成的任务，你必须做的第一件事就是调用 todoWrite 建立完整计划，然后再开始执行；' +
        '不允许"边做边想"或做完才补计划。只有真正的单步任务（一次工具调用即可完成）才可以省略。' +
        '【强制规则二 · 单项即时同步】每完成一项，必须**立刻单独调用一次 todoWrite** 把它标为 completed，' +
        '同时把下一项标为 in_progress（串行，同一时刻最多一条 in_progress）；**严禁攒批**——' +
        '不要等做完 2-3 项才一起更新，也不要"最后统一收尾"。用户是靠计划面板实时看进度的，' +
        '攒批会让面板长时间停在同一项，等于没有进度。' +
        '正确的节奏是：完成 A → 立即 todoWrite(A=completed, B=in_progress) → 开始做 B → 完成 B → 立即 todoWrite(B=completed, C=in_progress) → ……' +
        '【重要】全部完成时，最后一次调用要把所有项都标为 completed（面板会显示 ✓ 全部完成）。' +
        '**绝不要用空列表清空计划**——已完成的清单要保留在面板中供用户回顾（完成项自动划掉）。' +
        '如需开始新任务，直接传入新的完整列表（会替换旧列表）。'
    };
  }

  async execute(params) {
    const { todos, profileId, sessionId } = params;
    try {
      const list = parseTodoList(todos, false);
      // 保护：拒绝空列表清空（用户希望保留已完成的计划清单，便于回顾）
      if (list.length === 0) {
        return ToolResult.error('todoWrite 不接受空列表：已完成的计划应保留在面板中（完成项会自动划掉）。如需开始新计划，直接传入新的 todo 列表即可（会替换旧的）。');
      }
      const count = (status) => list.filter(t => t.status === status).length;
      const counts = {
        pending: count('pending'),
        inProgress: count('in_progress'),
        completed: count('completed'),
      };

      // 建立计划 → 解除该会话的计划门禁
      markEstablished(sessionId, profileId);

      // 全部完成 → 归档标记
      const archived = list.length > 0 && list.every(t => t.status === 'completed');

      // 持久化到该会话的键（严格隔离）
      const key = keyFor(sessionId, profileId);
      store[key] = { todos: list, archived, updatedAt: Date.now() };
      writeStore();

      // 广播（带 sessionId，供前端按会话过滤）
      todoEvents.emit('change', {
        sessionId: sessionId || null,
        profileId: profileId || null,
        key,
        todos: list,
        archived,
      });

      console.log('[TodoWriteTool] 更新待办: key=' + key + ', sessionId=' + (sessionId || 'null') + ', archived=' + archived + ', ' + JSON.stringify(counts));

      let output = formatTodoOutput(counts);

      // 【计划全部完成 → 主动下达收尾指令】
      //
      // 为什么必须在这里做：
      //   todoWrite 在这一刻已经知道「这是最后一步」（archived=true），但这个事实
      //   从未传递给 AI。于是 AI 收尾汇报时可能只说"代码已经写好了"，漏掉「任务已完成」
      //   四个字 → intercept-observer 的 DONE_HINT_RE 不命中 → state.taskDeclaredDone
      //   保持 false → supervisor 30 秒后判定任务停滞 → 又催一轮逼 AI 补声明。
      //   用户看到的就是「明明做完了，还被催一次」，白费一轮对话。
      //
      // 在这里把"该收尾了"提前告诉 AI，让它最后一次回复天然带上完成声明，
      // 监督者就再也不会多催。
      //
      // 注意：不要改 formatTodoOutput()——它有精确的单测断言，且职责是纯格式化。
      // 收尾指令属于 execute() 层的业务语义，加在这里。
      // ===== 计划已建立但等待用户确认 =====
      // 需求：AI 制定计划后不要立即执行，等用户点「确认执行」或回复确认词。
      //
      // 为什么在返回值里明说（而不只是靠 plan-gate 硬拦截）：
      //   只硬拦截的话，AI 会反复尝试调工具被拒，白烧几轮对话还可能触发失败重试。
      //   在返回值里明确"停下等确认"，AI 会自然地汇报计划并询问用户。
      //
      // 只在「仍在等待确认」时追加（isAwaitingConfirm 已内含 established +
      // requireConfirm + !confirmed 三重判断），确认后自动不再打扰。
      if (isAwaitingConfirm(sessionId, profileId)) {
        output += '\n\n【计划已建立 · 等待用户确认】' +
          '任务计划已保存，但按照当前设置，**需要用户确认后才能开始执行**。' +
          '请立刻停止调用任何工具，向用户简要说明计划要点，' +
          '并明确告知：「计划已就绪，请点击计划面板的【确认执行】按钮，或回复「确认执行」」。' +
          '在用户确认之前，任何写操作都会被拒绝。';
      }

      if (archived) {
        output += '\n\n【计划已全部完成 · 请收尾】' +
          '所有待办项均已标记为 completed，这是最后一步。' +
          '请在本次回复中直接向用户汇报最终结果，并在结尾明确写出「任务已完成」——' +
          '这是监督者判定收尾的唯一依据，漏写会导致被误催一轮，影响体验。' +
          '不需要再调用任何工具。';
      }

      return ToolResult.success(output);
    } catch (err) {
      return ToolResult.error('更新待办列表失败: ' + err.message);
    }
  }
}

module.exports = { TodoWriteTool, parseTodoList, formatTodoOutput, STATUSES, todoEvents, getTodos, init, migratePendingTodos, clearTodos };
