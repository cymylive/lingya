/**
 * Plan 模式只读守卫（方案 B）
 * 检测 shell / PowerShell 命令中的「写操作」，用于在只读 Agent 模式下拦截。
 *
 * 设计目标：
 *   - 放行：纯读取类命令（cat / ls / dir / type / grep / find / git status / git log ...）
 *   - 拦截：文件增删改（含重定向写文件）、包安装、git 写操作、编辑器等
 *
 * 注意：这是启发式检测，用于防止 AI「意外」在规划模式改文件，不追求对抗性绕过防护。
 */

// 输出重定向：区分文件写入与 fd 合并 / null 设备
function hasFileRedirection(cmd) {
  const re = />/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    // cmd 中 ^> 是转义的 >，视为字面量（非重定向）
    if (m.index > 0 && cmd[m.index - 1] === '^') continue;
    const after = cmd.slice(m.index + 1).trimStart();
    // >&2 / >&1 属于 fd 合并，非文件写入
    if (after.startsWith('&')) continue;
    const target = after.match(/^[^\s|;&<>]+/);
    if (!target) continue;
    const t = target[0].toLowerCase();
    if (t === 'nul' || t === '/dev/null') continue;
    return true;
  }
  return false;
}

// 写命令模式（保留 \b 边界，避免误伤如 grep 中的子串）
const WRITE_PATTERNS = [
  // —— Unix 文件/目录变更 ——
  /(^|[|;&]\s*|\bsudo\s+)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|dd|truncate|tee)\b/i,
  /(^|[|;&]\s*)\bsed\b[^|;&]*\s-i\b/i,      // sed -i（原地修改）
  /(^|[|;&]\s*)\bsort\b[^|;&]*\s-o\s/i,     // sort -o 写文件
  // —— Windows cmd 文件/目录变更 ——
  /(^|[|;&]\s*)(del|erase|rd|rmdir|md|mkdir|move|copy|xcopy|robocopy|ren|rename|attrib|icacls|takeown)\b/i,
  // —— PowerShell 写 cmdlet ——
  /\b(Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Item|Clear-Item|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|Rename-ItemProperty)\b/i,
  // —— git 写操作 ——
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|rm|mv|clean|apply|cherry-pick|revert|tag|init|clone|fetch)\b/i,
  // —— 包管理器（改动依赖树）——
  /\b(npm|yarn|pnpm)\s+(install|i|add|remove|uninstall|update|upgrade|ci|link|unlink)\b/i,
  /\b(pip|pip3)\s+(install|uninstall)\b/i,
  // —— 交互式编辑器 ——
  /(^|[|;&]\s*)(vi|vim|nano|emacs|notepad)\b/i,
];

/**
 * 判断命令是否包含写操作
 * @param {string} command
 * @returns {{write: boolean, reason?: string}}
 */
function inspectCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { write: false };
  }
  const cmd = command.trim();

  if (hasFileRedirection(cmd)) {
    return { write: true, reason: '输出重定向写文件（> / >>）' };
  }
  for (const p of WRITE_PATTERNS) {
    const m = cmd.match(p);
    if (m) {
      return { write: true, reason: '包含写操作: ' + (m[0].trim().slice(0, 40)) };
    }
  }
  return { write: false };
}

/** 便捷判定：是否为写命令 */
function isWriteCommand(command) {
  return inspectCommand(command).write;
}

module.exports = { inspectCommand, isWriteCommand, hasFileRedirection };
