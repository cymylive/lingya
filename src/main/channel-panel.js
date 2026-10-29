/**
 * 通道通用面板格式化（QQ / 微信 / 飞书共用）
 *
 * 抽出来的原因：三个通道原先各写各的推送格式，QQ 已经改成任务计划面板，
 * 微信和飞书还是老的「碎片 + 汇总」。统一到本模块后，三通道输出一致。
 *
 * 纯文本，不依赖任何平台特性 —— 飞书也降级用这个（放弃卡片），
 * 换取三端一致的阅读体验。
 */

/** 当前时间格式化：2026年10月30日 04:34:57 星期四 */
function formatNow() {
  const d = new Date();
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const pad2 = function (n) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    ' 星期' + WEEK[d.getDay()];
}

/**
 * 任务计划面板
 *
 * 格式：
 *   📋 任务计划（6步）
 *   1. ☑ 改版本号
 *   2. 🔨 跑打包
 *   3. ⬜ 验证产物
 *   ━━━━━━━━━━
 *   正在处理第2步：跑打包（剩余4步）
 *   当前时间：2026年10月30日 04:34:57 星期四
 *   当前任务：🔧 AI 正在调用工具…
 *
 * 状态符号：completed → ☑ / in_progress → 🔨 / pending → ⬜
 * 「剩余x步」= 当前步之后还有多少步未完成（不含当前步）
 *
 * @param {Array<{content:string,status:string}>} todos AI 的计划列表
 * @param {string} activity 当前活动状态文案
 * @returns {string} 可直接推送的面板文本；空列表返回空串
 */
function formatTodoPanel(todos, activity, options) {
  if (!Array.isArray(todos) || todos.length === 0) return '';
  options = options || {};
  const isFinal = options.isFinal === true;

  const SYMBOL = { completed: '☑', in_progress: '🔨', pending: '⬜' };
  const total = todos.length;
  const lines = ['📋 任务计划（' + total + '步）'];

  let curIdx = -1;
  for (let i = 0; i < total; i++) {
    const t = todos[i] || {};
    const sym = SYMBOL[t.status] || '⬜';
    lines.push((i + 1) + '. ' + sym + ' ' + String(t.content || '').slice(0, 60));
    if (t.status === 'in_progress' && curIdx === -1) curIdx = i;
  }

  lines.push('━━━━━━━━━━');

  if (isFinal) {
    // 任务结束：不再显示「正在处理第X步」，改为完成度统计
    const doneCount = todos.filter(function (t) { return t && t.status === 'completed'; }).length;
    lines.push('🏁 任务结束（完成 ' + doneCount + '/' + total + ' 步）');
  } else if (curIdx === -1) {
    const allDone = todos.every(function (t) { return t && t.status === 'completed'; });
    if (allDone) {
      lines.push('🏁 全部完成（' + total + '步）');
    } else {
      lines.push('等待开始…');
    }
  } else {
    const cur = todos[curIdx] || {};
    const remain = total - curIdx - 1;
    lines.push('正在处理第' + (curIdx + 1) + '步：' + String(cur.content || '').slice(0, 40) + '（剩余' + remain + '步）');
  }

  lines.push('当前时间：' + formatNow());
  if (activity) lines.push('当前状态：' + activity);

  return lines.join('\n');
}

/**
 * 无计划面板（AI 没建 todo 的轮次）
 *
 * 与 formatTodoPanel 保持同一视觉骨架，只是计划部分显示「无」。
 * 用途：task-done 汇总时，如果本轮从没推过计划面板，就在正文前补一个这个，
 * 让通道里所有轮次的格式统一，不再是「有 todo 推面板、没 todo 推裸文本」。
 *
 * @param {string} activity 结束时状态，默认 ✅ 已回复
 * @returns {string}
 */
function formatEmptyPanel(activity) {
  return [
    '📋 任务计划',
    '无',
    '━━━━━━━━━━',
    '正在处理无计划',
    '当前时间：' + formatNow(),
    '当前状态：' + (activity || '✅ 已回复'),
  ].join('\n');
}


/**
 * 剥掉 Markdown 符号（2026-10-30）
 *
 * 背景：QQ / 微信 / 飞书都不渲染 Markdown，AI 回复里的 `**粗体**`、``行内代码``、
 * `### 标题` 会原样显示，读起来是乱码。
 *
 * 策略：
 *   1. 先把代码块（``` ... ```）整段抽出来占位，最后还原——块内内容一律不动
 *   2. 剥行内符号：粗体、斜体、行内代码、删除线
 *   3. 剥行首标题井号
 *   4. 链接 [文字](url) → 文字
 *   5. 还原代码块
 *
 * 误伤说明：AI 若在正文里讲 Markdown 语法（如「用 ** 表示加粗」），这段符号会被一并剥掉。
 * 这是可接受的取舍——聊天通道优先可读性。
 *
 * @param {string} text 原始文本
 * @returns {string} 剥离 Markdown 后的纯文本
 */
function stripMarkdown(text) {
  if (!text || typeof text !== 'string') return '';

  // 1. 抽出代码块，用占位符代替（占位符含不可见分隔，避免与正文冲突）
  const codeBlocks = [];
  let out = text.replace(/```[\s\S]*?```/g, function (m) {
    const idx = codeBlocks.length;
    codeBlocks.push(m);
    return '\u0000CODEBLOCK' + idx + '\u0000';
  });

  // 2. 行内代码：`xxx` → xxx
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // 3. 粗体：**xxx** 或 __xxx__ → xxx
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');

  // 4. 斜体：*xxx* 或 _xxx_ → xxx（必须在粗体之后处理，避免吃掉粗体的星号）
  out = out.replace(/\*([^*\n]+)\*/g, '$1');
  out = out.replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)）,.!?，。！？]|$)/g, '$1$2');

  // 5. 删除线：~~xxx~~ → xxx
  out = out.replace(/~~([^~\n]+)~~/g, '$1');

  // 6. 行首标题：### 标题 → 标题（连续 1-6 个 #）
  out = out.replace(/^#{1,6}\s+/gm, '');

  // 7. 链接：[文字](url) → 文字
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 8. 还原代码块（占位符替换回原文）
  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, function (_m, idx) {
    return codeBlocks[Number(idx)] || '';
  });

  return out;
}

module.exports = { formatNow, formatTodoPanel, formatEmptyPanel, stripMarkdown };
