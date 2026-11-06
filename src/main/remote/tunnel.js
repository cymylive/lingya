/**
 * 手机远程控制：Cloudflare Tunnel 子进程托管
 * 固定 Token 模式 / 临时 trycloudflare 模式，自愈重启，代际号防僵尸。
 * 不依赖 electron，可单测。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');

let tunnelProc = null;
let currentUrl = '';
let currentError = '';
let currentMode = 'none';
let pendingStartTimer = null;

let lastStartOpts = null;
let restartTimer = null;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_MS = 3000;
let tunnelGen = 0;

const EDGE_PORT = 7844;
const EDGE_TTL_MS = 10 * 60 * 1000;
const EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'];
let edgeCache = { at: 0, server: '', ips: [] };

let spawnImpl = spawn;
function _setSpawnForTesting(fn) { spawnImpl = fn || spawn; }

function _resetForTesting() {
  tunnelGen++;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
  restartAttempts = 0;
  lastStartOpts = null;
  edgeCache = { at: 0, server: '', ips: [] };
  tunnelProc = null;
  currentUrl = '';
  currentError = '';
  currentMode = 'none';
}

function scheduleRestart(myGen) {
  if (myGen !== tunnelGen) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    currentError = 'cloudflared 连续重启失败 ' + MAX_RESTART_ATTEMPTS + ' 次，已放弃（请检查网络/安装）';
    console.warn('[Remote] ' + currentError);
    return;
  }
  if (restartTimer) return;
  restartAttempts++;
  const delay = Math.min(RESTART_BASE_MS * restartAttempts, 30000);
  console.log('[Remote] cloudflared 意外退出，' + delay + 'ms 后自动重启（第 ' + restartAttempts + ' 次）');
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (myGen !== tunnelGen || !lastStartOpts) return;
    startTunnel(lastStartOpts).then((r) => {
      if (r.ok) {
        console.log('[Remote] cloudflared 已自动恢复' + (r.url ? '：' + r.url : ''));
      } else {
        console.warn('[Remote] cloudflared 自动重启未成功:', r.error);
        scheduleRestart(tunnelGen);
      }
    }).catch(() => scheduleRestart(tunnelGen));
  }, delay);
}

function buildCloudflaredCandidates(platform, env, packagedBin) {
  const out = [];
  if (packagedBin) out.push(packagedBin);
  if (platform !== 'win32') {
    out.push('cloudflared');
    return out;
  }
  out.push(
    'C:/Program Files/cloudflared/cloudflared.exe',
    'C:/Program Files (x86)/cloudflared/cloudflared.exe'
  );
  if (env && env.LOCALAPPDATA) {
    out.push(path.win32.join(env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'));
  }
  out.push(
    'C:/cloudflared/cloudflared.exe',
    'C:/tools/cloudflared/cloudflared.exe',
    'D:/cloudflared/cloudflared.exe',
    'D:/tools/cloudflared/cloudflared.exe'
  );
  // 开发版/源码仓库：仓库根目录 resources/cloudflared
  try {
    if (env && env.LINGYA_RESOURCES) {
      out.push(path.win32.join(env.LINGYA_RESOURCES, 'cloudflared', 'cloudflared.exe'));
    }
    out.push(path.join(__dirname, '..', '..', '..', 'resources', 'cloudflared', 'cloudflared.exe'));
    out.push(path.join(process.cwd(), 'resources', 'cloudflared', 'cloudflared.exe'));
  } catch (_) {}
  return out;
}

function getPackagedCloudflared() {
  try {
    const rp = process.resourcesPath;
    if (!rp) return '';
    return path.join(rp, 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  } catch (_) {
    return '';
  }
}

function findCloudflaredBinary(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const envPath = process.env.CLOUDFLARED_BIN;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = buildCloudflaredCandidates(process.platform, process.env, getPackagedCloudflared());
  for (const p of candidates) {
    if (p.indexOf('/') >= 0 || p.indexOf('\\') >= 0) {
      if (fs.existsSync(p)) return p;
    }
  }
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** 用指定 DNS 解析 Cloudflare edge IPv4，绕过系统 DNS（argotunnel.com 常被本地 DNS 拒绝） */
function resolveEdgeIps(dnsServer) {
  const server = String(dnsServer || '').trim();
  if (!server) return Promise.resolve([]);
  const now = Date.now();
  if (edgeCache.server === server && edgeCache.ips.length && (now - edgeCache.at) < EDGE_TTL_MS) {
    return Promise.resolve(edgeCache.ips.slice());
  }
  let resolver;
  try {
    resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([server]);
  } catch (_) {
    return Promise.resolve([]);
  }
  const query = (host) => new Promise((resolve) => {
    try {
      resolver.resolve4(host, (err, addrs) => {
        if (err || !Array.isArray(addrs)) return resolve([]);
        resolve(addrs.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)));
      });
    } catch (_) { resolve([]); }
  });
  return Promise.all(EDGE_HOSTS.map(query)).then((lists) => {
    const seen = new Set();
    const ips = [];
    lists.forEach((arr) => arr.forEach((ip) => { if (!seen.has(ip)) { seen.add(ip); ips.push(ip); } }));
    if (ips.length) edgeCache = { at: Date.now(), server, ips: ips.slice() };
    return ips;
  }).catch(() => []);
}

function buildEdgeArgs(ips) {
  const args = [];
  (ips || []).forEach((ip) => args.push('--edge', ip + ':' + EDGE_PORT));
  return args;
}

function killProcTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try { proc.kill('SIGTERM'); } catch (_) {
    try { proc.kill(); } catch (__) {}
  }
  if (process.platform === 'win32' && pid) {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch (_) {}
  }
}

async function startTunnel(opts) {
  let edgeIps = [];
  if (opts && opts.edgeDns) {
    try { edgeIps = await resolveEdgeIps(opts.edgeDns); } catch (_) { edgeIps = []; }
    if (edgeIps.length) {
      console.log('[Remote] 已解析 edge IP: ' + edgeIps.join(', '));
    } else {
      console.warn('[Remote] edge DNS 解析无结果，回退默认');
    }
  }

  return new Promise((resolve) => {
    if (tunnelProc && !tunnelProc.killed) {
      return resolve({ ok: true, url: currentUrl });
    }

    lastStartOpts = opts;
    const myGen = ++tunnelGen;

    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

    const bin = findCloudflaredBinary(opts.customPath);
    if (!bin) {
      currentError = '未找到 cloudflared 可执行文件';
      return resolve({ ok: false, error: currentError });
    }

    currentUrl = '';
    currentError = '';
    const args = [];

    if (opts.tunnelToken && String(opts.tunnelToken).trim()) {
      currentMode = 'fixed';
      args.push('tunnel', 'run', '--token', String(opts.tunnelToken).trim());
    } else {
      currentMode = 'quick';
      args.push('tunnel', '--url', 'http://127.0.0.1:' + opts.port);
    }
    buildEdgeArgs(edgeIps).forEach((a) => args.push(a));

    let myProc = null;
    try {
      myProc = spawnImpl(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      tunnelProc = myProc;
    } catch (err) {
      currentError = (err && err.message) || '启动 cloudflared 失败';
      currentMode = 'none';
      return resolve({ ok: false, error: currentError });
    }

    let resolved = false;
    let fatalStartError = false;

    const onExit = (code, signal) => {
      if (myGen !== tunnelGen) return;
      if (tunnelProc === myProc) {
        tunnelProc = null;
        currentMode = 'none';
      }
      if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
      if (!resolved) {
        resolved = true;
        currentError = currentError || 'cloudflared 进程异常退出 (code: ' + code + ', signal: ' + signal + ')';
        resolve({ ok: false, error: currentError });
      }
      if (myGen === tunnelGen && !fatalStartError) scheduleRestart(myGen);
    };

    myProc.on('exit', onExit);

    myProc.on('error', (err) => {
      if (myGen !== tunnelGen) return;
      const code = err && err.code;
      if (code === 'ENOENT' || code === 'EACCES') fatalStartError = true;
      currentError = code === 'ENOENT'
        ? '系统中未检测到 cloudflared，请先安装或将 cloudflared 加入环境变量 PATH'
        : ((err && err.message) || 'cloudflared 执行错误');
      if (opts.onError) opts.onError(currentError);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: currentError });
      }
    });

    const handleOutput = (data) => {
      if (myGen !== tunnelGen) return;
      const text = data.toString('utf-8');

      if (text.indexOf('failed to parse token') >= 0
        || text.indexOf('incorrect usage') >= 0
        || text.indexOf('Provided Tunnel token is not valid') >= 0) {
        fatalStartError = true;
        currentError = 'Token 格式错误或无效，请检查是否正确复制了完整凭证';
        if (opts.onError) opts.onError(currentError);
        if (!resolved) {
          resolved = true;
          if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
          resolve({ ok: false, error: currentError });
        }
        return;
      }

      if (currentUrl || currentMode === 'fixed') return;
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        currentUrl = match[0];
        if (opts.onUrlDetected) opts.onUrlDetected(currentUrl);
        if (!resolved) {
          resolved = true;
          if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
          const urlGen = myGen;
          const stableMs = typeof opts.stableMs === 'number' ? opts.stableMs : 6000;
          setTimeout(() => {
            if (urlGen !== tunnelGen) return;
            if (myProc && !myProc.killed && myProc.exitCode === null) {
              restartAttempts = 0;
              resolve({ ok: true, url: currentUrl });
            } else {
              currentUrl = '';
              currentError = currentError || 'cloudflared 进程在建立连接后异常退出，请检查网络或 DNS 是否拦截了 argotunnel.com';
              resolve({ ok: false, error: currentError });
            }
          }, stableMs);
        }
      }
    };

    if (myProc.stdout) myProc.stdout.on('data', handleOutput);
    if (myProc.stderr) myProc.stderr.on('data', handleOutput);

    if (currentMode === 'fixed') {
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved && myProc && !myProc.killed) {
          resolved = true;
          restartAttempts = 0;
          resolve({ ok: true });
        }
      }, 1500);
    } else {
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!resolved) {
          resolved = true;
          if (myProc && !myProc.killed && currentUrl) {
            restartAttempts = 0;
            resolve({ ok: true, url: currentUrl });
          } else {
            resolve({ ok: false, error: currentError || '启动临时隧道超时（未获取到公网地址）' });
          }
        }
      }, 12000);
    }
  });
}

function stopTunnel() {
  return new Promise((resolve) => {
    tunnelGen++;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartAttempts = 0;
    lastStartOpts = null;
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }

    if (!tunnelProc) {
      currentMode = 'none';
      currentUrl = '';
      currentError = '';
      return resolve();
    }

    const proc = tunnelProc;
    tunnelProc = null;
    currentMode = 'none';
    currentUrl = '';
    currentError = '';

    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };

    proc.once('exit', finish);
    killProcTree(proc);

    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      finish();
    }, 1000);
  });
}

function getTunnelStatus() {
  return {
    running: !!(tunnelProc && !tunnelProc.killed),
    mode: currentMode,
    url: currentUrl,
    pid: tunnelProc ? (tunnelProc.pid || null) : null,
    error: currentError,
  };
}

process.on('exit', () => {
  if (tunnelProc && !tunnelProc.killed) killProcTree(tunnelProc);
});

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  findCloudflaredBinary,
  buildCloudflaredCandidates,
  resolveEdgeIps,
  buildEdgeArgs,
  _setSpawnForTesting,
  _resetForTesting,
};
