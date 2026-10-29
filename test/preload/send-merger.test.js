/**
 * 自动消息合并缓冲单测
 *
 * 背景：一轮交互里多条自动消息（工具回传等）几乎同时到达，每条都上传一个
 * lingya-input.md，导致同一输入框挂着多个附件。解法是把上传推迟到窗口结束，
 * 窗口内多条合并成一份。
 *
 * 本测试覆盖调度逻辑本身：合并、排队、异常复位、afterSent 语义、边界。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { createSendMerger, SEPARATOR } = require('../../src/preload/dom/send-merger');

/** 构造一个记录调用的假 sender */
function makeSender(result, opts) {
  opts = opts || {};
  const calls = [];
  const sender = async (msg, tag, afterSent, sendOpts) => {
    calls.push({ msg, tag, afterSent, sendOpts });
    if (typeof opts.beforeResolve === 'function') await opts.beforeResolve();
    if (opts.throwError) throw new Error(opts.throwError);
    return result === undefined ? true : result;
  };
  return { sender, calls };
}

const silent = { log: () => {}, warn: () => {} };

test('窗口内多条合并为一次发送，内容按顺序用分隔符拼接', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  m.enqueue('AAA', 't1', null, { auto: true });
  m.enqueue('BBB', 't2', null, { auto: true });
  m.enqueue('CCC', 't3', null, { auto: true });

  assert.strictEqual(m._debugState().pending, 3);
  await m.flush();

  assert.strictEqual(calls.length, 1, '只应调用一次 sender');
  assert.strictEqual(calls[0].msg, 'AAA' + SEPARATOR + 'BBB' + SEPARATOR + 'CCC');
  assert.strictEqual(calls[0].tag, 't1+t2+t3');
  assert.strictEqual(m._debugState().pending, 0);
  assert.strictEqual(m._debugState().sending, false);
});

test('只有一条时原样发送，不加分隔符', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  m.enqueue('single', 'tag', null, { auto: true });
  await m.flush();

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].msg, 'single');
  assert.strictEqual(calls[0].tag, 'tag');
});

test('所有入队者的 Promise 都会 resolve，值为发送结果', async () => {
  const { sender } = makeSender(true);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  const p1 = m.enqueue('A', 't1', null, {});
  const p2 = m.enqueue('B', 't2', null, {});
  await m.flush();

  assert.strictEqual(await p1, true);
  assert.strictEqual(await p2, true);
});

test('sender 返回 false 时所有 Promise 也 resolve 为 false', async () => {
  const { sender } = makeSender(false);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  const p1 = m.enqueue('A', 't1', null, {});
  const p2 = m.enqueue('B', 't2', null, {});
  await m.flush();

  assert.strictEqual(await p1, false);
  assert.strictEqual(await p2, false);
});

test('sender 抛异常时 Promise 仍 resolve（false），sending 标志复位', async () => {
  const { sender } = makeSender(true, { throwError: 'boom' });
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  const p = m.enqueue('A', 't1', null, {});
  await m.flush();

  assert.strictEqual(await p, false, '异常应被吞掉并 resolve(false)');
  assert.strictEqual(m._debugState().sending, false, 'sending 必须复位，否则通道永久卡死');
});

test('合并后传给 sender 的 afterSent 会依次触发全部原回调', async () => {
  const calls = [];
  const sender = async (msg, tag, afterSent) => { calls.push({ msg, tag, afterSent }); return true; };
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  const order = [];
  m.enqueue('A', 't1', () => order.push('a'), {});
  m.enqueue('B', 't2', () => order.push('b'), {});

  await m.flush();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(order.length, 0, 'afterSent 由 sender 决定何时调用');
  calls[0].afterSent();
  assert.deepStrictEqual(order, ['a', 'b']);
});

test('发送期间入队的新消息不会叠加进当前批次', async () => {
  let releaseSender;
  const gate = new Promise((r) => { releaseSender = r; });
  const calls = [];
  const sender = async (msg, tag) => {
    calls.push({ msg, tag });
    await gate;
    return true;
  };
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  m.enqueue('FIRST', 't1', null, {});
  const flushing = m.flush();

  const p2 = m.enqueue('SECOND', 't2', null, {});
  assert.strictEqual(m._debugState().sending, true);
  assert.strictEqual(m._debugState().pending, 1, '新消息应进入新批次');

  releaseSender();
  await flushing;

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].msg, 'FIRST');

  await m.flush();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].msg, 'SECOND');
  assert.strictEqual(await p2, true);
});

test('空 buffer 调用 flush 不报错、不调用 sender', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  await m.flush();
  assert.strictEqual(calls.length, 0);
});

test('缺少 send 函数时创建即抛错', () => {
  assert.throws(() => createSendMerger({}), /需要 send 函数/);
  assert.throws(() => createSendMerger(), /需要 send 函数/);
});

test('autoTimer 模式下窗口到期自动 flush', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, windowMs: 50, ...silent });

  const p1 = m.enqueue('A', 't1', null, {});
  const p2 = m.enqueue('B', 't2', null, {});

  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].msg, 'A' + SEPARATOR + 'B');
  assert.strictEqual(await p1, true);
  assert.strictEqual(await p2, true);
});

test('窗口计时器只启动一次，后续入队不重置计时', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, windowMs: 80, ...silent });

  m.enqueue('A', 't1', null, {});
  const firstTimer = m._debugState().hasTimer;
  m.enqueue('B', 't2', null, {});
  const secondTimer = m._debugState().hasTimer;

  assert.strictEqual(firstTimer, true);
  assert.strictEqual(secondTimer, true);

  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(calls.length, 1, '不应因第二次入队而重开窗口导致多发');
});

test('_reset 清空状态与计时器', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, windowMs: 1000, ...silent });

  m.enqueue('A', 't1', null, {});
  assert.strictEqual(m._debugState().pending, 1);
  m._reset();
  assert.strictEqual(m._debugState().pending, 0);
  assert.strictEqual(m._debugState().hasTimer, false);

  await m.flush();
  assert.strictEqual(calls.length, 0);
});

test('tag 为空或缺失时合并 tag 为空串', async () => {
  const { sender, calls } = makeSender(true);
  const m = createSendMerger({ send: sender, autoTimer: false, ...silent });

  m.enqueue('A', null, null, {});
  m.enqueue('B', '', null, {});
  await m.flush();

  assert.strictEqual(calls[0].tag, '');
});
