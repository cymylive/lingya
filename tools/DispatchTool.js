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

/** 列出所有可用窗口（带 @编号 标签，供派发时精准引用） */
function collectWindows() {
  const windowState = require('../src/main/window');
  const profileManager = require('../src/main/profile-manager');
  const out = [];
  for (const ctx of windowState.getAllContexts()) {
    let name = ctx.profileId || '窗口';
    let provider = ctx.providerId || '';
    let number = null;
    try {
      const p = profileManager.getProfileById(ctx.profileId);
      if (p) {
        name = p.name || name;
        if (p.providerId) provider = p.providerId;
        if (typeof p.number === 'number') number = p.number;
      }
    } catch (_) {}
    const st = deriveWindowStatus(ctx);
    out.push({
      profileId: ctx.profileId,
      number,                              // 窗口编号（界面可见，可改）
      tag: number != null ? ('@' + number) : '',  // 派发时用的引用标签
      name,
      provider,
      status: st.status,
      statusLabel: st.label,
    });
  }
  // 按编号排序，方便 AI 输出与用户对照
  out.sort((a, b) => (a.number || 9999) - (b.number || 9999));
  return out;
}

/**
 * 从 target 中解析出可能的编号。
 * 支持 @3、@1552、3 三种写法。
 * @returns {number|null}
 */
function parseNumberTarget(target) {
  const t = String(target || '').trim();
  // @数字
  let m = t.match(/^@(\d+)$/);
  if (m) return parseInt(m[1], 10);
  // 纯数字
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  // 中文里夹着的 @数字（如「@3窗口」）
  m = t.match(/@(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** 从 profile.id 中提取数字串（如 profile-1791980276246-u32wyv → '1791980276246'） */
function idDigits(profileId) {
  const m = String(profileId || '').match(/(\d{6,})/);
  return m ? m[1] : '';
}

class ListWindowsTool extends Tool {
  constructor() {
    super(
      'listWindows',
      '列出当前所有已打开的 LingYa 应用内窗口（编号 / 名字 / 平台 / 运行状态）。返回的 tag 形如 @3，可直接作为 dispatchToWindow 的 target 精准定位。注意：这里指 LingYa 应用内部的窗口，与 Windows 操作系统的窗口无关。',
      { type: 'object', properties: {}, additionalProperties: false },
      'listWindows()'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:listWindows',
      order: 200,
      text: [
        '**跨窗口调度（重要）**：当用户提到「窗口」并带有编号时（如「@3 继续任务」「窗口2 推送代码」「让 1 号窗口看一下」），指的是 **LingYa 应用内部的窗口**，不是 Windows 操作系统的窗口。',
        '处理步骤：① 先调用 listWindows() 拿到窗口列表；② 用户用了 @编号 或纯数字时，把该数字直接作为 target 传给 dispatchToWindow（如 dispatchToWindow("@3", "继续任务")）；③ 用户只说了名字时，target 传名字；④ 不要凭空猜窗口名或编号，必须先 listWindows 确认。',
        'listWindows() 返回的每个窗口都带 tag 字段（形如 @3），可直接拿来用。',
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
      '把一条指令派发给指定的 LingYa 应用内窗口（自动填入并发送到那个窗口的聊天框）。target 支持三种写法：@编号（推荐，如 @3）、纯数字编号（如 3）、窗口名。目标窗口忙碌时会拒绝派发。',
      {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标窗口，支持 @编号（如 @3，推荐）、纯数字编号（如 3）、或窗口名（用 listWindows 拿到的 name）' },
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
        '- target 优先用 @编号（如 @3）：先按窗口编号精确匹配，再按窗口 ID 中的数字串匹配，都找不到就直接报错并列出可用窗口，不会误派给名字相近的窗口',
        '- 也可以传纯数字（如 3）或窗口名（如「窗口2」）',
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

      // ===== 三级解析：@编号 / 纯数字编号 / 名字 =====
      // 1) 先尝试解析出编号
      const wantNum = parseNumberTarget(target);
      let hit = null;

      if (wantNum != null) {
        // 1a) 按窗口编号精确匹配
        hit = list.find(w => w.number === wantNum);
        // 1b) 编号没命中时，按 profile.id 里的数字串匹配（支持 @1552 这种长数字）
        if (!hit) {
          const wantStr = String(wantNum);
          hit = list.find(w => idDigits(w.profileId).includes(wantStr));
        }
        // 1c) 编号命中不了且是 @ 开头 —— 直接报错，不做名字回退（避免歧义）
        if (!hit && /^@\d+$/.test(String(target).trim())) {
          const avail = list
            .map(w => (w.tag ? w.tag + ' ' : '') + w.name + ' [' + w.statusLabel + ']')
            .join('\n');
          return ToolResult.error(
            '找不到编号 ' + wantNum + ' 的 LingYa 窗口。当前可用窗口：\n' + (avail || '(无)')
          );
        }
      }

      // 2) 编号没命中（或不是数字写法）→ 按名字匹配
      if (!hit) {
        const raw = String(target).trim().replace(/^@/, '');
        hit = list.find(w => w.name === raw)
          || list.find(w => w.profileId === raw)
          || list.find(w => String(w.name).includes(raw) || String(w.profileId).includes(raw));
      }

      if (!hit) {
        const avail = list
          .map(w => (w.tag ? w.tag + ' ' : '') + w.name + ' [' + w.statusLabel + ']')
          .join('\n');
        return ToolResult.error('找不到窗口「' + target + '」，当前可用窗口：\n' + (avail || '(无)'));
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
