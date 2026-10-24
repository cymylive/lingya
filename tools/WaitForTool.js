/**
 * WaitForTool — 轮询等待直到条件满足。
 *
 * 存在意义：AI 经常需要「等外部状态变化」（CI 构建完成、文件生成、服务启动）。
 * 但 AI 惯用 ping -n 300 这种固定时长死等，导致：
 *   - CI 1 分钟跑完，还要白等 4 分钟
 *   - 界面卡在「正在执行 JS 脚本… 4m44s」，看起来像死机
 *
 * 本工具把「轮询 + 超时」封装成一个原子操作，AI 只需描述「检查什么」和「什么算完成」。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const { exec } = require('child_process');
const path = require('path');
const { decodeOutput, normalizeCommand } = require('./decodeOutput');
const { inspectCommand } = require('./readonly-guard');
const { DANGEROUS_CMDS } = require('./dangerous-commands');

const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_TIMEOUT_MS = 600000;
const MIN_INTERVAL_MS = 1000;
const MAX_TIMEOUT_MS = 1800000;
const MAX_OUTPUT_KEEP = 2000;
const NL = String.fromCharCode(10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, workdir, timeoutMs) {
  return new Promise((resolve) => {
    const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
    if (workdir) opts.cwd = workdir;
    exec(command, opts, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({
        stdout: decodeOutput(stdout || ''),
        stderr: decodeOutput(stderr || ''),
        exitCode: code,
      });
    });
  });
}

class WaitForTool extends Tool {
  constructor() {
    super(
      'wait_for',
      '轮询执行命令直到条件满足或超时。用于等待外部状态变化（CI 构建、服务启动、文件生成等），比固定时长等待高效得多。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '每次轮询要执行的检查命令（如 python check_ci.py、ls output.txt）',
          },
          expect: {
            type: 'string',
            description: '判定完成的条件：要出现在输出中的字符串（不区分大小写）；或传 exit0 表示退出码为 0 即完成',
          },
          timeout: {
            type: 'number',
            description: '总超时毫秒数，默认 600000（10 分钟），上限 1800000（30 分钟）',
            default: DEFAULT_TIMEOUT_MS,
          },
          interval: {
            type: 'number',
            description: '每次轮询间隔毫秒数，默认 10000（10 秒），最小 1000',
            default: DEFAULT_INTERVAL_MS,
          },
          description: {
            type: 'string',
            description: '等待目的说明（如「等 CI 打包完成」），用于日志',
          },
          workdir: {
            type: 'string',
            description: '命令工作目录（相对项目根目录），默认项目根目录',
          },
        },
        required: ['command', 'expect'],
        additionalProperties: false,
      },
      'waitFor(command, expect, options?)'
    );
  }

  getPromptSection() {
    const BT = String.fromCharCode(96);
    const F = BT + BT + BT;
    const lines = [];
    lines.push('## 等待外部状态变化（重要）');
    lines.push('');
    lines.push('**禁止用固定时长死等**（如 ' + BT + 'ping -n 300 127.0.0.1 >nul' + BT + '、' + BT + 'timeout /t 300' + BT + '、' + BT + 'sleep 300' + BT + '）。');
    lines.push('外部任务（CI 构建、下载、部署、服务启动）完成时间不确定：');
    lines.push('死等 5 分钟 → 实际 1 分钟就跑完了，白白浪费 4 分钟，界面还卡在「正在执行」看起来像死机。');
    lines.push('');
    lines.push('**正确做法：用 waitFor 轮询**，条件一满足立刻返回。');
    lines.push('');
    lines.push('示例（等 GitHub CI 构建完成）：');
    lines.push(F + 'lingya');
    lines.push('const r = await waitFor(');
    lines.push('  ' + BT + 'gh run view --json status --jq .status' + BT + ',');
    lines.push('  ' + BT + 'completed' + BT + ',');
    lines.push('  { timeout: 600000, interval: 10000, description: ' + BT + '等 CI 打包完成' + BT + ' }');
    lines.push(');');
    lines.push('log(r);');
    lines.push(F);
    lines.push('');
    lines.push('示例（等文件出现）：');
    lines.push(F + 'lingya');
    lines.push('await waitFor(' + BT + 'dir dist\\*.exe 2>nul' + BT + ', ' + BT + '.exe' + BT + ', { timeout: 120000 });');
    lines.push(F);
    lines.push('');
    lines.push('参数说明：');
    lines.push('- ' + BT + 'command' + BT + '：每次轮询执行的检查命令（要轻量，别每次跑重活）');
    lines.push('- ' + BT + 'expect' + BT + '：输出里出现这个字符串就算完成；传 ' + BT + 'exit0' + BT + ' 表示退出码 0 即完成');
    lines.push('- ' + BT + 'timeout' + BT + '：总超时，默认 10 分钟，上限 30 分钟');
    lines.push('- ' + BT + 'interval' + BT + '：轮询间隔，默认 10 秒');
    lines.push('');
    lines.push('返回 ' + BT + '{ matched, attempts, elapsedMs, lastOutput }' + BT + '：matched=false 表示超时未达成条件。');
    return {
      name: 'tool:wait_for',
      order: 106,
      text: lines.join(NL),
    };
  }

  async execute(params) {
    const { command, expect, timeout, interval, description, workdir, projectDir, readonlyShell } = params;

    if (!command || typeof command !== 'string') {
      return ToolResult.error('command 不能为空');
    }
    if (!expect || typeof expect !== 'string') {
      return ToolResult.error('expect 不能为空');
    }

    const trimmed = normalizeCommand(command.trim());
    if (!trimmed) return ToolResult.error('command 不能为空');

    if (DANGEROUS_CMDS.some((p) => p.test(trimmed))) {
      return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
    }
    if (readonlyShell) {
      const guard = inspectCommand(trimmed);
      if (guard.blocked) {
        return ToolResult.error('当前 Agent 模式为只读（Plan），禁止执行写操作：' + guard.reason);
      }
    }

    const totalTimeout = Math.min(
      Math.max(Number(timeout) || DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS
    );
    const pollInterval = Math.min(
      Math.max(Number(interval) || DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
      totalTimeout
    );

    let cwd = workdir;
    if (cwd && !path.isAbsolute(cwd) && projectDir) {
      cwd = path.join(projectDir, cwd);
    } else if (!cwd) {
      cwd = projectDir || undefined;
    }

    const expectLower = expect.toLowerCase();
    const startAt = Date.now();
    const deadline = startAt + totalTimeout;
    let attempts = 0;
    let lastOutput = '';
    let lastExitCode = null;

    console.log('[WaitFor] 开始轮询: ' + (description || trimmed) +
      ' | 期望=' + expect + ' | 超时=' + totalTimeout + 'ms | 间隔=' + pollInterval + 'ms');

    while (Date.now() < deadline) {
      // 【关键】剩余时间太少时不再发起轮询。
      // 否则 exec 会被立即超时杀掉，返回空输出，把前面几轮的有效 lastOutput 覆盖掉，
      // 用户拿到 matched=false + 空 lastOutput，完全看不出任务卡在哪一步。
      const remainBefore = deadline - Date.now();
      if (remainBefore < 500) break;

      attempts++;
      const res = await runCommand(trimmed, cwd, Math.min(30000, remainBefore));
      lastExitCode = res.exitCode;
      // 只在有输出时更新，避免被中途终止的空结果覆盖掉上一次的有效输出
      const combined = (res.stdout + NL + res.stderr).trim();
      if (combined) lastOutput = combined;

      const matched = expectLower === 'exit0'
        ? res.exitCode === 0
        : lastOutput.toLowerCase().includes(expectLower);

      if (matched) {
        const elapsed = Date.now() - startAt;
        console.log('[WaitFor] 第 ' + attempts + ' 次轮询达成条件，耗时 ' + elapsed + 'ms');
        return ToolResult.success({
          matched: true,
          attempts: attempts,
          elapsedMs: elapsed,
          exitCode: lastExitCode,
          lastOutput: lastOutput.slice(-MAX_OUTPUT_KEEP),
        });
      }

      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await sleep(Math.min(pollInterval, remain));
    }

    const elapsed = Date.now() - startAt;
    console.log('[WaitFor] 超时未达成条件，共轮询 ' + attempts + ' 次，耗时 ' + elapsed + 'ms');
    return ToolResult.success({
      matched: false,
      attempts: attempts,
      elapsedMs: elapsed,
      exitCode: lastExitCode,
      lastOutput: lastOutput.slice(-MAX_OUTPUT_KEEP),
      note: '超时 ' + totalTimeout + 'ms 内未满足条件 ' + expect,
    });
  }
}

module.exports = { WaitForTool, DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS, MIN_INTERVAL_MS, MAX_TIMEOUT_MS };
