const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const tunnel = require('../../src/main/remote/tunnel.js');
let procs = [];
function makeProc() {
  const p = new EventEmitter();
  p.pid = null;
  p.killed = false;
  p.exitCode = null;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => { p.killed = true; p.exitCode = 0; return true; };
  procs.push(p);
  return p;
}
beforeEach(() => { procs = []; tunnel._resetForTesting();
  tunnel._setSpawnForTesting(makeProc); });
afterEach(() => { tunnel._resetForTesting();
  tunnel._setSpawnForTesting(null); });
test('candidates builtin first', () => {
  const pk = 'C:/app/cloudflared.exe';
  const out = tunnel.buildCloudflaredCandidates('win32', { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, pk);
  assert.strictEqual(out[0], pk);
  assert.ok(out.length > 3);
});
test('non-win32 candidates', () => {
  const out = tunnel.buildCloudflaredCandidates('darwin', {}, '/app/cf');
  assert.deepStrictEqual(out, ['/app/cf', 'cloudflared']);
});
test('customPath priority', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const f = path.join(dir, 'cloudflared.exe');
  fs.writeFileSync(f, 'fake');
  try { assert.strictEqual(tunnel.findCloudflaredBinary(f), f); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('quick mode catches url', async () => {
  const p = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  assert.strictEqual(procs.length, 1);
  procs[0].stdout.emit('data', Buffer.from('INF https://abc-def.trycloudflare.com ready'));
  const r = await p;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://abc-def.trycloudflare.com');
  assert.strictEqual(tunnel.getTunnelStatus().mode, 'quick');
});
test('bad token fails fast', async () => {
  const p = tunnel.startTunnel({ port: 7799, tunnelToken: 'bad', stableMs: 10 });
  procs[0].stderr.emit('data', Buffer.from('failed to parse token'));
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.match(tunnel.getTunnelStatus().error, /Token/);
});
test('ENOENT no restart', async () => {
  const p = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  const err = new Error('spawn ENOENT');
  err.code = 'ENOENT';
  procs[0].emit('error', err);
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.match(tunnel.getTunnelStatus().error, /cloudflared/);
});
test('stopTunnel kills proc', async () => {
  const p = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  procs[0].stdout.emit('data', Buffer.from('https://stop.trycloudflare.com'));
  await p;
  assert.strictEqual(tunnel.getTunnelStatus().running, true);
  const sp = tunnel.stopTunnel();
  procs[0].emit('exit', 0, null);
  await sp;
  assert.strictEqual(tunnel.getTunnelStatus().running, false);
  assert.strictEqual(procs[0].killed, true);
});
test('old gen exit ignored', async () => {
  const p1 = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  procs[0].stdout.emit('data', Buffer.from('https://old.trycloudflare.com'));
  await p1;
  const sp = tunnel.stopTunnel();
  procs[0].emit('exit', 0, null);
  await sp;
  const p2 = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  procs[1].stdout.emit('data', Buffer.from('https://new.trycloudflare.com'));
  const r2 = await p2;
  assert.strictEqual(r2.url, 'https://new.trycloudflare.com');
  procs[0].emit('exit', 1, null);
  const st = tunnel.getTunnelStatus();
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.url, 'https://new.trycloudflare.com');
});
test('buildEdgeArgs formats ip:port', () => {
  assert.deepStrictEqual(tunnel.buildEdgeArgs(['1.2.3.4', '5.6.7.8']),
    ['--edge', '1.2.3.4:7844', '--edge', '5.6.7.8:7844']);
  assert.deepStrictEqual(tunnel.buildEdgeArgs([]), []);
  assert.deepStrictEqual(tunnel.buildEdgeArgs(null), []);
});
test('resolveEdgeIps empty server returns []', async () => {
  const r = await tunnel.resolveEdgeIps('');
  assert.deepStrictEqual(r, []);
});
test('startTunnel no edge args by default', async () => {
  const calls = [];
  tunnel._setSpawnForTesting((bin, args) => {
    calls.push({ bin, args });
    const p = new EventEmitter();
    p.pid = 1; p.killed = false; p.exitCode = null;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.exitCode = 0; return true; };
    procs.push(p);
    return p;
  });
  const p = tunnel.startTunnel({ port: 7799, stableMs: 10 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].args.includes('--edge'));
  procs[0].stdout.emit('data', Buffer.from('https://x.trycloudflare.com'));
  const r = await p;
  assert.strictEqual(r.ok, true);
});
test('win32 candidates include repo resources path', () => {
  const out = tunnel.buildCloudflaredCandidates('win32', {}, '');
  const hasRepoRes = out.some((p) => typeof p === 'string' && p.indexOf('resources') >= 0 && p.indexOf('cloudflared') >= 0);
  assert.ok(hasRepoRes);
});
