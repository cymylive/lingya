/**
 * 命令输出智能解码
 * 中文 Windows 上控制台默认代码页是 GBK（cp936），而 Node 的 exec 默认按 UTF-8 解码，
 * 导致 PowerShell/cmd 输出的中文变成 "�"。
 * 策略：先按 UTF-8 解码；若出现替换符（U+FFFD），说明字节流不是合法 UTF-8，
 * 回退按 GBK 解码。
 * @param {Buffer} buf - exec 输出的原始字节
 * @returns {string} 解码后的文本
 */
function decodeOutput(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (utf8.includes('\uFFFD')) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (!gbk.includes('\uFFFD')) return gbk;
    } catch (e) {
      // TextDecoder 不支持 gbk 的环境，退回 UTF-8 结果
    }
  }
  return utf8;
}

/**
 * 修正 AI 生成的 PowerShell 命令的编码问题：
 * Windows PowerShell 5.1 的 Get-Content 默认按 GBK（ANSI）读取文件，导致 UTF-8 文件中文乱码
 * （表现为"绛夊緟鏂"这类字符）。若命令调用 powershell/pwsh 且包含 Get-Content，
 * 自动注入 -Encoding UTF8（已带 -Encoding 的命令不动）。
 * @param {string} command - 原始命令
 * @returns {string} 修正后的命令
 */
function normalizeCommand(command) {
  if (typeof command !== 'string' || !command) return command;
  const trimmed = command.trim();
  // 仅处理 powershell / pwsh 调用
  if (!/^(powershell|pwsh)(\.exe)?(\s|$)/i.test(trimmed)) return command;
  if (!trimmed.includes('Get-Content')) return command;
  // 已显式指定编码的命令不动
  if (/-Encoding\s+/i.test(trimmed)) return command;
  return command.replace(/Get-Content\b/g, 'Get-Content -Encoding UTF8');
}

module.exports = { decodeOutput, normalizeCommand };
