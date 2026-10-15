/**
 * nameConversation 工具 —— AI 给当前对话起标题（对齐 cuckoo-code）
 *
 * 机制：AI 在首条用户消息处理时调用 nameConversation(title)，宿主把标题
 * 写入该会话的 session-store 条目（title 字段），会话列表据此显示标题。
 *
 * 会话 ID 可能还没出现（新对话首条消息还没生成 URL）—— 此时 sessionStore
 * 会暂存标题，等 URL 出现后由 handleUrlChange 自动绑定。
 */
const { Tool, ToolResult } = require('./ToolRegistry');

class NameConversationTool extends Tool {
  constructor() {
    super(
      'nameConversation',
      '给当前对话起一个简短标题（用于会话列表识别）。对话主题明确后调用一次即可。',
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
        '**对话命名（重要）**：每次对话的**首条用户消息**处理时，**立即**调用一次 nameConversation(title) 给本次对话起个简短标题（中文，≤20 字，概括用户意图）。',
        '这是本次对话的**第一个动作**，先命名再干别的。',
        '示例：用户说"帮我修复登录 bug" → 先 await nameConversation("修复登录 bug")，再开始干活。',
        '（若首条消息就很笼统如"你好"，可先用"打招呼"之类的标题，后续主题明确时可再调一次更新。）',
      ].join('\n'),
    };
  }

  async execute(params) {
    const title = String((params && params.title) || '').trim();
    if (!title) return ToolResult.error('标题为空');
    const profileId = params && params.profileId;

    // 通过 profileId 找到窗口上下文，拿到该 profile 的 sessionStore
    let sessionStore = null;
    try {
      const windowState = require('../src/main/window');
      const ctx = profileId ? windowState.getWindowByProfileId(profileId) : windowState.getMainContext();
      sessionStore = ctx ? ctx.sessionStore : null;
    } catch (err) {
      return ToolResult.error('获取会话上下文失败: ' + err.message);
    }
    if (!sessionStore || typeof sessionStore.setSessionTitle !== 'function') {
      return ToolResult.error('会话存储未就绪');
    }

    try {
      const r = sessionStore.setSessionTitle(title);
      if (!r || !r.success) return ToolResult.error((r && r.error) || '设置失败');
      return ToolResult.success({
        message: '对话已命名为：' + title,
        pending: !!r.pending,
      });
    } catch (err) {
      return ToolResult.error('设置对话标题失败: ' + err.message);
    }
  }
}

module.exports = { NameConversationTool };
