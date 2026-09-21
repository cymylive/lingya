/**
 * 危险命令检测
 * 由原 main.js 拆分而来，逻辑保持不变。
 */

// 危险命令列表 —— 匹配到的命令会额外警告
const DANGEROUS_CMDS = [
  /^rm\s+-rf\s+\//i,
  /^format\s+/i,
  /^del\s+\/f/i,
  /^rd\s+\/s/i,
  /^shutdown\s+/i,
  /^taskkill\s+/i,
  /^diskpart/i,
  /^reg\s+delete/i,
  /^cipher\s+\/w/i,
];

function isDangerous(cmd) {
  return DANGEROUS_CMDS.some((pattern) => pattern.test(cmd.trim()));
}

module.exports = { DANGEROUS_CMDS, isDangerous };
