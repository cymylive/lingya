/**
 * Graphify 自动建图
 *
 * 设计要点：
 * - 图统一落在 <userData>/graphify/graph.json（与 mcp.json 里注册的路径一致）
 * - 切换项目时覆盖重建，MCP server 始终指向同一路径，不需要重启
 * - 后台异步执行，绝不阻塞窗口初始化
 * - 同一项目在 TTL 内不重复建图
 *
 * 关键约束（都是踩过坑补的）：
 * - 图只有一份，所以 TTL 缓存必须同时确认「当前图确实是这个项目建的」，
 *   否则 A→B→A 的切换会在 TTL 内拿到 B 的图却以为是 A 的。
 * - 建图先写临时目录，成功后原子重命名；失败或崩溃不会留下半成品 graph.json。
 * - 同一时刻只跑一个建图进程；切项目时先 cancel 旧的，避免并发写同一文件。
 * - 失败不计入 TTL，下次调用会重试。
 */
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 建图成功后多久内不重复建（毫秒）。 */
const REBUILD_TTL_MS = 10 * 60 * 1000;

/** 单次建图超时（毫秒）。超时强制 kill，避免 promise 永久 pending。 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** 建图结果记录：projectDir -> { at: number, ok: boolean }。仅在成功时写 at。 */
const state = new Map();

/** 当前正在跑的建图子进程与其项目目录 */
let currentChild = null;
let currentProject = null;

function getGraphDir() {
  return path.join(app.getPath('userData'), 'graphify');
}

function getGraphJsonPath() {
  return path.join(getGraphDir(), 'graph.json');
}

/** 记录「当前 graph.json 是哪个项目建的」，用于 TTL 正确性判断 */
function getSourceFile() {
  return path.join(getGraphDir(), '.source.json');
}

/** 读当前图的来源项目路径；无记录返回 null */
function getBuiltFrom() {
  try {
    const raw = JSON.parse(fs.readFileSync(getSourceFile(), 'utf-8'));
    return raw && typeof raw.projectDir === 'string' ? raw.projectDir : null;
  } catch (_) {
    return null;
  }
}

function writeSource(projectDir) {
  try {
    fs.mkdirSync(getGraphDir(), { recursive: true });
    fs.writeFileSync(getSourceFile(), JSON.stringify({ projectDir, at: Date.now() }, null, 2), 'utf-8');
  } catch (_) {}
}

/**
 * 定位 graphify CLI exe。
 * 打包后在 process.resourcesPath/graphify，开发时在项目根 resources/graphify。
 */
function locateCli() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'graphify', 'graphify.exe'));
  }
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'graphify', 'graphify.exe'));
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

/** 终止正在进行的建图（切换项目或退出时用） */
function cancel() {
  if (currentChild) {
    try { currentChild.kill(); } catch (_) {}
    currentChild = null;
  }
  currentProject = null;
}

/**
 * 在后台为指定项目建图。
 *
 * @param {string} projectDir 项目根目录
 * @param {{force?: boolean, onDone?: Function}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, nodes?: number, cached?: boolean}>}
 */
function buildGraph(projectDir, options = {}) {
  const opts = options || {};
  if (!projectDir || !fs.existsSync(projectDir)) {
    return Promise.resolve({ ok: false, reason: '项目目录不存在' });
  }

  const cli = locateCli();
  if (!cli) {
    return Promise.resolve({ ok: false, reason: 'graphify.exe 未找到' });
  }

  // TTL 判定：必须同时满足「这个项目近期建过」且「当前图确实来自这个项目」。
  // 只查 state 会在 A→B→A 切换时拿错图。
  if (!opts.force) {
    const rec = state.get(projectDir);
    if (rec && rec.ok && Date.now() - rec.at < REBUILD_TTL_MS && getBuiltFrom() === projectDir) {
      return Promise.resolve({ ok: true, reason: 'TTL 内已建图', cached: true });
    }
  }

  // 同一时刻只允许一个建图进程。切项目时先杀掉旧的，
  // 否则两个进程并发写同一个 graph.json 可能产生损坏文件。
  if (currentChild && currentProject !== projectDir) {
    cancel();
  }

  const graphDir = getGraphDir();
  try { fs.mkdirSync(graphDir, { recursive: true }); } catch (_) {}

  // 先写到临时目录，成功后原子重命名，避免崩溃留下半成品 graph.json
  const tmpDir = path.join(graphDir, '.tmp-build-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}

  const cleanupTmp = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };

  const promise = new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (currentChild === child) { currentChild = null; currentProject = null; }
      // 只有成功才写 at；失败不写，下次调用会重试
      if (result.ok) {
        state.set(projectDir, { at: Date.now(), ok: true });
      } else {
        state.delete(projectDir);
      }
      if (!result.ok) cleanupTmp();
      if (typeof opts.onDone === 'function') {
        try { opts.onDone(result); } catch (_) {}
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(cli, ['extract', projectDir, '--code-only'], {
        cwd: projectDir,
        env: { ...process.env, GRAPHIFY_OUT: tmpDir, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
    } catch (err) {
      done({ ok: false, reason: '启动建图进程失败: ' + err.message });
      return;
    }
    currentChild = child;
    currentProject = projectDir;

    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done({ ok: false, reason: '建图超时（' + Math.round(BUILD_TIMEOUT_MS / 1000) + 's）' });
    }, BUILD_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => done({ ok: false, reason: '建图进程异常: ' + err.message }));

    child.on('close', (code) => {
      if (code !== 0) {
        console.warn('[Graphify] 建图失败 code=' + code, stderr.slice(-300));
        done({ ok: false, reason: '退出码 ' + code + (stderr ? ': ' + stderr.slice(-200) : '') });
        return;
      }
      // 临时目录里的 graph.json 才是本次产物
      const tmpGraph = path.join(tmpDir, 'graph.json');
      if (!fs.existsSync(tmpGraph)) {
        done({ ok: false, reason: '建图未产出 graph.json' });
        return;
      }
      let nodes = 0;
      try {
        const g = JSON.parse(fs.readFileSync(tmpGraph, 'utf-8'));
        nodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
      } catch (_) {
        done({ ok: false, reason: '产物 graph.json 解析失败' });
        return;
      }
      // 原子替换：同盘 rename
      const finalPath = getGraphJsonPath();
      try {
        try { fs.rmSync(finalPath, { force: true }); } catch (_) {}
        fs.renameSync(tmpGraph, finalPath);
        writeSource(projectDir);
      } catch (err) {
        done({ ok: false, reason: '写入正式图谱失败: ' + err.message });
        return;
      }
      cleanupTmp();
      console.log('[Graphify] 建图完成:', projectDir, 'nodes=' + nodes);
      done({ ok: true, nodes });
    });
  });

  return promise;
}

/** 图谱是否已存在且非空 */
function hasGraph() {
  try {
    const p = getGraphJsonPath();
    if (!fs.existsSync(p)) return false;
    return fs.statSync(p).size > 0;
  } catch (_) {
    return false;
  }
}

module.exports = {
  buildGraph,
  cancel,
  hasGraph,
  getGraphJsonPath,
  getGraphDir,
  getBuiltFrom,
  locateCli,
  REBUILD_TTL_MS,
  BUILD_TIMEOUT_MS,
};
