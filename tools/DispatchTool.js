/**
 * 跨窗口调度工具（主窗口指挥其他窗口）
 *
 * listWindows()       —— 列出当前所有已打开的窗口（名字 + 平台 + 运行状态）
 * dispatchToWindow()  —— 把一条指令发到目标窗口的聊天框并自动发送
 *
 * 设计决策：
 * - 目标按「窗口名」匹配（用户说「B 窗口」也能对上），重名时按列表顺序取第一个
 * - 目标忙碌时拒绝派发（不做队列），避免打断正在跑的任务
 * - 发送前不替目标确认任何危险操作 —— 确认由目标窗口的 AI 自己走二次确认流程
 */
const { Tool, ToolResult } = require('./ToolRegistry');

/** 从窗口 ctx 推算当前运行状态（与 get-all-todos 口径一致） */
function deriveWindowStatus(ctx) {
  if (!ctx) return { status: 'idle', label: '空闲' };
  try {
    const activityTracker = require('../src/main/activity-tracker');
    const generationState = require('../src/main/generation-state');
    const { deriveStatus } = require('../src/main/task-status');

    // 宿主面板（按 ctx.view 判断）
    const wcId = ctx.view ? ctx.view.webContents.id : null;
    const gen = generationState.get(wcId);

    // 会话 key（拿 todo + activity）
    let sessionId = null;
    try {
      sessionId = ctx.sessionStore && ctx.sessionStore.state
        ? (ctx.sessionStore.state.currentSessionId || null)
        : null;
    } catch (_) {}
    const key = (ctx.profileId || 'p') + '::' + (sessionId || 's');

    let todos = [];
    try {
      const { getTodos } = require('./TodoWriteTool');
      const r = getTodos(sessionId, ctx.profileId);
      todos = (r && r.todos) || [];
    } catch (_) {}

    const st = deriveStatus({
      todos,
      activity: activityTracker.get(key),
      generating: !!(gen && gen.generating),
    });

    const LABELS = {
      running: '运行中', stuck: '疑似卡住', error: '出错',
      done: '已完成', waiting: '等待中', idle: '空闲',
    };
    return { status: st, label: LABELS[st] || st };
  } catch (_) {
    return { status: 'idle', label: '空闲' };
  }
}

/** 列出所有可用窗口 */
function collectWindows() {
  const windowState = require('../src/main/window');
  const profileManager = require('../src/main/profile-manager');
  const out = [];
  for (const ctx of windowState.getAllContexts()) {
    let name = ctx.profileId || '窗口';
    let provider = ctx.providerId || '';
    try {
      const p = profileManager.getProfileById(ctx.profileId);
      if (p) { name = p.name || name; if (p.providerId) provider = p.providerId; }
    } catch (_) {}
    const st = deriveWindowStatus(ctx);
    out.push({
      profileId: ctx.profileId,
      name,
      provider,
      status: st.status,
      statusLabel: st.label,
    });
  }
  return out;
}

class ListWindowsTool extends Tool {
  constructor() {
    super(
      'listWindows',
      '列出当前所有已打开的 LingYa 窗口（名字 / 平台 / 运行状态），用于确定「派发指令」的目标。',
      { type: 'object', properties: {}, additionalProperties: false },
      'listWindows()'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:listWindows',
      order: 200,
      text: [
        '**跨窗口调度（重要）**：当用户要求「让 B 窗口做某事」「叫窗口3 继续任务」这类跨窗口指令时，**先调用 listWindows()** 拿到窗口列表，再匹配目标窗口名，然后调 dispatchToWindow(target, instruction) 派发。',
        '不要凭空猜窗口名 —— 必须先 listWindows 确认。',
      ].join('\n'),
    };
  }

  async execute() {
    try {
      const list = collectWindows();
      return ToolResult.success({
        windows: list,
        count: list.length,
        hint: list.length
          ? '用 dispatchToWindow(target, instruction) 派发，target 传 name 字段的值'
          : '当前没有可用窗口',
      });
    } catch (err) {
      return ToolResult.error('列窗口失败: ' + err.message);
    }
  }
}

class DispatchToWindowTool extends Tool {
  constructor() {
    super(
      'dispatchToWindow',
      '把一条指令派发给指定的 LingYa 窗口（自动填入并发送到那个窗口的聊天框）。目标窗口忙碌时会拒绝派发。',
      {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标窗口名（用 listWindows 拿到的 name）' },
          instruction: { type: 'string', description: '要派发的完整指令文本' },
          allowBusy: { type: 'boolean', description: '目标忙时是否强制派发（默认 false）' },
        },
        required: ['target', 'instruction'],
        additionalProperties: false,
      },
      'dispatchToWindow(target, instruction, allowBusy)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:dispatchToWindow',
      order: 201,
      text: [
        '**派发规则**：',
        '- 目标窗口忙碌（status=running/stuck）时默认拒绝派发，返回「目标正忙」。除非用户明确说「强制发」否则不要传 allowBusy',
        '- 派发成功后只回一句「已派发到 <窗口名>」，不要替目标窗口执行操作',
        '- 危险操作（推送代码、删除文件、发布等）**由目标窗口的 AI 自己走二次确认流程**，你只负责把指令送到',
        '- 用户如果想看目标进度，先用 listWindows 再报告',
      ].join('\n'),
    };
  }

  async execute(params) {
    const target = String((params && params.target) || '').trim();
    const instruction = String((params && params.instruction) || '').trim();
    const allowBusy = !!(params && params.allowBusy);

    if (!target) return ToolResult.error('目标窗口名不能为空');
    if (!instruction) return ToolResult.error('指令内容不能为空');

    try {
      const windowState = require('../src/main/window');
      const list = collectWindows();

      // 优先精确匹配 name，其次 profileId，再次模糊包含
      let hit = list.find(w => w.name === target)
        || list.find(w => w.profileId === target)
        || list.find(w => String(w.name).includes(target) || String(w.profileId).includes(target));

      if (!hit) {
        const names = list.map(w => w.name).join('、');
        return ToolResult.error('找不到窗口「' + target + '」，当前可用窗口：' + (names || '(无)'));
      }

      // 忙碌检查
      if (!allowBusy && (hit.status === 'running' || hit.status === 'stuck')) {
        return ToolResult.error(
          '目标窗口「' + hit.name + '」当前状态为「' + hit.statusLabel + '」，为避免打断正在跑的任务已拒绝派发。'
          + '若确认要强制派发，请传 allowBusy=true。'
        );
      }

      const ctx = windowState.getWindowByProfileId(hit.profileId);
      if (!ctx) return ToolResult.error('窗口「' + hit.name + '」已关闭');

      const wc = ctx.view ? ctx.view.webContents : null;
      if (!wc || wc.isDestroyed()) return ToolResult.error('目标窗口的 AI 视图不可用');

      // 通过已有的 send-to-chat 通道派发（目标窗口会填入并自动发送）
      wc.send('lingya-send-to-chat', { text: instruction, tag: '来自其他窗口的派发' });

      return ToolResult.success({
        dispatched: true,
        target: hit.name,
        profileId: hit.profileId,
        targetStatus: hit.statusLabel,
        message: '已派发到「' + hit.name + '」',
      });
    } catch (err) {
      return ToolResult.error('派发失败: ' + err.message);
    }
  }
}

module.exports = { ListWindowsTool, DispatchToWindowTool };
