const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregateWorkspaces } = require('../../src/main/workspace-aggregator');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-ws-')); }

function setupStores(dir, stores) {
  for (const [pid, data] of Object.entries(stores)) {
    fs.writeFileSync(path.join(dir, 'session-dir-map-' + pid + '.json'), JSON.stringify(data), 'utf-8');
  }
}

test('聚合多个 profile 的会话', () => {
  const dir = tmpDir();
  setupStores(dir, {
    p1: { s1: { projectDir: 'D:/projA', title: 'A会话', updatedAt: '2026-01-01T00:00:00Z' } },
    p2: { s2: { projectDir: 'D:/projB', title: 'B会话', updatedAt: '2026-01-02T00:00:00Z' } },
  });
  const profiles = [{ id: 'p1', name: '窗口1' }, { id: 'p2', name: '窗口2' }];
  const r = aggregateWorkspaces(dir, 'p1', profiles);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.sessions.length, 2);
  const s2 = r.sessions.find(s => s.sessionId === 's2');
  assert.strictEqual(s2.profileId, 'p2');
  assert.strictEqual(s2.profileName, '窗口2');
});

test('同 sessionId 跨 profile 去重，取最新 updatedAt', () => {
  const dir = tmpDir();
  setupStores(dir, {
    p1: { s1: { projectDir: 'D:/a', title: '旧', updatedAt: '2026-01-01T00:00:00Z' } },
    p2: { s1: { projectDir: 'D:/a', title: '新', updatedAt: '2026-02-01T00:00:00Z' } },
  });
  const r = aggregateWorkspaces(dir, 'p1', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.sessions.length, 1);
  assert.strictEqual(r.sessions[0].title, '新');
});

test('损坏的 session 文件被跳过，不影响其他 profile', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'session-dir-map-p1.json'), 'NOT_JSON{{{', 'utf-8');
  setupStores(dir, {
    p2: { s2: { projectDir: 'D:/b', title: 'ok' } },
  });
  const r = aggregateWorkspaces(dir, 'p2', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.sessions.length, 1);
  assert.strictEqual(r.sessions[0].sessionId, 's2');
});

test('归档项目列表合并去重', () => {
  const dir = tmpDir();
  setupStores(dir, {
    p1: { __project_archived__: { 'D:/old': '2026-01-01T00:00:00Z' }, s1: { projectDir: 'D:/a', title: 't' } },
    p2: { __project_archived__: { 'D:/old2': '2026-01-02T00:00:00Z' }, s2: { projectDir: 'D:/b', title: 't' } },
  });
  const r = aggregateWorkspaces(dir, 'p1', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.archivedProjects.length, 2);
});

test('会话级归档状态取 OR（任一处归档即归档）', () => {
  const dir = tmpDir();
  setupStores(dir, {
    p1: { s1: { projectDir: 'D:/a', title: 't', archivedAt: null } },
    p2: { s1: { projectDir: 'D:/a', title: 't', archivedAt: '2026-01-01T00:00:00Z' } },
  });
  const r = aggregateWorkspaces(dir, 'p1', [{ id: 'p1', name: 'W1' }, { id: 'p2', name: 'W2' }]);
  assert.strictEqual(r.sessions[0].archived, true);
});

test('空目录返回空结果而不是崩溃', () => {
  const r = aggregateWorkspaces(tmpDir(), 'p1', []);
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.sessions, []);
  assert.deepStrictEqual(r.archivedProjects, []);
});
