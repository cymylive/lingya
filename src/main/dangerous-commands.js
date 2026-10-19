/**
 * 危险命令检测（主进程侧入口）
 *
 * 实现已统一到 tools/dangerous-commands.js（单一事实来源）。
 * 本文件仅做 re-export，保持既有 require 路径不变。
 * 由原 main.js 拆分而来，历史原因保留此转发层。
 */
const {
  DANGEROUS_CMDS,
  DANGEROUS_PWSH_CMDS,
  isDangerous,
  isDangerousPwsh,
} = require('../../tools/dangerous-commands');

module.exports = { DANGEROUS_CMDS, DANGEROUS_PWSH_CMDS, isDangerous, isDangerousPwsh };
