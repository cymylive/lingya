/**
 * 记忆出口脱敏规则
 *
 * 目的：判断一条记忆是否允许"发往网页端"。
 * 不改变存储，不影响本地检索，只决定「能不能外发」。
 *
 * 设计见 docs/2026-10-28-memory-redaction-design.md
 *
 * 【判定原则】看主题，不看关键词。
 * 只拦「研究如何对抗平台 / 规避封号 / 伪装成人」这类敌意主题。
 * 业务性逆向（百度文库上传、字节接口、番茄发布）属正常开发，不拦。
 */

/** 每条规则的 test 只看 name（主题），不看 content，避免正文提及即误伤 */
const DEFAULT_RULES = [
  {
    id: 'ban-analysis',
    desc: '封号原因分析（研究为什么被封）',
    test: (name) => /封号|封禁|被封/.test(name) && /真因|根因|原因|排查/.test(name),
  },
  {
    id: 'anti-detection',
    desc: '规避平台检测 / 风控对抗',
    test: (name) => /规避.*(检测|风控)|(检测|风控).*规避|对抗.*风控|绕过.*风控/.test(name),
  },
  {
    id: 'human-mimic',
    desc: '模拟真人 / 去机器标记 / 行为指纹',
    test: (name) => /模拟真人|去机器标记|行为指纹|bot\s*指纹/i.test(name),
  },
  {
    id: 'inject-stealth',
    desc: '注入隐蔽性加固',
    test: (name) => /注入隐蔽|toString\s*伪装|Symbol\s*幂等/.test(name),
  },
  {
    id: 'deepseek-attack',
    desc: '针对 DeepSeek 本平台的协议逆向/接口破解',
    test: (name) => /DeepSeek/.test(name) && /逆向|破解|协议/.test(name),
  },
];

/**
 * 判断一条记忆是否敏感（不允许外发）。
 * @param {{sensitive?: boolean, name?: string, content?: string}} memory
 * @returns {boolean}
 */
function isSensitive(memory) {
  if (!memory) return false;
  // 人工显式标记优先
  if (memory.sensitive === true) return true;
  const name = String(memory.name || '');
  if (!name.trim()) return false;
  return DEFAULT_RULES.some((r) => r.test(name));
}

module.exports = { DEFAULT_RULES, isSensitive };
