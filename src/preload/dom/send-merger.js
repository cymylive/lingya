/**
 * 自动消息合并缓冲（2026-10-29）
 *
 * 【要解决的问题】一轮交互里若有多条自动消息几乎同时到达（多个工具各自回传、
 * 工具回传 + AutoRename 撞车），每次调用都会往输入框注入一个 lingya-input.md。
 * 由于上传后要等 2.5~9 秒才 triggerSend，这段窗口里所有调用叠加 →
 * 用户看到同一个输入框挂着 5 个 .md，一次全发出去。
 *
 * 【解法】把「上传时机」从调用时推迟到窗口结束时：
 *   A 到达 → 只记内容，不碰 DOM
 *   B 到达 → 只记内容，不碰 DOM
 *   窗口结束 → 内容按顺序拼接 → 只调用 sender 一次
 * 内容全部保留（用 \n\n---\n\n 分隔），不丢任何一段。
 *
 * 【为什么单独成模块】合并调度是纯逻辑（计时、排队、异常复位），
 * 内联在 chat-input.js 里既依赖 DOM 又拿不到 sender，无法单测。
 * 抽出来后 sender 可注入、窗口时长可配，测试能覆盖全部分支。
 */

const DEFAULT_WINDOW_MS = 800;
const SEPARATOR = '\n\n---\n\n';

/**
 * @param {object} options
 * @param {(msg: string, tag: string, afterSent: Function, opts: any) => Promise<boolean>} options.send
 *        真正的发送函数（chat-input 里传 doSendToChat）
 * @param {number} [options.windowMs] 合并窗口毫秒数，默认 800
 * @param {(msg: string) => void} [options.log] 日志函数，默认 console.log
 * @param {(msg: string) => void} [options.warn] 警告函数，默认 console.warn
 * @param {boolean} [options.autoTimer] 是否自动用 setTimeout 计时。测试传 false 手动 flush。
 */
function createSendMerger(options) {
  const opts = options || {};
  if (typeof opts.send !== 'function') {
    throw new Error('createSendMerger 需要 send 函数');
  }
  const send = opts.send;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs : DEFAULT_WINDOW_MS;
  const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
  const warn = typeof opts.warn === 'function' ? opts.warn : (m) => console.warn(m);
  const autoTimer = opts.autoTimer !== false;

  let buffer = null;          // { items: [], waiters: [], timer: any }
  let sending = false;        // 发送进行中标志

  function startTimer() {
    if (!buffer || buffer.timer || sending) return;
    if (!autoTimer) return;
    buffer.timer = setTimeout(() => { flush(); }, windowMs);
  }

  /**
   * 入队一条自动消息，返回 Promise<boolean>（发送结果）。
   */
  function enqueue(msg, tag, afterSent, msgOpts) {
    return new Promise((resolve) => {
      if (!buffer) buffer = { items: [], waiters: [], timer: null };
      buffer.items.push({ msg, tag, afterSent, opts: msgOpts });
      buffer.waiters.push(resolve);
      log('[合并] 入队第 ' + buffer.items.length + ' 条自动消息（' +
        (tag || '无tag') + '，' + String(msg).length + ' 字符）' +
        (sending ? '（上一次发送进行中，继续排队）' : ''));
      startTimer();
    });
  }

  async function flush() {
    const batch = buffer;
    buffer = null;
    if (!batch || batch.items.length === 0) return false;

    if (batch.timer) { try { clearTimeout(batch.timer); } catch (_) {} }
    sending = true;

    let ok = false;
    try {
      const items = batch.items;
      const mergedMsg = items.map((i) => i.msg).join(SEPARATOR);
      const mergedTag = items.map((i) => i.tag).filter(Boolean).join('+') || '';
      const sendOpts = items[0].opts;

      const afterAll = () => {
        for (const i of items) {
          if (typeof i.afterSent === 'function') {
            try { i.afterSent(); } catch (_) { /* ignore */ }
          }
        }
      };

      if (items.length > 1) {
        log('[合并] 窗口结束：' + items.length + ' 条合并为 1 个附件，总长 ' +
          mergedMsg.length + ' 字符（原各自长度: ' +
          items.map((i) => String(i.msg).length).join('/') + '）');
      }

      ok = await send(mergedMsg, mergedTag, afterAll, sendOpts);
    } catch (e) {
      warn('[合并] 合并发送异常: ' + (e && e.message));
      ok = false;
    } finally {
      // 必须：异常时也要放行 waiters 并复位 sending，否则通道永久卡死
      for (const w of batch.waiters) {
        try { w(ok); } catch (_) { /* ignore */ }
      }
      sending = false;
      // 发送期间若有新消息入队，为新批次重新启动窗口计时
      if (buffer && buffer.items.length > 0) {
        if (buffer.timer) { try { clearTimeout(buffer.timer); } catch (_) {} buffer.timer = null; }
        startTimer();
        log('[合并] 上一次发送完成，' + buffer.items.length + ' 条待发消息启动新窗口');
      }
    }
    return ok;
  }

  /** 仅测试用：查看内部状态 */
  function _debugState() {
    return {
      pending: buffer ? buffer.items.length : 0,
      sending,
      hasTimer: !!(buffer && buffer.timer),
    };
  }

  /** 仅测试用：清空所有状态（含未触发的计时器） */
  function _reset() {
    if (buffer && buffer.timer) { try { clearTimeout(buffer.timer); } catch (_) {} }
    buffer = null;
    sending = false;
  }

  return { enqueue, flush, _debugState, _reset };
}

module.exports = { createSendMerger, DEFAULT_WINDOW_MS, SEPARATOR };
