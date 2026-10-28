/**
 * 构建 graphify 二进制（graphify.exe / graphify-mcp.exe）
 *
 * 背景：resources/graphify/ 下的 exe 共 67MB，不入库（.gitignore 排除 *.exe），
 * 但打包时 electron-builder 的 extraResources 要复制它们 → 必须在 CI/本地构建前生成。
 *
 * 流程：
 *   1. 检查产物是否已存在且比 build/*.spec 与 build/*-entry.py 新 → 跳过
 *   2. pip 安装 pyinstaller + graphifyy（CI 上无缓存，本地可能已装）
 *   3. pyinstaller 分别跑两个 spec
 *   4. 复制产物到 resources/graphify/
 *
 * 平台差异：
 *   - Windows 产物名 graphify.exe / graphify-mcp.exe
 *   - macOS/Linux 产物名 graphify / graphify-mcp（无后缀）
 *   - 注意：PyInstaller 只能产出当前平台的可执行文件，
 *     mac 上构建出的是 arm64 还是 x64 取决于 runner 架构。
 *
 * 用法：node scripts/build-graphify.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'resources', 'graphify');
const DIST_DIR = path.join(ROOT, 'build', 'graphify-dist');
const WORK_DIR = path.join(ROOT, 'build', 'graphify-work');
const BUILD_DIR = path.join(ROOT, 'build');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const TARGETS = ['graphify', 'graphify-mcp'];
const FORCE = process.argv.includes('--force');

/** 依赖文件的最近修改时间（spec + entry） */
function newestInputMtime() {
  let newest = 0;
  for (const name of ['graphify-cli.spec', 'graphify-mcp.spec', 'graphify-cli-entry.py', 'graphify-mcp-entry.py']) {
    try {
      const st = fs.statSync(path.join(BUILD_DIR, name));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch (_) { /* 缺文件时忽略，交给 PyInstaller 报错 */ }
  }
  return newest;
}

/** 产物是否齐全且比输入新 */
function outputsFresh() {
  const inputMtime = newestInputMtime();
  if (!inputMtime) return false;
  for (const t of TARGETS) {
    const p = path.join(OUT_DIR, t + EXE);
    try {
      const st = fs.statSync(p);
      if (st.size < 1000000) return false;        // 过小视为失败产物
      if (st.mtimeMs < inputMtime) return false;  // 比源码旧
    } catch (_) {
      return false;
    }
  }
  return true;
}

/** 跑 python -m PyInstaller 构建单个 spec */
function runPyInstaller(py, specName) {
  const specPath = path.join(BUILD_DIR, specName);
  const args = [
    '-m', 'PyInstaller',
    '--noconfirm',
    '--distpath', DIST_DIR,
    '--workpath', WORK_DIR,
    specPath,
  ];
  console.log('[graphify] 执行: ' + py + ' ' + args.join(' '));
  execFileSync(py, args, { cwd: BUILD_DIR, stdio: 'inherit', timeout: 30 * 60 * 1000 });
}

/** Python 解释器候选（Windows 是 python/py，mac 是 python3/python） */
const PY_CANDIDATES = IS_WIN ? ['python', 'py'] : ['python3', 'python'];

/** 找到可用的 python 解释器，找不到抛错 */
function resolvePython() {
  for (const bin of PY_CANDIDATES) {
    try {
      execFileSync(bin, ['-c', 'import sys'], { stdio: 'ignore' });
      return bin;
    } catch (_) { /* 试下一个 */ }
  }
  throw new Error('未找到可用的 Python 解释器，尝试过: ' + PY_CANDIDATES.join(', '));
}

/** 检查某个模块能否 import */
function hasModule(py, mod) {
  try {
    execFileSync(py, ['-c', 'import ' + mod], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

/** pip 安装（--quiet 减少噪音） */
function pipInstall(py, pkg, timeoutMs) {
  console.log('[graphify] pip install ' + pkg + '（可能耗时数分钟）');
  execFileSync(py, ['-m', 'pip', 'install', '--quiet', pkg], {
    stdio: 'inherit',
    timeout: timeoutMs,
  });
}

/** 确保 pyinstaller 与 graphifyy 已安装 */
function ensureDeps() {
  const py = resolvePython();
  if (!hasModule(py, 'PyInstaller')) {
    pipInstall(py, 'pyinstaller', 10 * 60 * 1000);
  }
  if (!hasModule(py, 'graphify')) {
    pipInstall(py, 'graphifyy', 20 * 60 * 1000);
  }
}

function main() {
  if (!FORCE && outputsFresh()) {
    console.log('[graphify] 产物已是最新，跳过构建（--force 可强制重建）');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  ensureDeps();

  const py = resolvePython();
  for (const spec of ['graphify-cli.spec', 'graphify-mcp.spec']) {
    runPyInstaller(py, spec);
  }

  for (const t of TARGETS) {
    const src = path.join(DIST_DIR, t + EXE);
    const dst = path.join(OUT_DIR, t + EXE);
    if (!fs.existsSync(src)) {
      throw new Error('未找到构建产物: ' + src);
    }
    fs.copyFileSync(src, dst);
    const size = fs.statSync(dst).size;
    console.log('[graphify] 已生成 ' + dst + ' (' + (size / 1048576).toFixed(1) + ' MB)');
  }

  console.log('[graphify] 完成');
}

main();
