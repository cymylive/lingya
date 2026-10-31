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

test('isCdpSupported 对 deepseek 返回 true（provider 注册表查找正确）', () => {
  const wiring = require('../../src/main/cdp-wiring');
  assert.strictEqual(wiring.isCdpSupported('deepseek'), true);
  assert.strictEqual(wiring.isCdpSupported('claude'), false);
  assert.strictEqual(wiring.isCdpSupported('nonexistent'), false);
});

test('cdp-enable 对缺失 providerId 返回 ok:false', async () => {
  const handler = require('../../src/main/cdp-wiring').__test.handleEnable;
  const r = await handler({ sender: { id: 1, isDestroyed: () => false } }, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /providerId/);
});
