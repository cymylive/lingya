'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rot = require('../../src/main/token-rotation');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'token-rotation-ipc-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  rot.init(tmpDir);
  rot._resetForTest();
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildCandidates 标注存在性与忙碌', () => {
  const profiles = [
    { id: 'p1', name: '窗口1' },
    { id: 'p2', name: '窗口2' },
  ];
  const cfg = rot.getConfig();
  const getCtx = (id) => (id === 'p1' ? { profileId: 'p1' } : null);
  const isBusy = (id) => id === 'p1';
  const out = rot.buildCandidates(profiles, cfg, getCtx, isBusy);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { profileId: 'p1', name: '窗口1', accountTag: '', exists: true, busy: true });
  assert.equal(out[1].exists, false);
  assert.equal(out[1].busy, false);
});

test('buildCandidates 从配置 pool 里取 accountTag', () => {
  rot.updateConfig({ pool: [{ profileId: 'p2', accountTag: 'acc-B', enabled: true }] });
  const profiles = [{ id: 'p1', name: '窗口1' }, { id: 'p2', name: '窗口2' }];
  const out = rot.buildCandidates(profiles, rot.getConfig(), () => null, () => false);
  assert.equal(out[0].accountTag, '');
  assert.equal(out[1].accountTag, 'acc-B');
});

test('buildCandidates 容忍非数组 profiles', () => {
  assert.deepEqual(rot.buildCandidates(null, rot.getConfig(), () => null, () => false), []);
});
