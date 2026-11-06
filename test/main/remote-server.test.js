/**
 * remote/server.js 单元测试
 * 真实起 http + ws，不 mock；PWA 目录用临时目录（不依赖 T006）
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const WebSocket = require('ws');

const server = require('../../src/main/remote/server.js');

const TOKEN = 'a'.repeat(32);
const PWA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-pwa-'));

// 造一个最小 PWA 目录
fs.writeFileSync(path.join(PWA_TMP, 'index.html'), '<html><body>hello</body></html>', 'utf-8');
fs.writeFileSync(path.join(PWA_TMP, 'app.js'), 'console.log(1);', 'utf-8');

let PORT = 0;
let received = [];   // onUserMessage 收到的消息
let stopped = 0;     // onStop 调用次数

/** 发一个 http 请求，返回 { status, headers, body } */
function req(pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** 连一个 ws，返回 { ws, opened, closed } */
function connectWs(token, clientId) {
  return new Promise((resolve) => {
    const headers = {};
    let protocols;
    if (token) protocols = ['lingya.' + token];
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws', protocols, { headers });
    const result = { ws, opened: false, closed: false, closeCode: null, messages: [] };
    ws.on('open', () => { result.opened = true; resolve(result); });
    ws.on('message', (d) => { result.messages.push(JSON.parse(String(d))); });
    ws.on('close', (code) => { result.closed = true; result.closeCode = code; });
    ws.on('error', () => { if (!result.opened) resolve(result); });
    setTimeout(() => { if (!result.opened) resolve(result); }, 800);
  });
}

before(async () => {
  const r = await server.startServer({
    port: 0,
    token: TOKEN,
    pwaDir: PWA_TMP,
    deps: {
      onUserMessage: (text) => { received.push(text); },
      onStop: () => { stopped++; },
      onListProfiles: () => [{ id: 'p1', name: 'w1' }],
      onGetCurrentProfile: () => 'p1',
    },
  });
  assert.ok(r.ok, '服务应启动成功: ' + r.error);
  PORT = r.port;
});

after(async () => {
  await server.stopServer();
  try { fs.rmSync(PWA_TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------- HTTP 鉴权 ----------

test('无令牌访问 /api/ping 返回 401', async () => {
  const r = await req('/api/ping');
  assert.strictEqual(r.status, 401);
});

test('错误令牌返回 401', async () => {
  const r = await req('/api/ping', { headers: { Authorization: 'Bearer wrong' } });
  assert.strictEqual(r.status, 401);
});

test('正确令牌 /api/ping 返回 200 且 body 为 ok', async () => {
  const r = await req('/api/ping', { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
});

test('OPTIONS 预检在鉴权前放行（204）', async () => {
  const r = await req('/api/ping', { method: 'OPTIONS' });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
});

// ---------- 静态资源 ----------

test('GET / 返回 index.html', async () => {
  const r = await req('/');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('hello'));
  assert.match(r.headers['content-type'] || '', /text\/html/);
});

test('静态资源带 ETag，二次请求返回 304', async () => {
  const a = await req('/app.js');
  assert.strictEqual(a.status, 200);
  assert.ok(a.headers.etag, '应有 ETag');
  const b = await req('/app.js', { headers: { 'If-None-Match': a.headers.etag } });
  assert.strictEqual(b.status, 304);
});

test('路径穿越被拒（403 或 404）', async () => {
  const r = await req('/../config.js');
  assert.ok(r.status === 403 || r.status === 404, '实际: ' + r.status);
});

test('不存在的文件返回 404', async () => {
  const r = await req('/nope.js');
  assert.strictEqual(r.status, 404);
});

// ---------- WebSocket 鉴权 ----------

test('WS 用 Sec-WebSocket-Protocol 鉴权成功', async () => {
  const c = await connectWs(TOKEN);
  assert.strictEqual(c.opened, true, '应连接成功');
  c.ws.close();
});

test('WS 无令牌被拒', async () => {
  const c = await connectWs(null);
  assert.strictEqual(c.opened, false, '不应连上');
  if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
});

test('WS 错误令牌被拒', async () => {
  const c = await connectWs('b'.repeat(32));
  assert.strictEqual(c.opened, false);
  if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
});

// ---------- WS 消息 ----------

test('WS 心跳 ping 返回 pong', async () => {
  const c = await connectWs(TOKEN);
  c.ws.send(JSON.stringify({ type: 'ping' }));
  await new Promise((r) => setTimeout(r, 200));
  const hasPong = c.messages.some((m) => m.type === 'pong');
  assert.ok(hasPong, '应收到 pong，实际: ' + JSON.stringify(c.messages));
  c.ws.close();
});

test('WS user-message 触发 onUserMessage', async () => {
  received = [];
  const c = await connectWs(TOKEN);
  c.ws.send(JSON.stringify({ type: 'user-message', text: 'hello' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(received, ['hello']);
  c.ws.close();
});

test('WS stop 触发 onStop', async () => {
  stopped = 0;
  const c = await connectWs(TOKEN);
  c.ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(stopped, 1);
  c.ws.close();
});

test('clientId 去重：新连接踢掉旧连接', async () => {
  const c1 = await connectWs(TOKEN);
  c1.ws.send(JSON.stringify({ type: 'auth', clientId: 'cid-1' }));
  await new Promise((r) => setTimeout(r, 100));

  const c2 = await connectWs(TOKEN);
  c2.ws.send(JSON.stringify({ type: 'auth', clientId: 'cid-1' }));
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(c1.closed, true, '旧连接应被踢掉');
  assert.strictEqual(c2.opened, true, '新连接应保持');
  c2.ws.close();
});

test('超大消息被拒并提示', async () => {
  const c = await connectWs(TOKEN);
  const huge = 'x'.repeat(3 * 1024 * 1024); // 3MB > 2MB 上限
  c.ws.send(JSON.stringify({ type: 'user-message', text: huge }));
  await new Promise((r) => setTimeout(r, 300));
  const hasSys = c.messages.some((m) => m.type === 'sys' && /过大|忽略/.test(m.text || ''));
  assert.ok(hasSys, '应提示消息过大，实际: ' + JSON.stringify(c.messages.map((m) => m.type)));
  c.ws.close();
});

// ---------- 广播 ----------

test('broadcast 发给所有已连接客户端', async () => {
  const c = await connectWs(TOKEN);
  server.broadcast({ type: 'sys', text: 'broadcast-test' });
  await new Promise((r) => setTimeout(r, 200));
  const got = c.messages.find((m) => m.type === 'sys' && m.text === 'broadcast-test');
  assert.ok(got, '应收到广播');
  c.ws.close();
});

// ---------- 生命周期 ----------

test('stopServer 后 isRunning 为 false', async () => {
  assert.strictEqual(server.isRunning(), true);
  await server.stopServer();
  assert.strictEqual(server.isRunning(), false);
  // 重启以便后续（本文件已无后续用例，但保持 after 的幂等）
  const r = await server.startServer({
    port: 0, token: TOKEN, pwaDir: PWA_TMP, deps: { onUserMessage: () => {} },
  });
  assert.ok(r.ok);
  PORT = r.port;
});
