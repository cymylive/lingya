const { Tool, ToolResult } = require('./ToolRegistry');
const { execFile } = require('child_process');
const path = require('path');
const { decodeOutput } = require('./decodeOutput');
const activeProcesses = require('./active-processes');
const { inspectCommand } = require('./readonly-guard');

// PowerShell 危险命令列表（额外覆盖 PowerShell 特有危险操作）
const DANGEROUS_PWSH_CMDS = [
  /^rm\s+-rf\s+\//i,
  /^format\s+/i,
  /^del\s+\/f/i,
  /^rd\s+\/s/i,
  /^shutdown\s+/i,
  /^taskkill\s+/i,
  /^diskpart/i,
  /^reg\s+delete/i,
  /^cipher\s+\/w/i,
  /^Stop-Computer\b/i,
  /^Restart-Computer\b/i,
  /^Remove-Item\s+\S*\s*-Recurse\s*-Force\s+C:\\/i,
  /^Clear-Disk\b/i,
];

/**
 * pwsh 执行工具 - 仿照 dsh 的 pwsh 最小移植。
 * 使用 powershell -NoProfile -Command 执行命令。
 * 非零退出正常返回，附 [exit code] 标记；输出纯文本。
 */
class PwshTool extends Tool {
  constructor() {
    super(
      'pwsh',
      '执行 PowerShell 命令（powershell -NoProfile -Command）。非零退出以 [exit code] 标记返回，不视为错误。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 PowerShell 命令'
          },
          description: {
            type: 'string',
            description: '命令用途说明'
          },
          workdir: {
            type: 'string',
            description: '工作目录（相对路径基于项目根目录），默认项目根目录'
          },
          timeoutMs: {
            type: 'number',
            description: '超时毫秒数，默认 30000',
            default: 30000
          }
        },
        required: ['command'],
        additionalProperties: false
      },
      'pwsh(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:pwsh',
      order: 106,
      text: '执行 PowerShell 命令（powershell -NoProfile -Command）并返回 stdout/stderr。每次调用在全新 pwsh 进程中运行：状态不会跨调用保留——请用 workdir 参数而非 cd。路径使用 Windows 原生形式（C:\\...）；用 $env:NAME 读取环境变量。非零退出以 [exit code: N] 标记报告。'
    };
  }

  async execute(params) {
    const { command, description, workdir, timeoutMs, projectDir, readonlyShell } = params;

    try {
      if (!command || typeof command !== 'string') {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      const trimmed = command.trim();
      if (!trimmed) {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      // 危险命令检查
      if (DANGEROUS_PWSH_CMDS.some((p) => p.test(trimmed))) {
        return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
      }

      // Plan 模式只读守卫：拦截写操作
      if (readonlyShell) {
        const guard = inspectCommand(trimmed);
        if (guard.write) {
          return ToolResult.error(
            '当前 Agent 模式为只读（Plan），禁止执行写操作：' + guard.reason +
            '。请改用只读命令探索代码，或在回复中输出实现计划。'
          );
        }
      }

      // 确定工作目录
      let workDir;
      if (workdir) {
        const normalized = workdir.replace(/\//g, path.sep);
        workDir = path.isAbsolute(normalized)
          ? normalized
          : (projectDir ? path.join(projectDir, normalized) : path.resolve(normalized));
      } else if (projectDir) {
        workDir = projectDir;
      } else {
        workDir = process.env.USERPROFILE || process.env.HOME || 'C:\\';
      }

      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000;

      console.log('[PwshTool] 执行命令: ' + trimmed + ', cwd=' + workDir);

      return await new Promise((resolve) => {
        const child = execFile(
          'powershell',
          ['-NoProfile', '-Command', trimmed],
          { cwd: workDir, timeout, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'buffer' },
          (error, stdout, stderr) => {
            activeProcesses.unregister(child);
            const out = decodeOutput(stdout);
            const err = decodeOutput(stderr);

            // dsh 风格渲染
            let body = out;
            if (err && err.length > 0) {
              if (body.length > 0 && !body.endsWith('\n')) body += '\n';
              body += '[stderr]\n' + err;
            }
            if (body.length === 0) body = '(no output)';

            const markers = [];
            if (error) {
              if (error.killed) {
                markers.push('[timed out after ' + timeout + 'ms]');
              } else if (typeof error.code === 'number') {
                markers.push('[exit code: ' + error.code + ']');
              } else {
                markers.push('[exit code: 1]');
              }
            }

            if (markers.length > 0) {
              if (!body.endsWith('\n')) body += '\n';
              body += markers.join('\n');
            }

            resolve(ToolResult.success(body));
          }
        );
        activeProcesses.register(child);
      });
    } catch (err) {
      return ToolResult.error('命令执行异常: ' + err.message);
    }
  }
}

module.exports = { PwshTool, DANGEROUS_PWSH_CMDS };
