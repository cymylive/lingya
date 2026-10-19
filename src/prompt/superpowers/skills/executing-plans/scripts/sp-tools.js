#!/usr/bin/env node
/**
 * Superpowers 工作区工具（跨平台 Node 实现）
 *
 * 为什么重写：
 *   原始版本是 5 个 bash 脚本，依赖 Unix 工具链（awk/sed/grep/wc）。
 *   LingYa 在 Windows 上跑，bash 工具走 cmd.exe，机器上不一定装了 Git Bash。
 *   用 Node 重写后只需要 node（LingYa 自带运行时），全平台可用。
 *
 * 子命令：
 *   node sp-tools.js workspace <plan>                  输出本 plan 的 workspace 目录
 *   node sp-tools.js brief <plan> <taskNo> [outfile]   抽取 Task N 段落写文件，输出路径
 *   node sp-tools.js start <plan> <taskNo>             输出 brief 路径 + BASE SHA
 *   node sp-tools.js done <plan> <taskNo> <base> -- <cmd...>  跑测试并记账
 *   node sp-tools.js review <plan> <base> <head> [outfile]    生成 review diff 包
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

/** 跑 git 命令，返回 trim 后的 stdout */
function git(args, cwd) {
  return execSync('git ' + args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],  // 捕获 stderr，避免泄漏到控制台
  }).trim();
}

/**
 * 仓库根目录。非 git 仓库时降级为 process.cwd()。
 * 原因：用户的开发目录未必是 git 仓库（也可能还没 init）。
 * 整套流程在非 git 环境下仍可运行，只是 workspace 放在当前目录下、
 * review/task-done 的 commit 相关输出会提示不可用。
 */
let _isGitRepo = null;
function isGitRepo() {
  if (_isGitRepo !== null) return _isGitRepo;
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    _isGitRepo = true;
  } catch (_) {
    _isGitRepo = false;
  }
  return _isGitRepo;
}

function repoRoot() {
  if (!isGitRepo()) return process.cwd();
  return git('rev-parse --show-toplevel');
}

/**
 * 计算本 plan 的 workspace 目录。
 * 规则与原始 bash 版一致：
 *   - 目录名 = <plan 基名去 .md>
 *   - 已存在且 plan-path 标记指向别的 plan → 加父目录名后缀避让
 *   - 仍是别人的 → 继续加数字后缀
 */
function resolveWorkspace(planFile) {
  if (!planFile) { console.error('缺少 plan 文件参数'); process.exit(2); }
  const planAbs = path.resolve(planFile);
  if (!fs.existsSync(planAbs)) { console.error('plan 文件不存在: ' + planFile); process.exit(2); }

  const root = repoRoot();
  const base = path.join(root, '.superpowers', 'sdd');

  const slug = path.basename(planAbs, '.md');
  if (!slug || slug === '.' || slug === '..') {
    console.error('无法从路径推导 workspace 名: ' + planFile);
    process.exit(2);
  }

  // plan 的标识：在仓库内用相对路径，否则用绝对路径
  const rel = path.relative(root, planAbs);
  const planId = (!rel.startsWith('..') && !path.isAbsolute(rel))
    ? rel.split(path.sep).join('/')
    : planAbs;

  /** 判断目录是否属于本 plan；不属于则返回 false，属于（或新建）返回 true */
  function owns(dir) {
    const marker = path.join(dir, 'plan-path');
    if (fs.existsSync(marker)) {
      return fs.readFileSync(marker, 'utf-8').trim() === planId;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, planId + '\n', 'utf-8');
    return true;
  }

  let dir = path.join(base, slug);
  if (!owns(dir)) {
    const parent = path.basename(path.dirname(planAbs));
    dir = path.join(base, slug + '-' + parent);
    if (!owns(dir)) {
      let n = 2;
      while (!owns(path.join(base, slug + '-' + parent + '-' + n))) n++;
      dir = path.join(base, slug + '-' + parent + '-' + n);
    }
  }

  // .gitignore 只创建不覆盖（仓库可能自己维护）
  const gi = path.join(base, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n', 'utf-8');

  return dir;
}

/**
 * 从 plan 里抽取 "Task N" 段落。
 * 跳过代码围栏内的标题（与 bash 版 awk 逻辑一致）。
 */
function extractTask(planFile, taskNo) {
  const text = fs.readFileSync(planFile, 'utf-8');
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let inTask = false;
  const startRe = new RegExp('^#+[ \\t]+Task[ \\t]+' + taskNo + '([^0-9]|$)');
  const anyTaskRe = /^#+[ 	]+Task[ 	]+[0-9]+/;

  for (const line of lines) {
    if (/^```/.test(line)) { inFence = !inFence; }
    if (!inFence && anyTaskRe.test(line)) {
      inTask = startRe.test(line);
    }
    if (inTask) out.push(line);
  }
  return out.join('\n');
}

/** 子命令：workspace */
function cmdWorkspace(argv) {
  console.log(resolveWorkspace(argv[0]));
}

/** 子命令：brief */
function cmdBrief(argv) {
  const [plan, nStr, outfile] = argv;
  const n = Number(nStr);
  if (!plan || !Number.isInteger(n)) { console.error('用法: brief <plan> <taskNo> [outfile]'); process.exit(2); }
  const dir = resolveWorkspace(plan);
  const out = outfile || path.join(dir, 'task-' + n + '-brief.md');
  const body = extractTask(path.resolve(plan), n);
  if (!body.trim()) {
    console.error('task ' + n + ' not found in ' + plan + ' (no heading matching \'Task ' + n + '\')');
    process.exit(3);
  }
  fs.writeFileSync(out, body + '\n', 'utf-8');
  const lineCount = body.split('\n').length;
  console.log('wrote ' + out + ': ' + lineCount + ' lines');
}

/** 子命令：start */
function cmdStart(argv) {
  const [plan, nStr] = argv;
  const n = Number(nStr);
  if (!plan || !Number.isInteger(n)) { console.error('用法: start <plan> <taskNo>'); process.exit(2); }
  const dir = resolveWorkspace(plan);
  const briefPath = path.join(dir, 'task-' + n + '-brief.md');
  const body = extractTask(path.resolve(plan), n);
  if (!body.trim()) {
    console.error('task ' + n + ' not found in ' + plan);
    process.exit(3);
  }
  fs.writeFileSync(briefPath, body + '\n', 'utf-8');
  console.log('brief: ' + briefPath);
  if (isGitRepo()) {
    console.log('base: ' + git('rev-parse HEAD'));
  } else {
    console.log('base: (no-git)');
  }
}

/** 子命令：done —— 跑测试，成功才记账 */
function cmdDone(argv) {
  const sep = argv.indexOf('--');
  if (sep < 3) { console.error('用法: done <plan> <taskNo> <base> -- <cmd...>'); process.exit(2); }
  const [plan, nStr, base] = argv.slice(0, 3);
  const cmdArgs = argv.slice(sep + 1);
  const n = Number(nStr);
  if (!plan || !Number.isInteger(n) || !base || cmdArgs.length === 0) {
    console.error('用法: done <plan> <taskNo> <base> -- <cmd...>');
    process.exit(2);
  }

  // 校验 base 是有效 commit（非 git 仓库跳过）
  const hasGit = isGitRepo();
  if (hasGit && base !== '(no-git)') {
    try { git('rev-parse --verify --quiet ' + base); }
    catch (_) { console.error('bad BASE: ' + base); process.exit(2); }
  }

  const dir = resolveWorkspace(plan);
  const log = path.join(dir, 'task-' + n + '-tests.log');
  const ledger = path.join(dir, 'progress.md');

  // 执行测试命令。
  // 用 shell 才能支持 "npm test" 这类带子命令的写法；
  // 为规避 shell+args 的安全告警，把整个命令拼成一个字符串传进去。
  const fullCmd = cmdArgs.join(' ');
  const r = spawnSync(fullCmd, {
    encoding: 'utf-8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(log, output, 'utf-8');

  // 打印尾部 5 行
  const tail = output.trim().split(/\r?\n/).slice(-5).join('\n');
  console.log(tail);

  if (r.status !== 0) {
    console.error('task-done: 测试命令退出码 ' + r.status + '；Task ' + n + ' 未记录（完整输出: ' + log + '）');
    process.exit(r.status || 1);
  }

  // 取最后一行非空输出
  const nonEmpty = output.trim().split(/\r?\n/).filter(l => l.trim());
  const last = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : '(no output)';

  if (!fs.existsSync(ledger)) {
    fs.writeFileSync(ledger, '# SDD ledger — plan: ' + plan + '\n', 'utf-8');
  }
  const cmdText = cmdArgs.join(' ');
  let line;
  if (hasGit && base !== '(no-git)') {
    const baseShort = git('rev-parse --short=7 ' + base);
    const headShort = git('rev-parse --short=7 HEAD');
    line = 'Task ' + n + ': complete (commits ' + baseShort + '..' + headShort +
      ', tests: ' + cmdText + ' → ' + last + ')';
  } else {
    line = 'Task ' + n + ': complete (no-git, tests: ' + cmdText + ' → ' + last + ')';
  }
  fs.appendFileSync(ledger, line + '\n', 'utf-8');
  console.log('ledger: ' + line);
}

/** 子命令：review */
function cmdReview(argv) {
  const [plan, base, head, outfile] = argv;
  if (!plan || !base || !head) { console.error('用法: review <plan> <base> <head> [outfile]'); process.exit(2); }
  if (!fs.existsSync(path.resolve(plan))) { console.error('plan 文件不存在: ' + plan); process.exit(2); }
  if (!isGitRepo()) {
    console.error('review 需要 git 仓库：当前目录不是 git 仓库，无法生成 diff。');
    console.error('请先 git init，或跳过此步骤改为人工审查。');
    process.exit(4);
  }

  try { git('rev-parse --verify --quiet ' + base); }
  catch (_) { console.error('bad BASE: ' + base); process.exit(2); }
  try { git('rev-parse --verify --quiet ' + head); }
  catch (_) { console.error('bad HEAD: ' + head); process.exit(2); }

  // 范围校验：HEAD 必须是 BASE 的后代，且范围非空
  try { git('merge-base --is-ancestor ' + base + ' ' + head); }
  catch (_) { console.error('HEAD 不是 BASE 的后代: ' + base + '..' + head); process.exit(3); }

  const count = Number(git('rev-list --count ' + base + '..' + head));
  if (!(count > 0)) { console.error('提交范围为空: ' + base + '..' + head); process.exit(3); }

  let out = outfile;
  if (!out) {
    const dir = resolveWorkspace(plan);
    out = path.join(dir, 'review-' + git('rev-parse --short ' + base) + '..' + git('rev-parse --short ' + head) + '.diff');
  }

  const parts = [
    '# Review package: ' + base + '..' + head,
    '',
    '## Commits',
    git('log --oneline ' + base + '..' + head),
    '',
    '## Files changed',
    git('diff --stat ' + base + '..' + head),
    '',
    '## Diff',
    git('diff -U10 ' + base + '..' + head),
  ];
  const content = parts.join('\n');
  fs.writeFileSync(out, content, 'utf-8');
  console.log('wrote ' + out + ': ' + count + ' commit(s), ' + Buffer.byteLength(content, 'utf-8') + ' bytes');
}

// ===== 分发 =====
const [, , cmd, ...rest] = process.argv;
const handlers = {
  workspace: cmdWorkspace,
  brief: cmdBrief,
  start: cmdStart,
  done: cmdDone,
  review: cmdReview,
};
const fn = handlers[cmd];
if (!fn) {
  console.error('用法: node sp-tools.js <workspace|brief|start|done|review> ...');
  process.exit(2);
}
try {
  fn(rest);
} catch (err) {
  console.error('sp-tools 错误: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
