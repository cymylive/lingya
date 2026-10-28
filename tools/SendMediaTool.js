const { Tool, ToolResult } = require('./ToolRegistry');

/**
 * 发送媒体工具：让 AI 把本地文件/图片发到已连接的通信通道。
 *
 * 支持通道：feishu（飞书）、weixin（微信）
 * 通道能力与大小上限由各适配器声明，registry 前置校验。
 *
 * 为什么需要这个工具：
 *   用户在手机上让 AI 处理文件，处理完 AI 需要主动把结果推回去。
 *   没有这个工具时，AI 只能回复文字，产出文件用户拿不到。
 */
class SendMediaTool extends Tool {
  constructor() {
    super(
      'send_media',
      '把本地文件或图片发送到已连接的通信通道（飞书/微信）。用于把处理结果回传给用户。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地文件绝对路径，如 C:/temp/result.xlsx' },
          channel: { type: 'string', enum: ['feishu', 'weixin'], description: '目标通道，默认 feishu' },
          target: { type: 'string', description: '接收方标识（飞书 chatId/openId，微信 userId）。省略则发回最近一次来消息的来源' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      'send_media({ path, channel?, target? })'
    );
  }

  getPromptSection() {
    const lines = [
      '## 发送文件给用户',
      '',
      '当你在本机生成了文件/图片，且用户是通过飞书或微信发来请求时，用 send_media 把结果回传：',
      '',
      '- send_media({ path: "C:/xxx/result.xlsx" }) —— 默认走飞书',
      '- send_media({ path: "...", channel: "weixin" }) —— 走微信',
      '',
      '约束：',
      '- path 必须是**绝对路径**，相对路径会被拒绝',
      '- 飞书：图片 ≤10MB，文件 ≤30MB；微信：图片 ≤10MB，文件 ≤20MB',
      '- 通道必须已连接，否则报错',
      '- 微信要求对方先发过消息（协议限制 context_token）',
    ];
    return {
      name: 'tool:send_media',
      order: 120,
      text: lines.join('\n'),
    };
  }

  async execute(params) {
    const p = params || {};
    const filePath = String(p.path || '').trim();
    if (!filePath) return ToolResult.error('path 不能为空');

    const channel = String(p.channel || 'feishu').trim().toLowerCase();
    const target = p.target ? String(p.target) : '';

    let registry;
    try {
      registry = require('../src/main/media/registry');
    } catch (err) {
      return ToolResult.error('媒体模块未就绪: ' + err.message);
    }

    try {
      const r = await registry.send(channel, filePath, target);
      if (!r.success) return ToolResult.error('发送失败: ' + r.error);
      return ToolResult.success(
        '已通过 ' + channel + ' 发送 ' + (r.fileName || filePath) +
        '（' + (r.kind === 'image' ? '图片' : '文件') + '，' + ((r.size || 0) / 1024).toFixed(1) + ' KB）'
      );
    } catch (err) {
      return ToolResult.error('发送异常: ' + err.message);
    }
  }
}

module.exports = { SendMediaTool };
