/**
 * DSH 兼容层 - npm 安装（CommonJS）
 *
 * 打包版的坑：双击 exe 运行时，PATH 里**没有** node/npm（开发时 npm start 才有）。
 * 因此这里必须主动探测 node 安装目录，并把它的 PATH 注入子进程。
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDshPluginDir, isValidPluginId } = require('./paths');

/** 常见 node 安装位置（Windows） */
function candidateNodeDirs() {
  const dirs = [];
  const env = process.env;
  // 环境变量优先
  if (env.NODE_ROOT) dirs.push(env.NODE_ROOT);
  if (env.NODE_HOME) dirs.push(env.NODE_HOME);
  // 从当前 PATH 里找
  const sep = path.delimiter;
  for (const p of String(env.PATH || '').split(sep)) {
    if (p && /node(js)?$/i.test(p.replace(/[\\/]+$/, ''))) dirs.push(p);
  }
  if (process.platform === 'win32') {
    dirs.push('D:\\NodeJS');
    dirs.push('C:\\Program Files\\nodejs');
    dirs.push('C:\\Program Files (x86)\\nodejs');
    dirs.push(path.join(env.LOCALAPPDATA || '', 'Programs', 'nodejs'));
    dirs.push('E:\\node.js');
    dirs.push('E:\\NodeJS');
  } else {
    dirs.push('/usr/local/bin', '/usr/bin');
  }
  return dirs.filter(Boolean);
}

/** 在目录里找 npm 可执行文件（Windows: npm.cmd） */
function npmInDir(dir) {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

/** 平台标识（与 fetch-runtime.mjs 一致） */
function runtimePlatform() {
  const p = process.platform, a = process.arch;
  if (p === 'win32' && a === 'x64') return 'win-x64';
  if (p === 'darwin' && a === 'x64') return 'mac-x64';
  if (p === 'darwin' && a === 'arm64') return 'mac-arm64';
  return null;
}

/** 找应用自带的 npm（resources/runtime/<platform>/bin/），打包后优先用它 */
function bundledNpm() {
  const platform = runtimePlatform();
  if (!platform) return null;
  const candidates = [];
  // 打包后：<安装目录>/resources/runtime/<platform>/bin
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'runtime', platform, 'bin'));
  }
  // 开发环境：项目根 resources/runtime/<platform>/bin
  candidates.push(path.join(__dirname, '..', '..', '..', 'resources', 'runtime', platform, 'bin'));
  for (const binDir of candidates) {
    const npm = npmInDir(binDir);
    if (npm) return { npm, nodeDir: binDir };
  }
  return null;
}

/**
 * 找 npm + node 目录。
 * @returns {{ npm: string|null, nodeDir: string|null, bundled?: boolean }}
 */
function findNpmAndNode() {
  // 0) 优先：应用自带 npm 运行时（不碰用户系统）
  const bundled = bundledNpm();
  if (bundled) return { npm: bundled.npm, nodeDir: bundled.nodeDir, bundled: true };
  // 1) 系统 PATH 直接有 npm
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of pathDirs) {
    const npm = npmInDir(d);
    if (npm) return { npm, nodeDir: d };
  }
  // 2) 探测常见位置
  for (const d of candidateNodeDirs()) {
    const npm = npmInDir(d);
    if (npm) return { npm, nodeDir: d };
  }
  return { npm: null, nodeDir: null };
}

/**
 * 安装一个 npm 包作为 DSH 插件。
 * @param {string} spec npm 包名（可带版本，如 @scope/pkg@1.0.0）
 * @param {(msg:string)=>void} [onLog]
 */
function installPlugin(spec, onLog) {
  return new Promise((resolve) => {
    const name = String(spec || '').trim();
    if (!name) return resolve({ success: false, error: '包名不能为空' });
    const base = name.replace(/@[^@/]*$/, '').replace(/^@/, '').replace(/\//g, '-');
    if (!isValidPluginId(base)) {
      return resolve({ success: false, error: '无法从包名推导合法插件 id: ' + base });
    }
    const dir = getDshPluginDir(base);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
      return resolve({ success: false, error: '创建目录失败: ' + err.message });
    }
    const shellPkg = path.join(dir, 'package.json');
    if (!fs.existsSync(shellPkg)) {
      fs.writeFileSync(shellPkg, JSON.stringify({ name: 'lingya-dsh-plugin-' + base, version: '1.0.0', private: true }, null, 2), 'utf-8');
    }

    // 探测 npm + node（打包版 PATH 常无 node）
    const found = findNpmAndNode();
    if (!found.npm) {
      return resolve({
        success: false,
        error: '未找到 npm。请安装 Node.js，或在环境变量 PATH 中加入 node 目录（如 D:\\NodeJS）。',
      });
    }
    if (onLog) onLog('使用 npm: ' + found.npm + (found.nodeDir ? '（node 目录: ' + found.nodeDir + '）' : ''));

    // 子进程 PATH 注入 node 目录（npm.cmd 内部要调 node）
    const childEnv = Object.assign({}, process.env);
    if (found.nodeDir) {
      childEnv.PATH = found.nodeDir + path.delimiter + (childEnv.PATH || '');
    }

    const args = ['install', name, '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund', '--save', '--legacy-peer-deps'];
    if (onLog) onLog('npm ' + args.join(' '));
    const isWin = process.platform === 'win32';
    // Windows 下 .cmd 必须经 cmd.exe；用 ComSpec /c
    const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : found.npm;
    const cmdArgs = isWin ? ['/d', '/s', '/c', found.npm, ...args] : args;

    execFile(cmd, cmdArgs, { cwd: dir, timeout: 180000, windowsHide: true, env: childEnv }, (error, stdout, stderr) => {
      if (onLog && stdout) onLog(stdout);
      if (error) {
        const detail = (stderr && String(stderr).trim()) || error.message || String(error);
        return resolve({ success: false, error: 'npm 安装失败: ' + detail.slice(0, 500) });
      }
      // 校验真装上了（node_modules 非空）
      const nm = path.join(dir, 'node_modules');
      let installed = false;
      try { installed = fs.existsSync(nm) && fs.readdirSync(nm).length > 0; } catch (_) {}
      if (!installed) {
        return resolve({ success: false, error: 'npm 执行完成但 node_modules 为空（可能网络失败或被拦截）' });
      }
      resolve({ success: true, id: base });
    });
  });
}

/** 卸载（删目录） */
function uninstallPlugin(id) {
  if (!isValidPluginId(id)) return { success: false, error: '非法 id' };
  const dir = getDshPluginDir(id);
  const resolved = path.resolve(dir);
  const root = path.resolve(path.dirname(dir));
  if (!resolved.startsWith(root + path.sep)) return { success: false, error: '非法路径' };
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { installPlugin, uninstallPlugin, findNpmAndNode };
