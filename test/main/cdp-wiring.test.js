const { test } = require('node:test');
const assert = require('node:assert');

test('cdp-enable 对不存在的 provider 返回 ok:false', async () => {
  const handler = require('../../src/main/cdp-wiring').__test.handleEnable;
  const r = await handler({ sender: { id: 1, isDestroyed: () => false } }, { providerId: 'nope' });
  assert.strictEqual(r.ok, false);
});

test('cdp-enable 对不存在 useCdp 的 provider 返回 ok:false', async () => {
  const handler = require('../../src/main/cdp-wiring').__test.handleEnable;
  const r = await handler({ sender: { id: 1, isDestroyed: () => false } }, { providerId: 'claude' });
  assert.strictEqual(r.ok, false);
});
