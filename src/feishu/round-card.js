/**
 * 飞书卡片渲染：把一轮汇总渲染成「正文 + 折叠过程」的交互卡片。
 *
 * 结构：
 *   ┌─────────────────────────────────┐
 *   │ 👤 我：xxx                       │
 *   │ ─────────────────────────────── │
 *   │ 🤖 AI：正文（多条按顺序拼接）      │
 *   │ ─────────────────────────────── │
 *   │ ▸ 💭 执行过程（3 步，耗时 12.3s）  │  ← 折叠面板，默认收起
 *   │   1. +0.2s  `bash`               │
 *   │   2. +5.1s  `read`               │
 *   └─────────────────────────────────┘
 *
 * 为什么用 collapsible_panel：这是飞书卡片唯一支持「点击展开」的原生组件。
 * 卡片 schema 2.0，需飞书客户端 ≥ 7.6。
 */

/**
 * @param {object} round round-collector.finish() 的返回值
 * @returns {object} 飞书卡片 JSON
 */
function buildRoundCard(round) {
  const r = round || {};
  const userText = String(r.userText || '').trim();
  const replies = Array.isArray(r.replies) ? r.replies : [];
  const tools = Array.isArray(r.tools) ? r.tools : [];
  const durationMs = Number(r.durationMs) || 0;

  const elements = [];

  // 用户提问
  if (userText) {
    elements.push({
      tag: 'markdown',
      content: '**👤 我：** ' + userText,
    });
    elements.push({ tag: 'hr' });
  }

  // 深度思考（DeepSeek 的「已思考」内容）：正文之前，默认收起
  const thinkings = Array.isArray(r.thinkings) ? r.thinkings : [];
  const thinkingText = thinkings.join('\n\n').trim();
  if (thinkingText) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: '💭 思考过程（' + thinkingText.length + ' 字）',
        },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'blue', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [{ tag: 'markdown', content: thinkingText }],
    });
  }

  // AI 正文：多条回复按顺序拼接（工具调用之间 AI 说的话也在里面）
  const bodyText = replies.length > 0 ? replies.join('\n\n') : '（本轮无文字回复，仅执行了工具）';
  elements.push({
    tag: 'markdown',
    content: '**🤖 AI：**\n' + bodyText,
  });

  // 折叠面板：工具执行过程
  if (tools.length > 0) {
    elements.push({ tag: 'hr' });
    const { buildToolTimeline } = require('./round-collector');
    const timeline = buildToolTimeline(tools, Date.now() - durationMs);
    const secs = (durationMs / 1000).toFixed(1);
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,                 // 默认收起
      header: {
        title: {
          tag: 'markdown',
          content: '💭 执行过程（' + tools.length + ' 步，耗时 ' + secs + 's）',
        },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        { tag: 'markdown', content: timeline || '（无工具调用）' },
      ],
    });
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
}

module.exports = { buildRoundCard };
