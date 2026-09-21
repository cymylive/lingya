const { Tool, ToolResult } = require('./ToolRegistry');
const { exec } = require('child_process');
const path = require('path');
const { decodeOutput, normalizeCommand } = require('./decodeOutput');
const activeProcesses = require('./active-processes');

// 危险命令列表（保持不变）
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

/**
 * Bash 执行工具 - 最小移植 dsh 风格。
 * 非零退出正常返回，附 [exit code] 标记；输出纯文本。
 */
class BashTool extends Tool {
  constructor() {
    super(
      'bash', '执行 bash 命令。非零退出以 [exit code] 标记返回，不视为错误。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令'
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
      'bash(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:bash',
      order: 105,
      text: '执行 bash 命令并返回 stdout/stderr。每次调用在全新 shell 中运行：状态（cwd、变量、函数）不会跨调用保留——请用 workdir 参数而非 cd。非零退出以 [exit code: N] 标记报告。长输出会截断为尾部。'
    };
  }

  async execute(params) {
    const { command, description, workdir, timeoutMs, projectDir } = params;

    try {
      if (!command || typeof command !== 'string') {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      const trimmed = normalizeCommand(command.trim());
      if (!trimmed) {
        return ToolResult.error('invalid command: expected a non-empty string');
      }

      // 危险命令检查
      if (DANGEROUS_CMDS.some((p) => p.test(trimmed))) {
        return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
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

      console.log('[BashTool] 执行命令: ' + trimmed + ', cwd=' + workDir);

      return await new Promise((resolve) => {
        const child = exec(
          trimmed,
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

module.exports = { BashTool, DANGEROUS_CMDS };
