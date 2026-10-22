/**
 * 后台任务工具 - 启动长时间运行的命令（编译、装依赖、起服务、爬虫、fuzz 等），
 * 立即返回任务 ID，不阻塞脚本；随后可查询输出、等待完成或终止。
 *
 * 与 bash 的区别：bash 同步等待（默认 30s 超时），后台任务持续运行直到结束或被 kill。
 * 后台进程注册到 active-processes，用户点「停止」会一并终止。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const activeProcesses = require('./active-processes');
const { DANGEROUS_CMDS } = require('./BashTool');
const { inspectCommand } = require('./readonly-guard');

const MAX_TASKS = 50;              // 任务表上限，超出时丢弃最旧的已完成任务
const MAX_STORED_OUTPUT = 100000;  // 单任务累计输出上限（保留尾部）
const MAX_RETURNED_OUTPUT = 30000; // 单次返回给模型的输出上限
// bashOutput 单次 wait 上限。
//
// 【为什么从 10 分钟降到 2 分钟】
//   processInterceptedResponse 走串行队列（intercept-observer 的 processingChain），
//   一次 10 分钟的等待会堵死整个窗口的回复处理链 ——
//   期间 AI 输出的所有 lingya 代码块都排队不执行，UI 也完全无反馈，
//   看起来就像「LingYa 没拦截到代码块」。
//   降到 2 分钟后，AI 按提示词多次轮询（每次都会刷新 UI 状态），
//   用户能持续看到进度，队列也不会被长时间独占。
const MAX_WAIT_MS = 120000;         // bashOutput 单次 wait 上限（2 分钟，避免阻塞串行队列）

const tasks = new Map();

function resolveDir(dir, projectDir) {
  if (!dir) return projectDir || process.env.USERPROFILE || process.cwd();
  const normalized = String(dir).replace(/\//g, path.sep);
  if (path.isAbsolute(normalized)) return normalized;
  return projectDir ? path.join(projectDir, normalized) : path.resolve(normalized);
}

function appendOutput(task, chunk) {
  task.output += chunk;
  if (task.output.length > MAX_STORED_OUTPUT) {
    task.output = '...[早期输出已丢弃]...\n' + task.output.slice(-MAX_STORED_OUTPUT);
  }
}

function pruneTasks() {
  if (tasks.size <= MAX_TASKS) return;
  const done = [...tasks.values()].filter((t) => t.done).sort((a, b) => a.startTime - b.startTime);
  for (const t of done) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(t.id);
  }
}

function startBackground(command, options) {
  const opts = options || {};
  const id = 'bg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const cwd = resolveDir(opts.workdir || opts.cwd, opts.projectDir);

  const child = spawn(command, { cwd, shell: true, windowsHide: true });
  const task = {
    id, command, cwd, child,
    output: '', done: false, exitCode: null,
    startTime: Date.now(), endTime: null,
    donePromise: null, resolveDone: null,
  };
  task.donePromise = new Promise((resolve) => { task.resolveDone = resolve; });
  tasks.set(id, task);
  activeProcesses.register(child, opts.profileId);

  child.stdout.on('data', (d) => appendOutput(task, d.toString()));
  child.stderr.on('data', (d) => appendOutput(task, d.toString()));
  child.on('error', (err) => appendOutput(task, '\n[启动错误] ' + err.message));
  child.on('close', (code) => {
    task.done = true;
    task.exitCode = code;
    task.endTime = Date.now();
    activeProcesses.unregister(child);
    if (task.resolveDone) task.resolveDone();
    pruneTasks();
  });

  return { taskId: id, pid: child.pid, cwd };
}

async function waitForDone(task, ms, profileId) {
  if (task.done) return true;
  // 可中断轮询：每 500ms 检查一次，任务完成或用户点「停止」都立即返回，
  // 不必等满整个 ms（否则用户点停止后最长要等 10 分钟才响应）。
  //
  // 【必须传 profileId】不传时 isAborted() 退化为「任一 key 被标记就返回 true」，
  // 导致 A 窗口点停止后，B 窗口的后台任务轮询被瞬间打断 —— 多窗口串扰。
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (task.done) return true;
    if (activeProcesses.isAborted(profileId)) return task.done;
    await new Promise((r) => setTimeout(r, 500));
  }
  return task.done;
}

function killTask(task) {
  const child = task.child;
  if (!child || task.done) return false;
  try {
    if (process.platform === 'win32' && child.pid) {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
        { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } else {
      child.kill('SIGKILL');
    }
    return true;
  } catch (_) {
    try { child.kill('SIGKILL'); return true; } catch (_) { return false; }
  }
}

function formatTask(task) {
  const status = task.done ? ('已完成 (退出码 ' + task.exitCode + ')') : '运行中';
  const elapsed = Math.round(((task.endTime || Date.now()) - task.startTime) / 1000);
  const lines = [
    '任务 ' + task.id + ' [' + status + ']',
    '命令: ' + task.command,
    '工作目录: ' + task.cwd,
    '运行时长: ' + elapsed + 's',
    '输出:',
  ];
  let out = task.output || '(暂无输出)';
  if (out.length > MAX_RETURNED_OUTPUT) {
    out = '...[输出过长，仅保留尾部]...\n' + out.slice(-MAX_RETURNED_OUTPUT);
  }
  lines.push(out);
  return lines.join('\n');
}

class BashBackgroundTool extends Tool {
  constructor() {
    super(
      'bash_background',
      '在后台启动一个命令（编译、装依赖、起服务、爬虫、fuzz 等长时间任务），立即返回任务 ID，不阻塞。用 bashOutput(taskId) 查看输出，bashKill(taskId) 终止。',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          description: { type: 'string', description: '命令用途说明' },
          workdir: { type: 'string', description: '工作目录（相对路径基于项目根目录），默认项目根目录' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      'bashBackground(command, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:bash_background',
      order: 106,
      text: [
        '## 后台任务',
        '',
        '长时间运行的命令（编译、装依赖、起服务、爬虫、fuzz 等）用 bashBackground(command, options?) 在后台启动，立即返回任务 ID，不阻塞当前脚本。',
        '',
        '- 查看输出/状态：bashOutput(taskId)（可传 { wait: 毫秒 } 等待完成，上限 600000）',
        '- 终止任务：bashKill(taskId)',
        '',
        '典型用法：先 bashBackground("npm run dev") 起服务，再 bashOutput(id, { wait: 3000 }) 确认已监听端口，跑测试，最后 bashKill(id) 收尾。',
        '短命令仍用 bash（同步、有 30s 超时）。',
      ].join('\n'),
    };
  }

  async execute(params) {
    const { command, workdir, projectDir, readonlyShell } = params;
    if (!command || typeof command !== 'string') {
      return ToolResult.error('invalid command: expected a non-empty string');
    }
    const trimmed = command.trim();
    if (!trimmed) return ToolResult.error('invalid command: expected a non-empty string');
    if (DANGEROUS_CMDS.some((p) => p.test(trimmed))) {
      return ToolResult.error('命令被安全策略拒绝（危险命令）: ' + trimmed);
    }
    if (readonlyShell) {
      const guard = inspectCommand(trimmed);
      if (guard.write) {
        return ToolResult.error('当前 Agent 模式为只读（Plan），禁止执行写操作：' + guard.reason);
      }
    }
    try {
      const info = startBackground(trimmed, { workdir, projectDir, profileId: params && params.profileId });
      console.log('[BashBackgroundTool] 已启动后台任务 ' + info.taskId + ': ' + trimmed);
      return ToolResult.success(
        '后台任务已启动\n任务 ID: ' + info.taskId + '\nPID: ' + info.pid + '\n工作目录: ' + info.cwd +
        '\n查看输出: bashOutput("' + info.taskId + '")；终止: bashKill("' + info.taskId + '")'
      );
    } catch (err) {
      return ToolResult.error('启动后台任务失败: ' + err.message);
    }
  }
}

class BashOutputTool extends Tool {
  constructor() {
    super(
      'bash_output',
      '查看后台任务的输出与状态。可传 wait（毫秒）等待任务完成，上限 600000。',
      {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台任务 ID（bashBackground 返回）' },
          wait: { type: 'number', description: '最多等待多少毫秒让任务完成（可选，上限 600000）' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      'bashOutput(taskId, options?)'
    );
  }

  async execute(params) {
    // profileId 由 JsRunner / ipc 注入，标识发起窗口。
    // 必须传给 waitForDone —— 否则 isAborted() 无参调用会把「任一窗口点停止」
    // 当成全局中止，导致其它窗口的后台任务轮询被瞬间打断（多窗口串扰）。
    const { task_id, wait, profileId } = params;
    if (!task_id || typeof task_id !== 'string') return ToolResult.error('task_id 不能为空');
    const task = tasks.get(task_id);
    if (!task) return ToolResult.error('后台任务不存在: ' + task_id);
    const waitMs = typeof wait === 'number' && wait > 0 ? Math.min(wait, MAX_WAIT_MS) : 0;
    if (waitMs > 0 && !task.done) await waitForDone(task, waitMs, profileId);
    let text = formatTask(task);
    // 等待结束但任务仍在运行：明确提示模型继续轮询，避免其误以为无法再等而停下
    if (!task.done) {
      text += String.fromCharCode(10) + String.fromCharCode(10) +
        '[任务仍在运行，未在 ' + Math.round(waitMs / 1000) + 's 内结束。请再次调用 bashOutput("' +
        task_id + '", { wait: ' + MAX_WAIT_MS + ' }) 继续等待（单次最长 ' +
        Math.round(MAX_WAIT_MS / 60000) + ' 分钟），直到任务完成；' +
        '不要只查询一次就停下，也不要试图一次等很久（会阻塞后续处理）。' +
        '若任务本身耗时很长，请多次调用本工具持续监测，每次都会刷新进度。]';
    }
    return ToolResult.success(text);
  }
}

class BashKillTool extends Tool {
  constructor() {
    super(
      'bash_kill',
      '终止一个后台任务（含其子进程树）。',
      {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台任务 ID' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      'bashKill(taskId)'
    );
  }

  async execute(params) {
    const { task_id } = params;
    if (!task_id || typeof task_id !== 'string') return ToolResult.error('task_id 不能为空');
    const task = tasks.get(task_id);
    if (!task) return ToolResult.error('后台任务不存在: ' + task_id);
    if (task.done) return ToolResult.success('任务 ' + task_id + ' 已结束（退出码 ' + task.exitCode + '），无需终止');
    const ok = killTask(task);
    return ok
      ? ToolResult.success('已终止任务 ' + task_id)
      : ToolResult.error('终止任务失败: ' + task_id);
  }
}

module.exports = { BashBackgroundTool, BashOutputTool, BashKillTool };
