/**
 * nameConversation 工具 —— AI 生成对话标题建议（不再自动改会话名）
 *
 * 背景变更：用户希望「AI 只产出标题，实际改名由用户手动完成」。
 * 因此本工具不再写 session-store，改为：
 *   1) 广播 session-title-suggested 事件给所有窗口（覆盖层 Toast 显示）；
 *   2) 把建议标题作为工具结果返回给 AI（AI 回复里再复述一遍，防漏看）。
 *
 * 会话列表 / 窗口标题 / 页面标题都不再受本工具影响 —— 改名请走侧栏手动重命名。
 */
const { Tool, ToolResult } = require('./ToolRegistry');

class NameConversationTool extends Tool {
  constructor() {
    super(
      'nameConversation',
      '生成一个对话标题建议并展示给用户（不会自动修改会话名；由用户手动应用到会话列表）。',
      {
        type: 'object',
        properties: {
          title: { type: 'string', description: '对话标题（简短，建议不超过 20 字）' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      'nameConversation(title)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:nameConversation',
      order: 114,
      text: [
        '**对话命名（重要）**：每次对话的**首条用户消息**处理时，**立即**调用一次 nameConversation(title) 生成一个简短标题（中文，≤20 字，概括用户意图）。',
        '这是本次对话的**第一个动作**，先生成建议再干别的。',
        '注意：本工具**只产出建议标题**，不会自动写入会话名；用户会手动应用。所以调用后不要声称“已重命名”，而要说“建议标题：xxx”。',
        '示例：用户说“帮我修复登录 bug” → 先 await nameConversation("修复登录 bug")，再开始干活。',
      ].join('\n'),
    };
  }

  /**
   * 从标题参数里取出真正的字符串。
   * 为什么需要：AI 有时把标题包在对象里传（{name:'x'} / {text:'x'}），
   * 直接 String(obj) 会得到 '[object Object]' 并污染会话标题。
   * 返回 null 表示无法解析（调用方应报错，而不是存一个假标题）。
   */
  _resolveTitle(raw) {
    if (typeof raw === 'string') {
      const s = raw.trim();
      return s || null;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of ['title', 'name', 'text', 'value']) {
        const v = raw[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      const keys = Object.keys(raw);
      if (keys.length === 1 && typeof raw[keys[0]] === 'string' && raw[keys[0]].trim()) {
        return raw[keys[0]].trim();
      }
    }
    return null;
  }

  /** 广播建议标题给所有窗口（覆盖层据此弹 Toast） */
  _broadcastSuggested(title) {
    try {
      const windowState = require('../src/main/window');
      if (!windowState || typeof windowState.getAllContexts !== 'function') return;
      const payload = { title };
      for (const ctx of windowState.getAllContexts()) {
        try {
          const wc = ctx.win && ctx.win.webContents;
          if (wc && !wc.isDestroyed()) wc.send('session-title-suggested', payload);
        } catch (_) {}
        try {
          const rawWin = ctx.rawWin;
          if (rawWin && !rawWin.isDestroyed() && rawWin.webContents) {
            rawWin.webContents.send('session-title-suggested', payload);
          }
        } catch (_) {}
      }
    } catch (_) { /* 非窗口上下文（测试/CLI）忽略 */ }
  }

  async execute(params) {
    const raw = params && params.title;
    const title = this._resolveTitle(raw);
    if (!title) {
      return ToolResult.error(
        typeof raw === 'object' && raw !== null
          ? '标题参数格式错误：收到对象，无法解析出标题文本（请传字符串）'
          : '标题为空'
      );
    }

    this._broadcastSuggested(title);

    return ToolResult.success({
      message: '已生成建议标题：' + title + '（未自动应用，由用户手动改名）',
      suggestedTitle: title,
      applied: false,
    });
  }
}

module.exports = { NameConversationTool };
