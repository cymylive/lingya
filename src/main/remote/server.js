/**
 * 手机远程控制：HTTP + WebSocket 服务
 *
 * 绑 127.0.0.1，由 cloudflared 隧道转发到公网。
 * - 静态托管 PWA
 * - WebSocket 双向通信
 * - 令牌鉴权（Authorization header / Sec-WebSocket-Protocol）
 *
 * 不依赖 electron：与主进程的交互全部走 deps 注入回调，便于单测。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { WebSocketServer } = require('ws');

/** WS 单条消息上限（防超大文本放大 JSON/IPC/渲染成本） */
const MAX_WS_MSG = 2 * 1024 * 1024;
/** 文本消息长度上限 */
const MAX_TEXT_LEN = 100000;
/** 心跳间隔 */
const HEARTBEAT_MS = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

let httpServer = null;
let wss = null;
let currentPort = 0;
let currentToken = '';
let heartbeatTimer = null;
let pwaDir = '';
let deps = { onUserMessage: () => {} };

/** 客户端表：ws -> { ip, ua, connectedAt, clientId } */
const clients = new Map();

function guessMime(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function parseUrl(req) {
  try { return new URL(req.url || '/', 'http://127.0.0.1'); } catch (_) { return null; }
}

/** 常量时间比较令牌，防时序侧信道 */
function safeTokenEqual(candidate) {
  if (typeof candidate !== 'string' || !candidate || !currentToken) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(currentToken);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

/** 从 Sec-WebSocket-Protocol 提取令牌（形如 lingya.<token>） */
function tokenFromSubprotocol(req) {
  const sub = req.headers['sec-websocket-protocol'];
  if (typeof sub !== 'string' || !sub) return null;
  for (const part of sub.split(',')) {
    const v = part.trim();
    if (v.startsWith('lingya.')) return v.slice('lingya.'.length);
  }
  return null;
}

function verifyToken(req) {
  if (!currentToken) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeTokenEqual(auth.slice('Bearer '.length))) {
    return true;
  }
  const subToken = tokenFromSubprotocol(req);
  if (subToken !== null && safeTokenEqual(subToken)) return true;
  const url = parseUrl(req);
  return !!(url && safeTokenEqual(url.searchParams.get('token')));
}

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 静态文件响应（防路径穿越，异步读盘） */
async function serveStatic(req, res, pathname) {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch (_) {}
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');

  const rootDir = pwaDir;
  const abs = path.resolve(rootDir, rel);
  const prefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (abs !== rootDir && !abs.startsWith(prefix)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  let st = null;
  try { st = await fs.promises.stat(abs); } catch (_) { st = null; }
  if (!st || !st.isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }

  const etag = 'W/"' + st.mtimeMs + '-' + st.size + '"';
  const cacheControl = rel === 'index.html'
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';

  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }

  try {
    const buf = await fs.promises.readFile(abs);
    res.writeHead(200, {
      'Content-Type': guessMime(abs),
      'Cache-Control': cacheControl,
      'ETag': etag,
    });
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) {
      try { res.writeHead(500); } catch (_) {}
    }
    try { res.end(String(err && err.message ? err.message : err)); } catch (_) {}
  }
}

function handleRequest(req, res) {
  applyCorsHeaders(res);

  // 预检请求不携带令牌，必须在鉴权前放行
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = parseUrl(req);
  if (!url) { res.writeHead(400); res.end('bad request'); return; }

  // API / WS 需鉴权
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    if (!verifyToken(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404); res.end('not found');
    return;
  }

  // 静态资源
  void serveStatic(req, res, url.pathname).catch(() => {});
}

function handleWsMessage(ws, raw) {
  const rawStr = String(raw);
  if (rawStr.length > MAX_WS_MSG) {
    try { ws.send(JSON.stringify({ type: 'sys', text: '消息过大，已忽略' })); } catch (_) {}
    return;
  }

  let msg;
  try { msg = JSON.parse(rawStr); } catch (_) { return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'auth') {
    const cid = typeof msg.clientId === 'string' ? msg.clientId : '';
    if (cid && /^[A-Za-z0-9_-]{1,64}$/.test(cid)) {
      const info = clients.get(ws);
      if (info) info.clientId = cid;
      // 同 clientId 的旧连接踢掉
      for (const [oldWs, oldInfo] of clients.entries()) {
        if (oldWs !== ws && oldInfo.clientId === cid) {
          try { oldWs.terminate(); } catch (_) {}
          clients.delete(oldWs);
        }
      }
    }
    return;
  }

  if (msg.type === 'ping') {
    try { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch (_) {}
    return;
  }

  if (msg.type === 'user-message') {
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!text) return;
    if (text.length > MAX_TEXT_LEN) {
      try { ws.send(JSON.stringify({ type: 'sys', text: '消息过长，已忽略' })); } catch (_) {}
      return;
    }
    try { deps.onUserMessage(text); } catch (err) {
      console.error('[Remote] onUserMessage 异常:', err && err.message);
    }
    return;
  }

  if (msg.type === 'stop') {
    if (typeof deps.onStop === 'function') {
      try { deps.onStop(); } catch (_) {}
    }
    return;
  }

  if (msg.type === 'select-profile') {
    if (typeof deps.onSelectProfile === 'function' && typeof msg.profileId === 'string') {
      try { deps.onSelectProfile(msg.profileId, ws); } catch (_) {}
    }
    return;
  }
}

/** 启动服务。port 传 0 由系统分配（测试用）。 */
function startServer(opts) {
  return new Promise((resolve) => {
    if (httpServer) {
      return resolve({ ok: true, port: currentPort });
    }

    const options = opts || {};
    currentToken = typeof options.token === 'string' ? options.token : '';
    deps = Object.assign({ onUserMessage: () => {} }, options.deps || {});

    pwaDir = options.pwaDir || path.join(__dirname, 'pwa');
    if (!fs.existsSync(pwaDir)) {
      // 目录不存在仍允许启动（T006 之前测试用临时目录；生产应存在）
    }

    let server;
    try {
      server = http.createServer(handleRequest);
    } catch (err) {
      return resolve({ ok: false, error: '创建 http 服务失败: ' + (err && err.message) });
    }

    server.on('error', (err) => {
      httpServer = null;
      resolve({ ok: false, error: '监听失败: ' + (err && err.message) });
    });

    server.listen(options.port || 0, '127.0.0.1', () => {
      httpServer = server;
      currentPort = server.address().port;

      try {
        wss = new WebSocketServer({ noServer: true });
      } catch (err) {
        httpServer = null;
        return resolve({ ok: false, error: '创建 ws 服务失败: ' + (err && err.message) });
      }

      // upgrade 阶段拦截：路径不对或令牌无效直接断开（握手失败，客户端拿不到 open）
      server.on('upgrade', (req, socket, head) => {
        let url;
        try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch (_) { socket.destroy(); return; }
        if (url.pathname !== '/ws') { socket.destroy(); return; }
        if (!verifyToken(req)) {
          try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch (_) {}
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
      });

      wss.on('connection', (ws, req) => {
        const ip = (req.socket && req.socket.remoteAddress) || '';
        const ua = (req.headers && req.headers['user-agent']) || '';
        clients.set(ws, { ip, ua, connectedAt: Date.now(), clientId: '' });

        if (typeof deps.onNewClient === 'function') {
          try { deps.onNewClient(ws); } catch (_) {}
        }

        ws.on('message', (raw) => handleWsMessage(ws, raw));
        ws.on('close', () => { clients.delete(ws); });
        ws.on('error', () => { clients.delete(ws); });
      });

      // 心跳保活
      heartbeatTimer = setInterval(() => {
        for (const ws of clients.keys()) {
          try {
            if (ws.readyState === 1) ws.ping();
          } catch (_) {}
        }
      }, HEARTBEAT_MS);
      if (heartbeatTimer.unref) heartbeatTimer.unref();

      resolve({ ok: true, port: currentPort });
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    if (wss) {
      for (const ws of clients.keys()) {
        try { ws.terminate(); } catch (_) {}
      }
      clients.clear();
      try { wss.close(); } catch (_) {}
      wss = null;
    }

    if (!httpServer) return resolve();

    const server = httpServer;
    httpServer = null;
    currentPort = 0;

    try {
      server.close(() => resolve());
    } catch (_) {
      resolve();
    }
    // 兜底：close 回调可能因 keep-alive 连接迟迟不触发
    setTimeout(resolve, 500);
  });
}

function isRunning() {
  return !!httpServer;
}

function broadcast(msg) {
  if (!wss) return;
  let payload;
  try { payload = JSON.stringify(msg); } catch (_) { return; }
  for (const ws of clients.keys()) {
    try {
      if (ws.readyState === 1) ws.send(payload);
    } catch (_) {}
  }
}

/** 已连接客户端列表（供桌面设置页展示） */
function listClients() {
  const out = [];
  for (const info of clients.values()) {
    out.push({
      ip: info.ip,
      ua: info.ua,
      connectedAt: info.connectedAt,
      clientId: info.clientId,
    });
  }
  return out;
}

/** 断开所有客户端 */
function kickAll() {
  for (const ws of clients.keys()) {
    try { ws.terminate(); } catch (_) {}
  }
  clients.clear();
}

module.exports = {
  startServer,
  stopServer,
  isRunning,
  broadcast,
  listClients,
  kickAll,
};
