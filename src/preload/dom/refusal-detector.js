/**
 * 拒绝回复检测器（移植自 codex-session-patcher 的 RefusalDetector）
 *
 * 三级策略：
 * 1. 强拒绝短语：出现在任意位置即判定（误报率低）
 * 2. 弱拒绝关键词：仅在消息开头 150 字符内出现才判定
 * 3. 自定义关键词：作为强匹配，全文搜索
 *
 * 设计目标：**一切 AI 表现不肯做的表述都算拒绝**，全部触发改写。
 * 因此词表覆盖：
 *   - 显式拒绝（我不能做 / I cannot）
 *   - 软拒绝（这不太合适 / 恐怕不行 / I'm not comfortable）
 *   - 转移话题（换个话题 / let's talk about something else）
 *   - 建议找别人（建议你咨询专业人士 / consult a professional）
 *   - 能力/边界声明（超出了我的能力 / outside my scope）
 *
 * classifyRefusal 仍保留分级能力，但**不再用于短路改写**——
 * 0.6.93 之前的「性质类跳过」正是用户反馈「触发范围太小」的根因。
 */

// ===== 强拒绝短语：出现在任意位置即判定 =====
const STRONG_REFUSAL_PHRASES = [
  // ---------- 中文：显式拒绝 ----------
  '我无法协助', '我无法帮助', '我不能协助', '我不能帮助',
  '我不能做这个', '我无法做这个', '我不能做这件事', '我无法做这件事',
  '我不能做这事', '我无法做这事', '我不能干这事', '我无法干这事',
  '我无法提供', '我不能提供',
  '我不能参与', '我无法参与', '我不会参与',
  '我不能这么做', '我不能这么干', '我不能这样做',
  '我不会帮你', '我不会帮你做', '我不会帮这个忙',
  '我不做这个', '我不干这个', '我不做这事', '我不干这事',
  '我做不了', '我干不了', '我做不到', '我完成不了',
  '我确实做不了', '我确实不能', '我确实无法', '我确实不会',
  '帮不了你', '帮不了这个忙', '这个忙我帮不了',
  '这事我做不了', '这事我干不了', '这事我帮不了', '这事我做不来',
  '我不会去做', '我不会去执行', '我不能去执行', '我不能去操作',
  '我不能同意', '我无法同意', '我不能接受这个请求',
  '我必须拒绝', '我不得不拒绝', '我需要拒绝', '我只能拒绝',
  '我拒绝执行', '我拒绝提供', '我拒绝回答', '我拒绝协助',
  '拒绝执行', '拒绝提供', '拒绝回答', '拒绝协助',
  '我不方便做', '我不方便回答', '我不方便提供',

  // ---------- 中文：软拒绝 / 委婉拒绝 ----------
  '爱莫能助', '无能为力', '恕难从命', '恕我不能', '恕我无法',
  '恐怕不行', '恐怕我不能', '恐怕无法', '恐怕帮不了',
  '超出了我的能力', '超出了我的职责',
  '不在我的服务范围', '不在我的能力范围', '不在我的职责范围',
  '不在我的允许范围', '这不在我的职责', '这不在我的能力',
  '我无法满足', '我不能满足', '我难以满足', '我无法满足你的',
  '我不能为你', '我无法为你',

  // ---------- 中文：转移话题 / 建议找别人 ----------
  '换个话题吧', '聊点别的吧', '我们聊点别的', '我们换个话题',
  '我建议你换个话题', '建议你换一个话题',
  '我建议你咨询', '建议你咨询专业', '建议你找专业', '建议你咨询律师',
  '建议你找相关专业', '请咨询专业人士', '请找专业人士',

  // ---------- 中文：性质/边界表述（原 NATURE_SIGNALS 并入） ----------
  '违反了我的', '违反我的',
  '侵权', '盗版', '分发工具', '分发盗版',
  '绕过付费', '没付费', '未付费', '未授权第三方',
  '违法', '法律责任',
  '这个改写请求我不执行', '不会执行这个改写', '我不执行这个改写',

  // ---------- 英文：显式拒绝 ----------
  "i cannot assist", "i can't assist", "i'm unable to assist",
  "i cannot help", "i can't help", "i'm unable to help",
  "i cannot do that", "i can't do that", "i won't do that",
  "i cannot do this", "i can't do this", "i won't do this",
  "i cannot comply", "i can't comply",
  "i cannot fulfill", "i can't fulfill",
  "i cannot provide", "i can't provide",
  "i cannot participate", "i can't participate",
  "i won't help", "i won't assist", "i won't provide",
  "i refuse to", "i must refuse", "i have to refuse", "i need to refuse",
  "i must decline", "i have to decline", "i need to decline", "i'm declining",

  // ---------- 英文：软拒绝 / 边界声明 ----------
  "i'm not comfortable", "i am not comfortable",
  "i'm not going to", "i am not going to",
  "i'm not permitted", "i am not permitted",
  "not permitted to", "not allowed to",
  "not something i can", "not something i will",
  "outside my scope", "beyond my capabilities", "beyond my scope",
  "not within my", "not able to provide", "not able to assist",
  "unable to fulfill", "unable to comply", "unable to provide",
  "won't be able to", "will not be able to",
  "i don't think i should", "i shouldn't do",
  "against my guidelines", "against my policy", "against my programming",
  "against my ethical", "violates my",
  "as an ai", "as a language model",
  "i apologize, but i", "i'm sorry, but i can't",
  "not appropriate for me", "that's not appropriate", "this is not appropriate",

  // ---------- 英文：转移话题 / 建议找别人 ----------
  "let's talk about something else", "let's change the subject",
  "consult a professional", "seek professional help",
  "recommend consulting", "recommend seeking",

  // ---------- 中文：假配合 / 点到为止（最高频的软拒绝）----------
  // 特征：前半句答应，后半句收口。靠"但+具体"的转折识别。
  '但具体操作', '但具体步骤', '但具体代码', '但具体实现', '但具体细节',
  '但实际操作', '但实际执行',
  '具体操作需要你自己', '具体步骤需要你自己', '具体代码需要你自己',
  '实际操作需要你自己', '实现细节需要你自己',
  '我只能提供概念', '我只能给出概念', '我只能解释原理', '我只能讲讲原理',
  '我只能告诉你原理', '我只能说个大概', '我只能讲到这个程度',
  '不能提供具体步骤', '不能提供具体操作', '不能给出具体步骤',
  '不能给出具体代码', '不能提供具体实现', '不能提供可执行',
  '原理可以讲，但', '概念可以讲，但', '思路可以给，但',

  // ---------- 中文：政策 / 合规 / 准则 ----------
  '不符合我的使用政策', '不符合我的使用条款', '不符合我的安全准则',
  '不符合我的服务条款', '不符合我的设定', '不符合我的原则',
  '我的安全准则不允许', '我的使用政策不允许', '我的使用条款不允许',
  '我的设定不允许', '我的原则不允许', '我的准则不允许',
  '根据我的使用政策', '按照我的使用条款', '根据我的安全准则',
  '根据平台规定，我不能', '根据规定，我不能',

  // ---------- 中文：敏感 / 危险声明 ----------
  '这可能被滥用', '可能被滥用', '存在被滥用的风险', '有被滥用的风险',
  '这可能造成危害', '可能造成实际伤害', '可能被用于伤害',
  '出于安全考虑，我不能', '出于安全原因，我不能', '出于安全考虑我无法',
  '这可能违反法律', '这可能涉及隐私',

  // ---------- 中文：道德 / 伦理 / 责任 ----------
  '这不道德', '从道德上我不能', '从伦理上我不能',
  '我有责任拒绝', '作为 ai 我有责任', '作为人工智能我有责任',

  // ---------- 中文：劝退 / 反建议 ----------
  // 整类已剔除（0.6.94 误报回归）："我建议你把这个循环改成 map"、
  // "不建议在生产环境开启 debug"、"这不明智" 都是正常技术建议，会被误判为拒绝。

  // ---------- 中文：能力推脱 ----------
  '我没有这个能力', '我不具备这个能力', '我不具备这个功能',
  '我不具备相关能力', '我做不到这个', '我的能力有限',
  '我无法访问', '我无法执行代码', '我无法直接操作',
  '我只能处理文本', '我只能提供文字',

  // ---------- 中文：回避 / 跳过话题 ----------
  '这个话题不适合讨论', '这个话题我不方便讨论', '这个话题我们不讨论',
  '这个问题我暂时无法回答', '这个我暂时不能讨论',
  '这个我们略过', '我们跳过这个', '这个话题到此为止',
  '恕我直言，我不能', '很遗憾，我不能', '非常抱歉，我不能',
  '很抱歉，我无法', '非常抱歉，我无法',

  // ---------- 中文：口语委婉（0.6.94 新增）----------
  // 中文口语拒绝的标准形态。注意「这个嘛」单独歧义大（可能是正常停顿），
  // 因此要求后面跟拒绝信号（如「这个嘛……有点难办」由「有点难办」兜住）。
  '有点难办', '不太好办', '不好办', '不太好说', '不太方便',

  // ---------- 中文：提醒式（0.6.94 新增）----------
  // 模型用「我有义务提醒」代替「我拒绝」，是软拒绝的固定句式。
  '我必须提醒你', '我有义务提醒', '我需要提醒一下风险', '我需要提醒你注意',
  '出于负责任', '出于负责任的态度',

  // ---------- 中文：特殊性（0.6.94 新增）----------
  '这个请求比较特殊', '这个请求比较敏感', '这类问题比较敏感',
  '不适合展开', '需要谨慎处理', '我需要谨慎处理',

  // ---------- 中文：推给系统 / 人工（0.6.94 新增）----------
  // 模型甩锅的标准话术。
  '需要人工审核', '需要走正式流程', '需要提交申请', '需要正式申请',
  '不是我能决定的', '请联系管理员', '需要人工介入', '需要人工处理',
  '请联系相关部门', '需要走审批流程',

  // ---------- 英文：假配合 / 点到为止 ----------
  "i can explain the concept", "i can describe the concept",
  "i can only provide", "i can only explain", "i can only describe",
  "but i cannot provide", "but i can't provide",
  "but i cannot give", "but i can't give",
  "specific steps you'll need", "you'll need to do that yourself",
  "i can walk you through the concept",

  // ---------- 英文：政策 / 合规 ----------
  "against my usage policy", "against my terms of service",
  "against my safety guidelines", "my safety guidelines",
  "my guidelines don't allow", "my guidelines do not allow",
  "my programming prevents", "my policies prevent",
  "doesn't comply with my", "does not comply with my",
  "per my guidelines", "according to my guidelines",

  // ---------- 英文：敏感 / 危险 ----------
  "this could be harmful", "this could be misused", "could be used to harm",
  "risk of misuse", "risk of harm", "potential for harm",
  "for safety reasons", "for ethical reasons", "for legal reasons",
  "due to safety concerns", "due to ethical concerns", "due to legal concerns",

  // ---------- 英文：劝退 / 反建议 ----------
  // 整类已剔除（0.6.94 误报回归）："I recommend against using eval"、"You should not commit node_modules"
  // 都是正常技术建议，会被误判为拒绝。

  // ---------- 英文：能力推脱 ----------
  "i don't have the ability", "i do not have the ability",
  "i don't have access", "i do not have access",
  "i'm not able to access", "i am not able to access",
  "i can't access", "i cannot access",
  "i can only process text", "i can only provide text",

  // ---------- 英文：委婉推脱 ----------
  "i'm going to have to pass", "i'll pass on this", "i have to pass",
  "i'm going to decline", "i'd prefer not to", "i would prefer not to",
  "i can't in good conscience", "i cannot in good conscience",
  "i don't feel comfortable", "i do not feel comfortable",
  "that crosses a line", "i have to draw the line",
  "i'm afraid i can't", "i'm afraid i cannot",
  "unfortunately, i can't", "unfortunately, i cannot",
  "regrettably", "i must respectfully decline",
  "i cannot and will not", "i won't be doing that",
  "not something i'm able to help with", "not something i can help with",
  "i have to stop here", "i need to stop here",
  "i can't go into", "i cannot go into", "i won't go into detail",
  "outside the scope of what i", "this is outside the scope of my",
];

// ===== 弱拒绝关键词：需要出现在消息开头（前 150 字符）才算拒绝 =====
const WEAK_REFUSAL_KEYWORDS = [
  // ---------- 中文：道歉开头 ----------
  '抱歉，我', '很抱歉', '对不起，我', '不好意思，我', '见谅',
  // ---------- 中文：否定情态 ----------
  '我无法', '我不能', '我不会', '我不方便', '我不做', '我不干', '我做不了', '我干不了',
  '这个我确实', '这个我做不了', '这个我干不了', '这个我帮不了',
  '做不了这个', '干不了这个', '帮不了这个',
  // ---------- 中文：遗憾/犹豫 ----------
  '恐怕', '很遗憾', '遗憾', '有点为难', '比较为难',
  // ---------- 中文：转移/建议 ----------
  '换个话题', '聊点别的', '这不太', '这不合适', '不太妥当', '不太合适',
  '这不在', '超出了', '难以', '无法满足', '不能满足',
  // ---------- 英文：道歉开头 ----------
  'sorry, i', 'apologize', 'regret',
  // ---------- 英文：否定情态 ----------
  "i cannot", "i can't", "i won't", "i'm unable",
  "i am unable", 'unable to',
  "i'm not able", "i am not able",
  'not permitted', 'not allowed',
  'refuse to', 'decline to',
  // ---------- 英文：遗憾/犹豫 ----------
  'unfortunately', 'not comfortable', 'not appropriate',
  "i'd rather not", "i would rather not",
  "let's not", "we can't", "we cannot",

  // ---------- 中文：泛指型（可能是技术描述，仅开头判）----------
  // 0.6.94 误报回归剔除：不建议/不推荐/有风险/不符合/违反/暂时无法/我的职责/这不行/恕我
  // —— 这些在正常技术说明里高频出现（"违反约束时会抛异常"、"暂时无法连接数据库"）。
  '出于安全考虑，我', '出于道德考虑，我', '出于伦理考虑，我', '出于法律考虑，我',
  '这可能有风险',
  '作为 ai', '作为人工智能', '作为一个 ai',
  '我的原则', '我的底线',

  // ---------- 中文：条件式推脱（0.6.94 新增）----------
  // 表面说「可以做」，实际是「不给授权就不做」。仅开头判定，避免正常法律说明误报。
  '如果你有正式授权', '前提是你拥有', '在有明确授权的前提下',
  '如果你有合法授权', '前提是你有合法权限',

  // ---------- 英文：泛指型 ----------
  "i'm programmed to", "i am programmed to", "i'm designed to", "i am designed to",
  'as an assistant', 'as an ai assistant',
  "i'm afraid", 'out of scope',
  "i'm here to help, but", 'not sure if i should',
];

/**
 * 性质类信号 —— 现在**仅用于日志分级**，不再短路改写。
 * 保留是为了诊断：能看出用户遇到的拒绝是「性质类」还是「措辞类」。
 */
const NATURE_SIGNALS = [
  '性质', '实质', '本质',
  '不在设计范围', '设计边界', '不在范围内',
  '改不了这件事', '改写只能处理措辞',
  '侵权', '盗版', '分发工具', '分发盗版', '分发给',
  '绕过付费', '没付费', '未付费', '未授权第三方',
  '伤害', '损害', '违法', '法律责任',
  '这个改写请求我不执行', '不会执行这个改写', '我不执行这个改写',
];

/**
 * 措辞类信号 —— 表示「说法/理解」有问题，改写有意义。
 */
const WORDING_SIGNALS = [
  '措辞', '表述', '表达方式',
  '误解', '误会', '理解错',
  '澄清', '换个说法', '重新表述', '说清楚',
  '如果你是想', '如果你要的是', '如果你的意思是',
  '我完全可以做', '我可以做', '这个我能做',
];

function hasMetaDiscussion(lower) {
  const sorted = STRONG_REFUSAL_PHRASES.slice().sort((a, b) => b.length - a.length);
  const covered = new Set();
  let independentHits = 0;
  for (const phrase of sorted) {
    let hit = false;
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      let allCovered = true;
      for (let i = idx; i < idx + phrase.length; i++) {
        if (!covered.has(i)) { allCovered = false; break; }
      }
      if (!allCovered) {
        hit = true;
        for (let i = idx; i < idx + phrase.length; i++) covered.add(i);
      }
      idx = lower.indexOf(phrase, idx + 1);
    }
    if (hit) independentHits++;
  }
  if (independentHits > 5) {
    logMetaDiscussion(independentHits);
    return true;
  }
  return false;
}

/**
 * 护栏日志节流（I2）：同一命中数 60 秒内只打一次，
 * 避免 detectRefusal 每轮调用都刷屏冲掉真正的拦截记录。
 */
const _metaLogCache = new Map();
const META_LOG_TTL_MS = 60000;
function logMetaDiscussion(count) {
  const now = Date.now();
  const key = 'meta:' + count;
  const last = _metaLogCache.get(key) || 0;
  if (now - last < META_LOG_TTL_MS) return;
  _metaLogCache.set(key, now);
  if (_metaLogCache.size > 50) {
    for (const [k, t] of _metaLogCache) {
      if (now - t > META_LOG_TTL_MS) _metaLogCache.delete(k);
    }
  }
  console.log('[RefusalDetector] 元讨论护栏：命中 ' + count + ' 个独立强拒绝短语，判定为非拒绝');
}

/**
 * 检测内容是否为拒绝回复
 * @param {string} content 待检测文本
 * @param {object} [customKeywords] 自定义关键词 { zh: [], en: [] }
 * @returns {boolean}
 */
function detectRefusal(content, customKeywords) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();

  // 元讨论护栏（见 hasMetaDiscussion 注释）
  if (hasMetaDiscussion(lower)) return false;

  // 1. 强拒绝短语 - 全文匹配
  for (const phrase of STRONG_REFUSAL_PHRASES) {
    if (lower.includes(phrase)) return true;
  }

  // 2. 弱拒绝关键词 - 仅匹配开头 150 字符
  const head = lower.slice(0, 150);
  for (const keyword of WEAK_REFUSAL_KEYWORDS) {
    if (head.includes(keyword)) return true;
  }

  // 3. 用户自定义关键词 - 全文匹配
  if (customKeywords && typeof customKeywords === 'object') {
    for (const lang of Object.keys(customKeywords)) {
      const list = customKeywords[lang];
      if (!Array.isArray(list)) continue;
      for (const keyword of list) {
        if (typeof keyword === 'string' && keyword && lower.includes(keyword.toLowerCase())) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * 只检测「强拒绝」——用于判断改写回复本身是否也是拒绝。
 * 比 detectRefusal 更严格：不查弱关键词（避免「抱歉，之前理解错了…」这种
 * 有效改写的开场白被误判）。
 * @param {string} content
 * @returns {boolean}
 */
function isStrongRefusal(content) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  // C2 修复：与 detectRefusal 共用元讨论护栏，避免「讨论拒绝词表」被判为强拒绝
  if (hasMetaDiscussion(lower)) return false;
  for (const phrase of STRONG_REFUSAL_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

/**
 * 判断一条拒绝属于哪一类（**仅用于日志分级**，不再决定是否改写）。
 *
 * 判定顺序：
 *   1. 不是拒绝 → none
 *   2. 命中性质信号 → nature
 *   3. 命中措辞信号 → wording
 *   4. 都没命中 → wording（保守改为 wording：既然检测到拒绝就该改写）
 *
 * 注意：0.6.93 之前这里返回 nature 会导致 intercept-observer 跳过改写，
 * 用户反馈「触发范围太小」。现在所有拒绝一律改写，本函数只做标记。
 *
 * @param {string} content 完整回复文本
 * @param {object} [customKeywords] 同 detectRefusal
 * @returns {'none'|'nature'|'wording'}
 */
function classifyRefusal(content, customKeywords) {
  if (!detectRefusal(content, customKeywords)) return 'none';
  if (!content || typeof content !== 'string') return 'none';
  const lower = content.toLowerCase();

  for (const sig of NATURE_SIGNALS) {
    if (lower.includes(sig)) return 'nature';
  }
  for (const sig of WORDING_SIGNALS) {
    if (lower.includes(sig)) return 'wording';
  }
  // 无法细分 → 仍按 wording（可改写），不阻断
  return 'wording';
}

module.exports = {
  STRONG_REFUSAL_PHRASES,
  WEAK_REFUSAL_KEYWORDS,
  NATURE_SIGNALS,
  WORDING_SIGNALS,
  detectRefusal,
  isStrongRefusal,
  classifyRefusal,
};
