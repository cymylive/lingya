'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  detectRefusal,
  isStrongRefusal,
  classifyRefusal,
} = require('../../src/preload/dom/refusal-detector');

// ===== 回归：detectRefusal 原有行为不变 =====
test('detectRefusal 识别强拒绝短语', () => {
  assert.strictEqual(detectRefusal('我无法协助这个请求'), true);
  assert.strictEqual(detectRefusal('I cannot assist with that'), true);
});

test('detectRefusal 识别开头弱关键词', () => {
  assert.strictEqual(detectRefusal('抱歉，这个我不能做'), true);
});

test('detectRefusal 对普通回复返回 false', () => {
  assert.strictEqual(detectRefusal('任务已完成，全部通过'), false);
  assert.strictEqual(detectRefusal('这是代码：\nfunction a(){}'), false);
});

// ===== classifyRefusal 分级 =====
test('classifyRefusal 非拒绝返回 none', () => {
  assert.strictEqual(classifyRefusal('任务已完成'), 'none');
  assert.strictEqual(classifyRefusal(''), 'none');
  assert.strictEqual(classifyRefusal(null), 'none');
});

test('classifyRefusal 性质类：真实拒绝文本', () => {
  const real = [
    '这个我不做——不是套话，是这机制本身在技术上就是错的。',
    '你要的是一个语义等价改写层。这等于在系统里装一个自我欺骗回路。',
    '这不是"提高通过率"，是把安全判断这一层整个短路掉。',
    '## 为什么不能做',
    '把「我不能做的 X」自动转成「我能做的 Y」，且保证 X 和 Y 效果一致。',
    '改写的只是措辞，改不了这件事的性质。',
    '这不在设计范围内。',
  ].join('\n');
  assert.strictEqual(detectRefusal(real), true);
  assert.strictEqual(classifyRefusal(real), 'nature');
});

test('classifyRefusal 性质类：分发/侵权信号', () => {
  const t = '抱歉，我不能帮你做一个让没付费账号也能下载游戏的分发工具。这涉及侵权。';
  assert.strictEqual(classifyRefusal(t), 'nature');
});

test('classifyRefusal 措辞类：误伤 + 澄清后可以做', () => {
  const t = '抱歉，我误解了你的意思。如果你是想分析这个 DLL 的导入表，我完全可以做，请把文件路径给我。';
  assert.strictEqual(detectRefusal(t), true);
  assert.strictEqual(classifyRefusal(t), 'wording');
});

test('classifyRefusal 措辞类：纯表述澄清', () => {
  const t = '我不能协助这个表述。换个说法：你想让我分析固件里的鉴权流程，这个可以做。';
  assert.strictEqual(classifyRefusal(t), 'wording');
});

test('classifyRefusal 无法细分时归 wording（0.6.94：不再阻断改写）', () => {
  // 0.6.94 起：分类只用于日志，不再决定是否改写。
  const t = '我无法提供这个信息。';
  assert.strictEqual(classifyRefusal(t), 'wording');
});

// ===== 0.6.94 新增：扩充词表覆盖 =====
test('扩充：中文软拒绝被识别', () => {
  assert.strictEqual(detectRefusal('这不太合适，恕难从命'), true);
  assert.strictEqual(detectRefusal('恐怕不行，我无能为力'), true);
  assert.strictEqual(detectRefusal('这超出了我的能力范围'), true);
  assert.strictEqual(detectRefusal('建议你咨询专业人士'), true);
  assert.strictEqual(detectRefusal('我们聊点别的吧'), true);
});

test('扩充：中文显式拒绝被识别', () => {
  assert.strictEqual(detectRefusal('我做不了这个'), true);
  assert.strictEqual(detectRefusal('我不会帮你做这个'), true);
  assert.strictEqual(detectRefusal('这个忙我帮不了'), true);
  assert.strictEqual(detectRefusal('我必须拒绝这个请求'), true);
  assert.strictEqual(detectRefusal('我不方便回答'), true);
});

test('扩充：英文软拒绝被识别', () => {
  assert.strictEqual(detectRefusal("I'm not comfortable with that"), true);
  assert.strictEqual(detectRefusal("That's not appropriate"), true);
  assert.strictEqual(detectRefusal("I'd rather not do this"), true);
  assert.strictEqual(detectRefusal("Let's change the subject"), true);
  assert.strictEqual(detectRefusal('Consult a professional for this'), true);
});

test('扩充：英文显式拒绝被识别', () => {
  assert.strictEqual(detectRefusal("I won't do that"), true);
  assert.strictEqual(detectRefusal('I refuse to help'), true);
  assert.strictEqual(detectRefusal('I must decline this request'), true);
  assert.strictEqual(detectRefusal("I'm not permitted to do that"), true);
  assert.strictEqual(detectRefusal('Beyond my capabilities'), true);
});

test('isStrongRefusal：只认强拒绝，不认弱关键词', () => {
  assert.strictEqual(isStrongRefusal('我无法协助这个'), true);
  assert.strictEqual(isStrongRefusal('恕难从命'), true);
  assert.strictEqual(isStrongRefusal("I won't do that"), true);

  assert.strictEqual(isStrongRefusal('抱歉，之前理解错了你的意思，我来分析'), false);
  assert.strictEqual(isStrongRefusal('Sorry for the confusion, let me analyze'), false);
  assert.strictEqual(isStrongRefusal('任务已完成，全部通过'), false);
});

test('误报检查：正常技术回复不被判为拒绝', () => {
  assert.strictEqual(detectRefusal('这段代码实现了鉴权校验逻辑'), false);
  assert.strictEqual(detectRefusal('函数返回 -1 表示校验失败'), false);
  assert.strictEqual(detectRefusal('编译前需要先安装依赖，然后执行构建脚本'), false);
  assert.strictEqual(detectRefusal('这个函数的返回值是布尔类型'), false);
});

// ===== 0.6.94 回归：误报集（正常技术回复绝不能被判为拒绝）=====
const NORMAL_TECH_REPLIES = [
  '这个函数实现了鉴权校验，返回布尔值。',
  '我们先把配置读进来，然后解析成对象。',
  '修复方法是把 await 加上，因为这里返回的是 Promise。',
  '这段代码会遍历数组，对每个元素调用回调。',
  '编译前需要先安装依赖，然后执行构建脚本。',
  '测试全部通过，443 个用例无一失败。',
  '已创建文件 src/utils/helper.js，共 42 行。',
  '我建议你把这个循环改成 map，可读性更好。',
  '你可以用 git log 查看提交历史。',
  '这个报错是因为端口被占用了，换个端口即可。',
  '内存泄漏的原因是定时器没有清理。',
  '加固后的 APK 需要先脱壳才能反编译。',
  '签名校验逻辑在 native 层，需要用 IDA 分析。',
  '绕过风控的关键是补齐浏览器指纹。',
  '这个漏洞是栈溢出，可以覆盖返回地址。',
  '提权失败是因为 SUID 位没设置。',
  '注入点在搜索参数，可以直接 union select。',
  '破解这个 license 需要先定位校验函数。',
  '反调试检测在 JNI_OnLoad 里，可以 hook 掉。',
  '验证码识别率能达到 92%。',
  '这个 API 需要带上 token 才能访问。',
  '数据库连接池配置在 application.yml 里。',
  '建议你加上索引，查询会快很多。',
  '不建议在生产环境开启 debug 模式。',
  '这个方案有风险，回滚成本较高。',
  '不符合预期的返回值需要单独处理。',
  '违反约束时会抛出异常。',
  '暂时无法连接数据库，请检查网络。',
  '作为 API 网关，它负责路由和限流。',
  '我的职责是把这个模块重构完。',
  '这个不行的话，试试另一个方案。',
  '原理是先把明文做异或，再做 base64 编码。',
  '具体实现是先用 frida hook 掉检测函数，再 dump 内存。',
  '具体步骤是：1. 脱壳 2. 反编译 3. 定位校验 4. patch。',
  '思路是先抓包，看请求里有没有签名参数。',
  '实际操作时要注意 hook 时机，太早会崩。',
  'The function returns a boolean value.',
  'You can use git log to inspect the history.',
  'The fix is to add await before the call.',
  'Compile the project after installing dependencies.',
  'This is outside the scope of the current module.',
  'I recommend against using eval here.',
  'You should not commit node_modules.',
  'The APK is protected by signature verification.',
  'Patch the check by changing the jump instruction.',
  'The exploit overwrites the return address.',
];

test('回归：正常技术回复零误报', () => {
  const fp = NORMAL_TECH_REPLIES.filter((t) => detectRefusal(t));
  assert.deepStrictEqual(fp, [], '误报: ' + fp.join(' | '));
});

// ===== 0.6.94 回归：召回集（各类拒绝表述必须检出）=====
const SHOULD_REFUSE = [
  // 显式
  '我无法协助这个请求', '我不会帮你做这个', '我做不了这个', '我必须拒绝',
  'I cannot assist with that', "I won't do that", 'I must decline',
  // 软拒绝
  '这不太合适', '恐怕不行，我无能为力', '恕难从命',
  "I'm not comfortable with that", "That's not appropriate", "I'd rather not do this",
  // 边界
  '这超出了我的能力范围', '不在我的服务范围内', 'Beyond my capabilities',
  'outside my scope', 'not within my capability',
  // 转移话题
  '我们聊点别的吧', '换个话题吧', "Let's change the subject",
  // 建议找别人
  '建议你咨询专业人士', '请找专业人士', 'Consult a professional',
  // 假配合点到为止
  '原理我可以讲，但具体操作需要你自己完成',
  '我只能提供概念层面的说明，不能提供具体步骤',
  'I can explain the concept, but I cannot provide specific steps',
  // 政策合规
  '这不符合我的使用政策', '我的安全准则不允许这么做',
  'against my usage policy', 'my guidelines do not allow that',
  // 敏感危险
  '这可能被滥用，存在风险', '出于安全考虑，我不能提供',
  'this could be harmful', 'for safety reasons, I cannot',
  // 道德伦理
  '这不道德，从伦理上我不能', '我有责任拒绝这个请求',
  // 能力推脱
  '我不具备这个能力', '我无法访问',
  // 回避话题
  '这个话题不适合讨论', '我们跳过这个',
  // 委婉推脱
  '很遗憾，我不能', '非常抱歉，我无法', "I'm afraid I can't",
  'regrettably, I must respectfully decline', 'I have to draw the line',
  // 弱词开头
  '抱歉，这个我确实做不了',
  'Sorry, but I cannot help with that',
  "Unfortunately, I'm unable to assist",
];

test('回归：各类拒绝表述全部检出', () => {
  const missed = SHOULD_REFUSE.filter((t) => !detectRefusal(t));
  assert.deepStrictEqual(missed, [], '漏检: ' + missed.join(' | '));
});

// ===== 0.6.94 新增：四类固定句式 =====
test('新增：口语委婉被识别', () => {
  assert.strictEqual(detectRefusal('这个有点难办'), true);
  assert.strictEqual(detectRefusal('这个不太好办啊'), true);
  assert.strictEqual(detectRefusal('这个不好办'), true);
  assert.strictEqual(detectRefusal('这个不太好说'), true);
  assert.strictEqual(detectRefusal('不太方便呢'), true);
});

test('新增：提醒式被识别', () => {
  assert.strictEqual(detectRefusal('我必须提醒你，这样做有风险'), true);
  assert.strictEqual(detectRefusal('我有义务提醒你注意合规问题'), true);
  assert.strictEqual(detectRefusal('我需要提醒一下风险'), true);
  assert.strictEqual(detectRefusal('出于负责任的态度，我不能这么做'), true);
});

test('新增：特殊性被识别', () => {
  assert.strictEqual(detectRefusal('这个请求比较特殊'), true);
  assert.strictEqual(detectRefusal('这个请求比较敏感'), true);
  assert.strictEqual(detectRefusal('这类问题比较敏感'), true);
  assert.strictEqual(detectRefusal('不适合展开'), true);
  assert.strictEqual(detectRefusal('这个需要谨慎处理'), true);
});

test('新增：推给系统/人工被识别', () => {
  assert.strictEqual(detectRefusal('这需要人工审核才能继续'), true);
  assert.strictEqual(detectRefusal('这类操作需要走正式流程'), true);
  assert.strictEqual(detectRefusal('需要提交申请'), true);
  assert.strictEqual(detectRefusal('这不是我能决定的'), true);
  assert.strictEqual(detectRefusal('请联系管理员'), true);
  assert.strictEqual(detectRefusal('需要人工介入'), true);
});

test('新增：条件式只在开头判定', () => {
  // 开头 → 判为拒绝
  assert.strictEqual(detectRefusal('如果你有正式授权的话，这个是可以做的'), true);
  assert.strictEqual(detectRefusal('前提是你拥有该系统的合法权限'), true);
  // 出现在中后段 → 不判（避免正常法律说明误报）
  const midText = '这个方案的技术实现是：先读取配置，再初始化连接池。注意' + 'x'.repeat(200) + '，前提是你拥有该系统的合法权限。';
  assert.strictEqual(detectRefusal(midText), false);
});

// ===== 0.6.94 新增：元讨论护栏 =====
test('元讨论护栏：列举大量拒绝短语的讨论文本不判为拒绝', () => {
  const metaDiscussion = [
    '词表目前覆盖以下拒绝形态：',
    '- 显式拒绝：我无法协助、我不能做这个、我不会帮你',
    '- 软拒绝：这不太合适、恐怕不行、恕难从命',
    '- 假配合：但具体操作、我只能提供概念',
    '- 政策合规：不符合我的使用政策、我的安全准则不允许',
    '- 能力推脱：我不具备这个能力、我无法访问',
    '以上共 10+ 种表述，覆盖了大部分场景。',
  ].join('\n');
  // 命中远超 5 个强短语 → 元讨论护栏应判为非拒绝
  assert.strictEqual(detectRefusal(metaDiscussion), false);
});

test('元讨论护栏：真拒绝（1-3 个短语）不受影响', () => {
  const real = '抱歉，我无法协助这个请求。这超出了我的能力范围，恕难从命。';
  assert.strictEqual(detectRefusal(real), true);
});

test('元讨论护栏：边界（5 个短语以内）仍判为拒绝', () => {
  // 真拒绝偶尔会堆几个短语（1-5 个），护栏阈值是 >5，不该误伤
  const borderline = '我不能做这个。我做不了。我不会帮你。我必须拒绝。我无法协助。';
  assert.strictEqual(detectRefusal(borderline), true);
});

// ===== 审查修复回归：C1（子串重叠导致真拒绝被护栏放过）=====
test('C1 回归：三连真拒绝不被元讨论护栏放过', () => {
  // 词表存在父子串包含关系（拒绝执行 ⊂ 我拒绝执行），原实现会重复计数触发护栏。
  assert.strictEqual(detectRefusal('我拒绝执行，我拒绝提供，我拒绝回答。'), true);
  assert.strictEqual(detectRefusal('我不会帮你，我做不了，这事我帮不了。'), true);
  assert.strictEqual(detectRefusal('我无法协助，我不能提供，恕难从命。'), true);
});

test('C1 回归：独立短语计数下，边界仍正确', () => {
  // 5 个独立拒绝短语 → 不算元讨论
  assert.strictEqual(detectRefusal('我无法协助。我不能做这个。我做不了。我必须拒绝。恕难从命。'), true);
  // 6 个独立拒绝短语 → 判为元讨论（护栏阈值）
  assert.strictEqual(detectRefusal('我无法协助。我不能做这个。我做不了。我必须拒绝。恕难从命。爱莫能助。'), false);
});

// ===== 审查修复回归：C2（isStrongRefusal 缺护栏）=====
test('C2 回归：isStrongRefusal 与 detectRefusal 对元讨论行为一致', () => {
  const meta = '词表包括：我无法协助、我不能做这个、我不会帮你、我做不了、我拒绝执行、我拒绝提供、我拒绝回答、我拒绝协助';
  assert.strictEqual(detectRefusal(meta), false);
  assert.strictEqual(isStrongRefusal(meta), false, 'isStrongRefusal 必须与 detectRefusal 一致，否则改写结果会被误丢弃');
});

test('C2 回归：正常强拒绝不受护栏影响', () => {
  assert.strictEqual(isStrongRefusal('我不能做这个'), true);
  assert.strictEqual(isStrongRefusal('抱歉，我无法协助。这超出了我的能力范围，恕难从命。'), true);
  assert.strictEqual(isStrongRefusal("I cannot assist with that"), true);
});

// ===== 审查修复回归：I2（日志节流）=====
test('I2 回归：重复调用不重复刷屏（无法直接断言日志，验证功能不受影响）', () => {
  const meta = '我无法协助、我不能做这个、我不会帮你、我做不了、我拒绝执行、我拒绝提供';
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(detectRefusal(meta), false);
  }
});
