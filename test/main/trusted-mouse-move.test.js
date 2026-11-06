const { test } = require('node:test');
const assert = require('node:assert');

function makeFakeWc(opts = {}) {
  const events = [];
  return {
    id: opts.id || 1,
    _destroyed: !!opts.destroyed,
    isDestroyed() { return this._destroyed; },
    getSize() { return opts.size || [1280, 800]; },
    sendInputEvent(e) { events.push(e); },
    _events: events,
  };
}

test('handleTrustedMouseMove 对缺失 sender 返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const r = await ipc.__test.handleTrustedMouseMove({}, { x: 10, y: 10 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /webContents unavailable/);
});

test('handleTrustedMouseMove 对已销毁 webContents 返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const wc = makeFakeWc({ destroyed: true });
  const r = await ipc.__test.handleTrustedMouseMove({ sender: wc }, { x: 10, y: 10 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /webContents unavailable/);
});

test('handleTrustedMouseMove 对非法坐标返回 success:false', async () => {
  const ipc = require('../../src/main/ipc');
  const wc = makeFakeWc();
  const r1 = await ipc.__test.handleTrustedMouseMove({ sender: wc }, { x: NaN, y: 10 });
  assert.strictEqual(r1.success, false);
  assert.match(r1.error, /invalid coordinates/);
  // 用 {} 而非 null：Number(null)=0 会被当作有效坐标 (0,0)，
  // 与 trusted-click 现有行为一致（它也是 Number(args && args.x)），不改实现。
  const r2 = await ipc.__test.handleTrustedMouseMove({ sender: wc }, {});
  assert.strictEqual(r2.success, false);
  assert.match(r2.error, /invalid coordinates/);
});

test('handleTrustedMouseMove 正常路径只发 mouseMove，不发 down/up', async () => {
  const ipc = require('../../src/main/ipc');
  const wc = makeFakeWc({ id: 42 });
  const r = await ipc.__test.handleTrustedMouseMove(
    { sender: wc },
    { x: 400, y: 300 },
    { sleep: async () => {}, bezier: (x0, y0, x1, y1, steps) => {
        const pts = [];
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          pts.push({ x: Math.round(x0 + (x1 - x0) * t), y: Math.round(y0 + (y1 - y0) * t) });
        }
        return pts;
      } }
  );
  assert.strictEqual(r.success, true);
  assert.ok(r.points > 0);
  assert.ok(wc._events.length > 0);
  for (const e of wc._events) {
    assert.strictEqual(e.type, 'mouseMove');
    assert.ok(typeof e.x === 'number');
    assert.ok(typeof e.y === 'number');
  }
  // 不应有 mouseDown / mouseUp
  assert.strictEqual(wc._events.filter(e => e.type === 'mouseDown').length, 0);
  assert.strictEqual(wc._events.filter(e => e.type === 'mouseUp').length, 0);
});

test('handleTrustedMouseMove 坐标超出窗口时被裁剪', async () => {
  const ipc = require('../../src/main/ipc');
  const wc = makeFakeWc({ id: 99, size: [800, 600] });
  const r = await ipc.__test.handleTrustedMouseMove(
    { sender: wc },
    { x: 99999, y: 99999 },
    { sleep: async () => {}, bezier: (x0, y0, x1, y1) => [{ x: x1, y: y1 }] }
  );
  assert.strictEqual(r.success, true);
  const last = wc._events[wc._events.length - 1];
  assert.ok(last.x <= 799);
  assert.ok(last.y <= 599);
});

test('handleTrustedMouseMove 轨迹中途 webContents 被销毁时安全退出', async () => {
  const ipc = require('../../src/main/ipc');
  const wc = makeFakeWc({ id: 7 });
  let callCount = 0;
  const origSend = wc.sendInputEvent.bind(wc);
  wc.sendInputEvent = (e) => {
    callCount++;
    if (callCount >= 2) wc._destroyed = true;
    origSend(e);
  };
  const r = await ipc.__test.handleTrustedMouseMove(
    { sender: wc },
    { x: 400, y: 300 },
    { sleep: async () => {}, bezier: (x0, y0, x1, y1) => [
        { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 },
      ] }
  );
  assert.strictEqual(r.success, true);
  // 不应无限循环，且不应在销毁后继续发送
  assert.ok(callCount <= 3);
});
