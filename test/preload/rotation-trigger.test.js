
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const OVERLAY = path.resolve(__dirname, '../../src/preload/overlay');
const DOM = path.resolve(__dirname, '../../src/preload/dom');
const EVENTS = path.join(OVERLAY, 'events.js');

function stub(absPath, exports) {
  const m = new Module(absPath, null);
  m.filename = absPath; m.loaded = true; m.exports = exports;
  require.cache[absPath] = m;
}

function clearAll() {
  const mods = ['events.js', 'ui.js', 'memory-panel.js', 'skill-panel.js', 'security-panel.js',
    'feishu-panel.js', 'weixin-panel.js', 'comm-panel.js', 'qq-panel.js', 'schedule-panel.js',
    'agent-panel.js', 'plan-panel.js'];
  for (const f of mods) delete require.cache[path.join(OVERLAY, f)];
  const doms = ['state.js', 'session-list.js', 'chat-input.js', 'compaction.js',
    'conversation-log.js', 'deepseek-history-archiver.js', 'intercept-observer.js'];
  for (const f of doms) delete require.cache[path.join(DOM, f)];
  delete require.cache[path.resolve(__dirname, '../../src/providers/index.js')];
}

/**
 * 加载 events.js 并触发 checkAutoCompact 的触发路径。
 * 通过 stub 各依赖来观察 runMigration / runRotationMigration 的行为。
 */
function load(opts) {
  const o = opts || {};
  const calls = { newChat: 0, deleteSession: [], submit: [], toasts: [], waitCalls: 0 };

  global.window = {
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc123' },
    electronAPI: {
      clearAbort: () => {},
      newChat: async () => { calls.newChat++; },
      rotationGetConfig: async () => ({ success: true, config: { enabled: o.rotationEnabled === true, thresholdWan: (typeof o.rotationThresholdWan === 'number' ? o.rotationThresholdWan : 0.1), historyMaxBytes: 2097152 } }),
      rotationSubmit: async (data) => {
        calls.submit.push(data);
        return o.submitResult || { success: true, requestId: 'r1', targetProfileId: 'p2' };
      },
      onRotationResult: (cb) => { calls.resultCb = cb; return () => {}; },
    },
  };
  const lsEntries = o.disableLegacySwitch
    ? [['lingya-auto-compact-threshold', '0.1']]
    : [['lingya-auto-compact-enabled', '1'], ['lingya-auto-compact-threshold', '0.1']];
  // 轮转缓存键：checkAutoCompact 同步读这两个，不再每秒 IPC
  if (o.rotationEnabled === true) {
    lsEntries.push(['lingya-rotation-enabled', '1']);
    lsEntries.push(['lingya-rotation-threshold', String(typeof o.rotationThresholdWan === 'number' ? o.rotationThresholdWan : 0.1)]);
  }
  global.localStorage = {
    _m: new Map(lsEntries),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  global.document = { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
  global.setInterval = () => 0;

  clearAll();

  // ---- stubs ----
  stub(path.join(OVERLAY, 'ui.js'), {
    hideOverlay: () => {}, showOverlay: () => {}, renderHistory: () => {},
    commandHistory: [], showToast: (m) => calls.toasts.push(m),
    showConfirmDialog: () => {}, hideFirstTimeDialog: () => {},
    setStopped: () => {}, clearBackgroundTasks: () => {}, setFabSize: () => {},
    closeMemoryManager: () => {}, closeSkillManager: () => {}, closeSecurityManager: () => {},
    closeFeishuManager: () => {}, closeWeixinManager: () => {}, closeQqManager: () => {},
    closeCommManager: () => {}, closeScheduleManager: () => {},
  });
  for (const p of ['memory-panel', 'skill-panel', 'security-panel', 'feishu-panel',
    'weixin-panel', 'comm-panel', 'qq-panel', 'schedule-panel', 'agent-panel', 'plan-panel']) {
    const name = 'bind' + p.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('') + 'Events';
    stub(path.join(OVERLAY, p + '.js'), { [name]: () => {}, closeMemoryManager: () => {}, closeSkillManager: () => {}, closeSecurityManager: () => {}, closeFeishuManager: () => {}, closeWeixinManager: () => {}, closeQqManager: () => {}, closeCommManager: () => {}, closeScheduleManager: () => {} });
  }
  stub(path.join(DOM, 'session-list.js'), { handleInitProject: () => {}, renderSessions: () => {} });
  stub(path.join(DOM, 'chat-input.js'), {
    sendToChat: () => {}, sendMessageToChat: (msg) => { calls.lastSent = msg; },
  });
  stub(path.join(DOM, 'compaction.js'), { runCompaction: () => {}, checkPendingInit: () => {} });
  stub(path.join(DOM, 'state.js'), {
    serverTokenUsage: { accumulatedTokens: (typeof o.tokens === 'number' ? o.tokens : 5000) },
    serverTokenUsageBySession: {}, tokenBaseline: {},
    isMigrating: false, migratingAt: 0,
    currentProjectDir: 'D:/proj',
    currentSessionId: 'sess-abc',
    stopped: false, stoppedAt: 0,
  });
  stub(path.join(DOM, 'conversation-log.js'), {
    getEntries: () => [{ role: 'user', content: 'hi' }],
    buildMarkdown: () => 'HISTORY_MD',
    clearEntries: () => {},
  });
  stub(path.join(DOM, 'deepseek-history-archiver.js'), {
    deleteSessionSilent: (sid) => { calls.deleteSession.push(sid); return Promise.resolve(true); },
  });
  stub(path.join(DOM, 'intercept-observer.js'), {
    // 立即回调，模拟 AI 已回复收尾摘要（否则会等满 120s 超时）
    onInterceptedResponse: (cb) => {
      calls.interceptCb = cb;
      setTimeout(() => { try { cb('SUMMARY'); } catch (_) {} }, 0);
      return () => {};
    },
    startInterceptObserver: () => {},
  });
  stub(path.resolve(__dirname, '../../src/providers/index.js'), {
    getProviderByUrl: () => ({ extractSessionId: () => 'sess-abc', homeUrl: 'https://chat.deepseek.com' }),
  });

  let mod = null, loadErr = null;
  try { mod = require(EVENTS); } catch (e) { loadErr = e; }
  return { mod, calls, loadErr };
}

beforeEach(() => { clearAll(); });

test('events.js 可加载（新增代码不破坏现有依赖图）', () => {
  const { loadErr } = load();
  assert.equal(loadErr, null, '加载失败: ' + (loadErr && loadErr.stack));
});

test('runRotationMigration 会被导出供测试', () => {
  const { mod } = load();
  assert.equal(typeof mod.runRotationMigration, 'function');
});


test('轮转未启用时走原地迁移（不提交轮转）', async () => {
  const { mod, calls } = load({ rotationEnabled: false });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.submit.length, 0, '未启用不应调用 rotationSubmit');
  assert.equal(calls.newChat, 1, '原地迁移会切新会话');
});

test('轮转启用但 no-target 时回落原地迁移', async () => {
  const { mod, calls } = load({
    rotationEnabled: true,
    submitResult: { success: false, reason: 'no-target' },
  });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.submit.length, 1, '应该尝试过轮转提交');
  assert.equal(calls.newChat, 1, '失败后回落原地迁移');
  assert.deepEqual(calls.deleteSession, [], '失败路径绝不能删会话');
});

test('轮转 ack 成功后才删旧会话，失败则不删', async () => {
  const { mod, calls } = load({ rotationEnabled: true });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.submit.length, 1);
  // 此时还没收到 ack，绝不能删
  assert.deepEqual(calls.deleteSession, [], 'ack 之前不许删会话');
  // 主进程回告成功
  calls.resultCb({ ok: true, requestId: 'r1', targetProfileId: 'p2' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.deleteSession, ['sess-abc'], 'ack 成功后删旧会话');
});

test('轮转 ack 失败时绝不删旧会话', async () => {
  const { mod, calls } = load({ rotationEnabled: true });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 50));
  calls.resultCb({ ok: false, requestId: 'r1', reason: 'timeout' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.deleteSession, [], '失败路径绝不能删会话');
});


test('bindRotationEvents 已导出且可调用', () => {
  const { mod } = load();
  assert.equal(typeof mod.bindRotationEvents, 'function');
  // 无 DOM 元素时不能抛错
  mod.bindRotationEvents();
});



// ===== 回归：轮转不能依赖旧「自动压缩」开关 =====
test('旧自动压缩开关关闭时，轮转仍能触发（不被旧门槛挡住）', async () => {
  const { mod, calls } = load({ rotationEnabled: true, disableLegacySwitch: true });
  // 旧开关必须处于关闭状态
  assert.equal(global.localStorage.getItem('lingya-auto-compact-enabled'), null, '前提：旧开关未开');
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.submit.length, 1, '轮转应被触发，不能因旧开关关闭而被挡');
});

test('轮转启用时使用轮转阈值，而非旧阈值', async () => {
  const { mod, calls } = load({ rotationEnabled: true, disableLegacySwitch: true, tokens: 3000 });
  // 轮转阈值 0.1 万 = 1000 token，当前 3000 token 应触发
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.submit.length, 1, '按轮转阈值 1000 应触发');
});

test('轮转未达自身阈值时不触发（哪怕旧阈值更低）', async () => {
  const { mod, calls } = load({ rotationEnabled: true, disableLegacySwitch: true, tokens: 500, rotationThresholdWan: 10 });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.submit.length, 0, '500 token < 10 万，不该触发');
});

test('轮转关闭时旧开关行为完全不变', async () => {
  const { mod, calls } = load({ rotationEnabled: false, tokens: 5000 });
  mod.checkAutoCompact();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.submit.length, 0, '轮转关闭不应走轮转');
  assert.equal(calls.newChat, 1, '旧链路照常执行');
});
