/**
 * 危险命令检测（单一事实来源）
 *
 * 历史上这里被复制成了三份（tools/BashTool.js、tools/PwshTool.js、
 * src/main/dangerous-commands.js），且都是 ^ 锚定匹配 —— 只能拦住
 * "以危险命令开头" 的输入，`cd /tmp && rm -rf /` 这类复合命令直接放行。
 *
 * 现在统一到本模块，三处改为 re-export，并把锚定改为词边界匹配。
 * 注意：这是「防手滑」的启发式黑名单，不是对抗性沙箱；真正的边界是
 * Agent 模式（Plan 只读）与用户的显式授权。
 */

// bash / cmd 通用危险命令
const DANGEROUS_CMDS = [
  // 递归删除根目录 / 用户目录（允许出现在复合命令中，如 "cd x && rm -rf /"）
  /(^|[\s;&|(])rm\s+(-[a-zA-Z]*\s+)*-rf\s+(-[a-zA-Z]*\s+)*[/~]/i,
  /(^|[\s;&|(])rm\s+(-[a-zA-Z]*\s+)*-fr\s+(-[a-zA-Z]*\s+)*[/~]/i,
  // 格式化磁盘
  /\bformat\s+[a-zA-Z]:/i,
  // 强删文件
  /\bdel\s+\/f\b/i,
  // 递归删除目录
  /\brd\s+\/s\b/i,
  // 关机 / 重启
  /\bshutdown\s+\//i,
  // 杀进程
  /\btaskkill\s+\//i,
  // 磁盘分区工具
  /\bdiskpart\b/i,
  // 注册表删除
  /\breg\s+delete\b/i,
  // 覆写磁盘空闲空间
  /\bcipher\s+\/w\b/i,
];

// PowerShell 专属额外规则
const PWSH_ONLY_CMDS = [
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
  /\bRemove-Item\b[^|;&]*-Recurse\b[^|;&]*-Force\b[^|;&]*[a-zA-Z]:\\?\s*$/i,
  /\bClear-Disk\b/i,
];

// PowerShell 完整规则集（通用 + 专属）
const DANGEROUS_PWSH_CMDS = DANGEROUS_CMDS.concat(PWSH_ONLY_CMDS);

function isDangerous(cmd) {
  const s = String(cmd == null ? '' : cmd).trim();
  if (!s) return false;
  return DANGEROUS_CMDS.some((pattern) => pattern.test(s));
}

function isDangerousPwsh(cmd) {
  const s = String(cmd == null ? '' : cmd).trim();
  if (!s) return false;
  return DANGEROUS_PWSH_CMDS.some((pattern) => pattern.test(s));
}

module.exports = { DANGEROUS_CMDS, DANGEROUS_PWSH_CMDS, PWSH_ONLY_CMDS, isDangerous, isDangerousPwsh };
