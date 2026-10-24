/**
 * 聊天输入框交互：查找输入框、填入与发送消息、工具结果回传
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { ipcRenderer } = require('electron');
const state = require('./state');
const { BT } = require('./js-detector');
const { getProviderByUrl } = require('../../../src/providers');
const taskState = require('./task-state');

/**
 * 根据当前 URL 获取 provider
 */
function getCurrentProvider() {
  return getProviderByUrl(window.location.href);
}

/**
 * 首条消息兜底延迟（ms）：尚无 AI 思考历史时使用。
 * 后续消息一律走「思考耗时自适应延迟」。
 */
function initialDelay() {
  const d = Number(state.initialSendDelay);
  return (Number.isFinite(d) && d >= 0) ? d : 1000;
}
// 启动时从 localStorage 恢复「思考耗时自适应延迟」配置
(function restoreThinkDelayConfig() {
  try {
    const init = localStorage.getItem('lingya-initial-send-delay');
    if (init !== null) {
      const n = parseInt(init, 10);
      if (Number.isFinite(n) && n >= 0) state.initialSendDelay = n;
    }
    const r = localStorage.getItem('lingya-think-ratio');
    const m = localStorage.getItem('lingya-think-max-delay');
    if (r !== null) {
      const n = parseFloat(r);
      if (Number.isFinite(n) && n >= 0) state.thinkRatio = n;
    }
    if (m !== null) {
      const n = parseInt(m, 10);
      if (Number.isFinite(n) && n >= 0) state.thinkMaxDelay = n;
    }
    // 双策略延迟配置
    // 快请求延迟区间：优先读新键；只有旧键时迁移为 min=max（老用户配置不丢）
    const gmin = localStorage.getItem('lingya-global-send-delay-min');
    const gmax = localStorage.getItem('lingya-global-send-delay-max');
    const gold = localStorage.getItem('lingya-global-send-delay');
    const t = localStorage.getItem('lingya-adaptive-threshold');
    if (gmin !== null || gmax !== null) {
      const a = parseInt(gmin, 10);
      const b = parseInt(gmax, 10);
      if (Number.isFinite(a) && a >= 0) state.globalSendDelayMin = a;
      if (Number.isFinite(b) && b >= 0) state.globalSendDelayMax = b;
    } else if (gold !== null) {
      const n = parseInt(gold, 10);
      if (Number.isFinite(n) && n >= 0) {
        state.globalSendDelayMin = n;
        state.globalSendDelayMax = n;
      }
    }
    if (t !== null) {
      const n = parseInt(t, 10);
      if (Number.isFinite(n) && n >= 0) state.adaptiveThreshold = n;
    }
  } catch (_) { /* ignore */ }
})();

/**
 * 计算「思考耗时自适应延迟」（毫秒）。
 * 规则：延迟 = min(上次思考耗时 × thinkRatio, thinkMaxDelay)。
 * 思考越久说明负载越重，下一条就等越久，从根源避开频率风控。
 * 无历史（首次发送）时返回 0，由调用方回落到随机基础延迟。
 */
function computeThinkAdaptiveDelay() {
  const ratio = Number(state.thinkRatio) || 0;
  const maxDelay = Number(state.thinkMaxDelay) || 0;
  const thinkMs = Number(state.lastThinkMs) || 0;
  if (ratio <= 0 || thinkMs <= 0) return 0;
  const d = Math.floor(thinkMs * ratio);
  return maxDelay > 0 ? Math.min(d, maxDelay) : d;
}

/**
 * 计算快请求发送延迟：在 [globalSendDelayMin, globalSendDelayMax] 闭区间内均匀随机。
 * min === max 时退化为固定值（与旧行为一致）。
 * min > max 时自动交换（UI 已校验，此处兜底，避免卡死发送）。
 */
function pickGlobalDelay() {
  let min = Number(state.globalSendDelayMin);
  let max = Number(state.globalSendDelayMax);
  if (!Number.isFinite(min) || min < 0) min = 3000;
  if (!Number.isFinite(max) || max < 0) max = min;
  if (min > max) { const t = min; min = max; max = t; }
  if (min === max) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 将文本填入输入框（React 兼容：使用原生 value setter）
 * @param {Element} input - 输入框元素
 * @param {string} msg - 要填入的文本
 * @returns {boolean} 是否成功填入
 */
/**
 * 可信点击：通过主进程 sendInputEvent 注入真实鼠标事件（isTrusted = true）。
 *
 * 【禁止合成事件降级】原先 trustedClick 失败会回退到 el.click()，
 * 合成事件的 isTrusted 恒为 false —— 这正是平台识别脚本操作最直接的信号。
 * 宁可发送失败让用户看到明确报错，也不要静默降级成假输入。
 */
async function trustedClickElement(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    console.warn('[LingYa] 可信点击失败：目标元素不可用');
    return false;
  }
  const r = el.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) {
    console.warn('[LingYa] 可信点击失败：目标元素无尺寸');
    return false;
  }
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const api = window.electronAPI;
  if (!api || typeof api.trustedClick !== 'function') {
    console.warn('[LingYa] 可信点击不可用：electronAPI.trustedClick 缺失');
    return false;
  }
  try {
    const res = await api.trustedClick(x, y);
    if (res && res.success) return true;
    console.warn('[LingYa] 可信点击失败:', (res && res.error) || '未知原因');
  } catch (err) {
    console.warn('[LingYa] 可信点击异常:', err && err.message);
  }
  return false;
}

/**
 * 可信回车：通过主进程 sendInputEvent 注入真实按键（isTrusted = true）。
 *
 * 【禁止合成事件降级】原先失败会 dispatchEvent 合成 keydown/keyup，
 * isTrusted 恒为 false。合成键在现代风控里是最容易被抓的特征之一，
 * 宁可失败报错也不要静默伪装成真实按键。
 */
async function trustedPressEnter(target) {
  if (target && typeof target.focus === 'function') {
    try { target.focus(); } catch (_) { /* 聚焦失败仍继续尝试注入 */ }
  }
  const api = window.electronAPI;
  if (!api || typeof api.trustedKey !== 'function') {
    console.warn('[LingYa] 可信回车不可用：electronAPI.trustedKey 缺失');
    return false;
  }
  try {
    const res = await api.trustedKey('Enter');
    if (res && res.success) return true;
    console.warn('[LingYa] 可信回车失败:', (res && res.error) || '未知原因');
  } catch (err) {
    console.warn('[LingYa] 可信回车异常:', err && err.message);
  }
  return false;
}
async function setInputContent(input, msg) {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.focus();
      const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;

      // 渐进填充：分段累积写入，逐段派发 input 事件，逼近真人打字的多次输入特征。
      // 2026-10-24 DeepSeek 封号根因 ③-B1：原先一次 setter + 一次 input，
      // 10 万字符瞬间落框，是极强的 bot 指纹。
      // 段长随总长自适应 —— 短消息细粒度（更像人），超长消息放大段长，
      // 避免首条 110KB 填充耗时数秒拖垮体验（实测约 1.5s 内完成）。
      const base = Math.max(240, Math.min(3600, Math.ceil(msg.length / 26)));
      let written = '';
      let i = 0;
      while (i < msg.length) {
        const jitter = 0.7 + Math.random() * 0.6;   // 段长 ±30% 抖动，避免等长分段
        const size = Math.max(1, Math.round(base * jitter));
        written += msg.slice(i, i + size);
        i += size;
        nativeSetter.call(input, written);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (i < msg.length) {
          await new Promise((resolve) => setTimeout(resolve, 24 + Math.floor(Math.random() * 70)));
        }
      }
      return true;
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // 分段 Paste：每段 ≤6000 字符，不会触发 ChatGPT 的附件行为，且每段都很快。
      // 实测 12000 字符只需约 350ms。
      const CHUNK_SIZE = 6000;
      for (let i = 0; i < msg.length; i += CHUNK_SIZE) {
        const chunk = msg.slice(i, i + CHUNK_SIZE);
        const dt = new DataTransfer();
        dt.setData('text/plain', chunk);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        input.dispatchEvent(pasteEvent);
        if (i + CHUNK_SIZE < msg.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('[LingYa] 设置输入框内容失败:', err.message);
    return false;
  }
}
/**
 * 将消息填入当前可见输入框并按指定延迟触发发送
 * @param {string} msg - 要发送的消息
 * @param {string} [tag] - 日志标记
 * @param {number} [fixedDelay] - 固定延迟毫秒数；缺省时使用 initialDelay()
 * @param {Function} [afterSent] - 发送后回调
 * @returns {boolean} 是否成功
 */
// 用户消息已发出回调（供飞书同步等订阅；系统消息 tag 由订阅方自行过滤）
let onUserMessageSentCb = null;

/**
 * 注册"用户消息已发出"监听器
 * @param {Function} cb 参数 (text, tag)
 * @returns {Function} 取消注册
 */
function onUserMessageSent(cb) {
  onUserMessageSentCb = cb;
  return () => { if (onUserMessageSentCb === cb) onUserMessageSentCb = null; };
}

async function sendToChat(msg, tag, fixedDelay, afterSent, opts) {
  state.touch(); // 发消息 = 有活动
  const isAuto = !!(opts && opts.auto);
  // 【重要】自动续跑（监督者/计划续跑/兜底续跑/中断续跑等）绝不能清除 stopped ——
  // 否则用户点了停止后，程序自己发的催促消息会把 stopped 清掉，任务原地复活。
  // 这类消息在 stopped 状态下应当直接丢弃。
  if (isAuto) {
    if (state.stopped) {
      console.log('[LingYa] 已停止，丢弃自动续跑消息（' + (tag || '') + '）');
      return false;
    }
  } else if (state.stopped) {
    // 用户主动发消息：清除「已停止」状态，恢复正常自动执行
    state.stopped = false;
    try { window.electronAPI.clearAbort(); } catch (_) {}
    try {
      const { setStopped } = require('../overlay/ui');
      if (setStopped) setStopped(false);
    } catch (_) {}
  }
  // 输入框可能因页面重渲染短暂消失：重试几次，避免回传静默丢失导致 Agent 循环永久停住
  let input = findInputArea();
  for (let i = 0; !input && i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    input = findInputArea();
  }
  if (!input) {
    console.log('[LingYa] 找不到输入框，无法发送消息（重试 5 次后放弃）');
    try {
      const { showToast } = require('../overlay/ui');
      if (showToast) showToast('⚠️ 无法回传结果：找不到输入框，请手动发一条消息恢复', 5000);
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!(await setInputContent(input, msg))) {
    return false;
  }
  // 双策略延迟：
  //   - 上次请求往返（思考+回复）> adaptiveThreshold → 慢请求，走思考耗时自适应
  //   - 否则 → 快请求，走全局固定延迟
  //   - fixedDelay 显式指定时（压缩/重命名等特殊操作）一律优先
  const thinkMs = Number(state.lastThinkMs) || 0;
  const threshold = Number(state.adaptiveThreshold) || 20000;
  let sendDelay;
  let branch;
  if (fixedDelay !== undefined) {
    sendDelay = fixedDelay;
    branch = '调用方指定 ' + fixedDelay + 'ms';
  } else if (thinkMs > threshold) {
    const adaptiveDelay = computeThinkAdaptiveDelay();
    const fallbackDelay = initialDelay();
    sendDelay = Math.max(fallbackDelay, adaptiveDelay);
    branch = '慢请求自适应：往返 ' + thinkMs + 'ms > 阈值 ' + threshold +
      'ms → ' + sendDelay + 'ms（兜底 ' + fallbackDelay + '，自适应 ' + adaptiveDelay +
      '，比例 ' + state.thinkRatio + '，上限 ' + state.thinkMaxDelay + '）';
  } else {
    const globalDelay = pickGlobalDelay();
    sendDelay = globalDelay;
    branch = '快请求随机：往返 ' + thinkMs + 'ms ≤ 阈值 ' + threshold +
      'ms → 区间 [' + state.globalSendDelayMin + ', ' + state.globalSendDelayMax +
      ']ms 内随机取 ' + globalDelay + 'ms';
  }
  console.log('[LingYa] 消息已填入输入框，等待 ' + sendDelay + 'ms 后发送（' + branch + '）...');

  // ===== 延迟决策可见化 =====
  // 为什么需要：thinkRatio / thinkMaxDelay 只在「慢请求自适应」分支生效，
  // 快请求分支用的是固定 globalSendDelay。用户看不到走了哪个分支，
  // 就误以为「延迟功能没生效」——尤其多窗口场景（A 任务重走自适应、B 任务轻走固定），
  // 两个窗口表现不同，很容易被当成 bug。这里把完整决策记入历史面板，一眼可查。
  // 注意：必须包 try —— 可观测性代码绝不能阻断消息发送。
  try {
    const { addHistory } = require('../overlay/ui');
    addHistory({
      id: 'delay_' + Date.now(),
      command: '[发送延迟] ' + sendDelay + 'ms（' + branch + '）',
      success: true,
      canceled: false,
      output: [
        '实际延迟: ' + sendDelay + 'ms',
        '分支: ' + branch,
        '--- 计算依据 ---',
        'lastThinkMs（上次往返）: ' + thinkMs + 'ms',
        'adaptiveThreshold（快慢阈值）: ' + threshold + 'ms',
        'thinkRatio（自适应比例）: ' + state.thinkRatio,
        'thinkMaxDelay（自适应上限）: ' + state.thinkMaxDelay + 'ms',
        'globalSendDelayMin/Max（快请求随机区间）: ' + state.globalSendDelayMin + ' ~ ' + state.globalSendDelayMax + 'ms',
        'globalSendDelay（本次实际取值）: ' + sendDelay + 'ms',
        'initialSendDelay（兜底延迟）: ' + state.initialSendDelay + 'ms',
        '',
        '判定: ' + (thinkMs > threshold
          ? '上次往返 ' + thinkMs + 'ms > 阈值 ' + threshold + 'ms → 走【慢请求自适应】，thinkRatio/thinkMaxDelay 生效'
          : '上次往返 ' + thinkMs + 'ms ≤ 阈值 ' + threshold + 'ms → 走【快请求固定】，thinkRatio/thinkMaxDelay 不参与'),
        '消息 tag: ' + (tag || '(无)'),
      ].join(String.fromCharCode(10)),
      timestamp: Date.now(),
    });
  } catch (_) { /* 记录失败不影响发送 */ }

  setTimeout(async function() {
    // 延迟期间用户点了停止：取消本次发送
    if (state.stopped) {
      console.log('[LingYa] 已停止，取消本次延迟发送');
      return;
    }
    console.log('[LingYa] 等待结束，开始触发发送');
    // triggerSend 返回 Promise<boolean>：可信点击/可信 Enter 全部失败时为 false。
    // 失败时不能继续往下走 —— 否则会误记 lastRequestStartAt、误切状态机到 SENT，
    // 后续监督者会以为「消息已发出但没回复」，白白等一轮超时。
    let sent = false;
    try { sent = await triggerSend(input); } catch (err) {
      console.error('[LingYa] 触发发送异常:', err && err.message);
    }
    if (!sent) {
      console.error('[LingYa] 发送失败，跳过状态记录（' + (tag || '') + '）');
      return;
    }
    // 记录本次请求发出时刻，供 intercept-observer 计算思考耗时
    state.lastRequestStartAt = Date.now();
    // 状态机：已发出，等 AI 开始生成（intercept-observer 收到 lingya-ai-start 后会切 AWAITING）
    // 若 30s 内仍未切走，监督者会判定「消息可能没发出去」并重试
    try {
      taskState.transition(taskState.STATES.SENT, {
        lastSentTag: String(tag || ''),
        round: taskState.snapshot().round + 1,
      });
    } catch (_) { /* 状态机异常不影响发送 */ }
    console.log('[LingYa] 已触发发送, ' + (tag || '') + ', 长度=' + msg.length +
      ', 方式=' + (state.lastSendMethod || 'unknown'));

    // ===== 发送方式可见化 =====
    // 用户需要知道消息到底是「点了发送按钮」还是「按了回车」发出去的 ——
    // 两者走的是不同的真实输入路径，排查发送失败时这是第一手线索。
    try {
      const SEND_METHOD_LABEL = {
        'provider-native': '站点原生（Provider 自带）',
        'trusted-click': '可信点击发送按钮（isTrusted=true）',
        'trusted-enter': '可信回车（isTrusted=true）',
        'failed': '发送失败（点击与回车均未成功）',
      };
      const methodText = SEND_METHOD_LABEL[state.lastSendMethod] || (state.lastSendMethod || 'unknown');
      const { addHistory } = require('../overlay/ui');
      addHistory({
        id: 'send_' + Date.now(),
        command: '[发送方式] ' + methodText,
        success: true,
        canceled: false,
        output: [
          '消息 tag: ' + (tag || '(无)'),
          '消息长度: ' + msg.length + ' 字符',
          '发送方式: ' + methodText,
          '方式标识: ' + (state.lastSendMethod || 'unknown'),
          '发送时刻: ' + new Date().toLocaleTimeString('zh-CN'),
        ].join(String.fromCharCode(10)),
        timestamp: Date.now(),
      });
    } catch (_) { /* 可观测性代码绝不能阻断发送 */ }
    // 记录用户原始消息（排除程序自动发的催促/工具回传，供本地拒绝改写使用）
    if (!isAuto) {
      try {
        state.lastUserMessage = String(msg || '');
        state.lastUserMessageAt = Date.now();
      } catch (_) {}
    }
    if (onUserMessageSentCb) { try { onUserMessageSentCb(msg, tag); } catch (_) {} }
    if (typeof afterSent === 'function') afterSent();
  }, sendDelay);
  return true;
}
/**
 * 将消息填入 DeepSeek 聊天输入框并触发发送（工具结果回传的公共实现）
 */
function sendMessageToChat(msg, tag, opts) {
  return sendToChat(msg, tag, undefined, undefined, opts);
}
/**
 * 将 JSON 工具执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendToolResultToChat(toolCall, result) {
  // 构造回传消息（自然语言，模拟真人口吻，不带任何机器标记）
  const nl = String.fromCharCode(10);
  const MAXLEN = 20000;
  let msg;

  if (result && result.success) {
    const data = result.data;
    let out = '';

    if (typeof data === 'string') {
      // 最常见：ToolResult.success('格式化好的文本')
      out = data;
    } else if (data && typeof data === 'object') {
      // 对象形态：优先取 content / output / text，其余字段平铺成朴素文本
      out = (typeof data.content === 'string' && data.content) ||
            (typeof data.output === 'string' && data.output) ||
            (typeof data.text === 'string' && data.text) || '';
      if (!out) {
        const parts = [];
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (v === null || v === undefined) continue;
          parts.push(k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
        }
        out = parts.join(nl);
      }
    } else {
      out = String(data === undefined || data === null ? '' : data);
    }

    out = String(out || '').trim();
    if (out.length > MAXLEN) out = out.slice(0, MAXLEN) + nl + '...[内容太长省略了一部分]...';
    msg = out || '(执行完成，没有输出)';
  } else {
    msg = '出错了：' + ((result && result.error) || '未知错误') + nl + '再试一下看看。';
  }

  console.log('[LingYa] 回传工具结果, 消息长度=' + msg.length);
  sendMessageToChat(msg, '工具=' + toolCall.toolName, { auto: true });
}
/**
 * 将 JS 工具脚本执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendCombinedJsResultsToChat(results) {
  if (!Array.isArray(results) || results.length === 0) return;

  const MAX_OUTPUT = 15000;
  const sep = String.fromCharCode(10);

  let msg = '';

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const ok = item && item.result && item.result.success;

    if (ok) {
      let out = String((item.result.output || '')).trim();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + sep + '...[输出太长省略了一部分]...';
      }
      msg += (out || '(执行完成，没有输出)') + sep;
    } else {
      // 报错时只说错误本身，不把代码贴回去（真人不会把自己刚写的代码再念一遍）
      msg += '出错了：' + ((item && item.result && item.result.error) || '未知错误') + sep;
      msg += '我改一下重新跑。' + sep;
    }

    // 多脚本之间留空行分隔即可，不加"第一个/下一个"这类机械过渡
    if (i < results.length - 1) msg += sep;
  }

  // 收集所有脚本产出的图片
  const allImages = [];
  for (const item of results) {
    if (item && item.result && Array.isArray(item.result.images) && item.result.images.length > 0) {
      allImages.push(...item.result.images);
    }
  }
  if (allImages.length > 0) {
    msg += sep + '（附了 ' + allImages.length + ' 张图，你看下。）';
  }

  console.log('[LingYa] 回传 JS 汇总执行结果, 消息长度=' + msg.length + ', 图片=' + allImages.length);
  // 先填文本（sendToChat 内部会 selectAll+delete 清空输入框），再注入图片附件；
  // 文本发送有 2-4s 延迟，注入的附件会在发送前附着。
  sendMessageToChat(msg, 'JS汇总', { auto: true });
  if (allImages.length > 0) {
    injectImagesToInput(allImages);
  }
}
/**
 * 将图片作为附件注入聊天输入框（通过 paste 事件携带 File 对象）。
 * 浏览器/站点会把 File 识别为图片附件。返回成功注入的数量。
 * @param {Array<{name:string, mime:string, base64:string}>} images
 * @returns {number} 成功注入的图片数
 */
function injectImagesToInput(images) {
  if (!Array.isArray(images) || images.length === 0) return 0;
  const input = findInputArea();
  if (!input) {
    console.log('[LingYa] 找不到输入框，无法注入图片');
    return 0;
  }
  input.focus();
  let count = 0;
  for (const img of images) {
    try {
      const bin = atob(img.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], img.name || 'image.png', { type: img.mime || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      input.dispatchEvent(evt);
      count++;
      console.log('[LingYa] 已注入图片附件: ' + file.name + ' (' + bytes.length + ' bytes)');
    } catch (err) {
      console.error('[LingYa] 注入图片失败: ' + err.message);
    }
  }
  return count;
}

/**
 * 查找 DeepSeek 的输入框元素
 */
function findInputArea() {
  const provider = getCurrentProvider();
  if (provider && typeof provider.findInput === 'function') {
    const el = provider.findInput();
    if (el) return el;
  }

  // 通用兜底：找所有可见 textarea
  //
  // 【必须排除 LingYa 注入的元素】provider.findInput() 若未命中（站点改版、
  // 输入框延迟渲染），会落到这里。而 LingYa 覆盖层注入了 lingya-utodo-input /
  // lingya-mcp-json / lingya-schedule-prompt 等 textarea，且位于 body 末尾。
  // 不加排除就会把它们当成聊天输入框，导致消息被填进「我的待办」并按 Enter 提交
  // ——凭空生成待办（2026-10-24 实测事故：定时任务文本被写进待办）。
  const allTextareas = document.querySelectorAll('textarea');
  for (const ta of allTextareas) {
    if (isLingyaInjected(ta)) continue;
    if (isInputVisible(ta)) return ta;
  }
  // 再找 contenteditable 或 textbox
  const editables = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
  for (const editable of editables) {
    if (isLingyaInjected(editable)) continue;
    if (isInputVisible(editable)) return editable;
  }

  return null;
}
/**
 * 判断元素是否由 LingYa 自己注入（非站点原生元素）。
 *
 * 与 providers/deepseek.js 里的同名函数保持一致的判定规则。
 * 覆盖层与侧边栏注入的输入框（lingya-utodo-input / sh-utodo-input 等）
 * 绝不能当成聊天输入框——否则消息会被填进去并触发它们的 Enter 提交逻辑。
 */
function isLingyaInjected(el) {
  if (!el) return true;
  try {
    if (el.id && /^(lingya|sh)-/.test(el.id)) return true;
    var cls = (typeof el.className === 'string') ? el.className : '';
    if (/\b(lingya|sh)-/.test(cls)) return true;
    if (typeof el.closest === 'function' &&
        el.closest('#lingya-root, .lingya-overlay, #lingya-sidebar, .lingya-sidebar, .sh-view')) return true;
  } catch (_) { /* 判定失败时保守放行 */ }
  return false;
}

/**
 * 检查元素是否可见
 */
function isInputVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
/**
 * 发送初始提示（目录树+systemPrompt）到输入框
 */
async function sendInitialPromptToInput() {
  if (!state.initialPromptContent) {
    state.pendingInitialPrompt = false;
    return false;
  }

  const input = findInputArea();
  if (!input) {
    return false;
  }

  if (!(await setInputContent(input, state.initialPromptContent))) {
    return false;
  }

  // 分批发送的段间间隔必须随机化。
  // 固定节拍（如每次都精确 1 秒）是最强的 bot 指纹 —— 记忆 #422 已把普通消息的
  // globalSendDelay 从固定 3000 改成 2500~9000 随机，初始化这里不能漏。
  // 基础值仍取 initialDelay()，在此基础上叠加 0.6~1.8 倍的随机抖动。
  const baseDelay = initialDelay();
  const jitter = 0.6 + Math.random() * 1.2;
  const sendDelay = Math.round(baseDelay * jitter);
  // 把分段数组和序号"快照"到本地常量。
  // 不能在 setTimeout 回调里再去读 state.initialPromptChunks ——
  // 这中间用户可能切会话，新的 initial-prompt 会把 state.initialPromptChunks 置 null，
  // 回调里再访问 .length 就会抛异常，导致这一段发不出去且状态卡死。
  const chunksSnapshot = Array.isArray(state.initialPromptChunks) ? state.initialPromptChunks : null;
  const chunkIdxSnapshot = state.initialPromptChunkIndex;
  const isChunked = !!chunksSnapshot && chunksSnapshot.length > 1;
  const chunkNo = chunkIdxSnapshot + 1;
  const chunkTotal = isChunked ? chunksSnapshot.length : 0;
  console.log('[LingYa] 初始提示已填入' +
    (isChunked ? '（第 ' + chunkNo + '/' + chunkTotal + ' 段）' : '') +
    '，等待 ' + sendDelay + 'ms 后发送...');
  setTimeout(async function() {
    if (state.stopped) {
      console.log('[LingYa] 已停止，取消初始提示发送');
      state.pendingInitialPrompt = false;
      state.initialPromptChunks = null;
      return;
    }
    console.log('[LingYa] 等待结束，开始发送初始提示' +
      (isChunked ? '（第 ' + chunkNo + '/' + chunkTotal + ' 段）' : ''));
    let sent = false;
    try { sent = await triggerSend(input); } catch (err) {
      console.error('[LingYa] 初始提示发送异常:', err && err.message);
    }
    state.pendingInitialPrompt = false;
    if (!sent) {
      // 发送失败：清掉分批状态，避免 awaitingNextInitialChunk 永久挂起屏蔽续跑
      console.error('[LingYa] 初始提示发送失败，放弃本批次剩余分段');
      state.initialPromptChunks = null;
      state.initialPromptChunkIndex = 0;
      state.awaitingNextInitialChunk = false;
      state.initialChunkDeferCount = 0;
      state.initialChunkDeferAt = 0;
      return;
    }

    // 分批模式：还有后续段 → 挂起，等本轮回复结束后再发下一段
    // 用快照判断，且只有在 state 仍是同一批次时才置挂起标志
    const sameBatch = isChunked &&
      state.initialPromptChunks === chunksSnapshot &&
      state.initialPromptChunkIndex === chunkIdxSnapshot;
    if (sameBatch && chunkIdxSnapshot < chunksSnapshot.length - 1) {
      state.awaitingNextInitialChunk = true;
      state.initialChunkDeferCount = 0;
      state.initialChunkDeferAt = 0;
      console.log('[LingYa] 第 ' + chunkNo + ' 段已发出，等待回复后发送下一段');
    } else if (isChunked && sameBatch) {
      console.log('[LingYa] 全部分段已发送完毕（共 ' + chunkTotal + ' 段）');
      state.initialPromptChunks = null;
      state.initialPromptChunkIndex = 0;
      state.awaitingNextInitialChunk = false;
      state.initialChunkDeferCount = 0;
      state.initialChunkDeferAt = 0;
    }
  }, sendDelay);

  return true;
}

/**
 * 分批模式下发送下一段初始提示。
 * 由 lingya-ai-response 监听器在上一段回复结束后调用。
 * @returns {boolean} 是否已发起发送
 */
function sendNextInitialPromptChunk() {
  if (!state.awaitingNextInitialChunk) return false;
  if (!Array.isArray(state.initialPromptChunks)) return false;
  if (state.stopped) {
    state.awaitingNextInitialChunk = false;
    state.initialPromptChunks = null;
    return false;
  }
  const nextIdx = state.initialPromptChunkIndex + 1;
  if (nextIdx >= state.initialPromptChunks.length) {
    state.awaitingNextInitialChunk = false;
    state.initialPromptChunks = null;
    state.initialPromptChunkIndex = 0;
    return false;
  }
  state.initialPromptChunkIndex = nextIdx;
  state.awaitingNextInitialChunk = false;
  state.initialPromptContent = state.initialPromptChunks[nextIdx];
  state.pendingInitialPrompt = true;
  console.log('[LingYa] 准备发送第 ' + (nextIdx + 1) + '/' + state.initialPromptChunks.length + ' 段');
  return sendInitialPromptToInput();
}
/**
 * 强制把剩余的初始提示分段合并成一条发出。
 *
 * 使用场景：AI 连续多轮回复都带工具调用，导致「等它干完再发下一段」永远等不到。
 * 此时必须放弃分段策略，把剩下的段合并成一条发出去 ——
 * 提示词晚一点到不影响正确性，但让整个 Agent 循环被永久屏蔽是致命的。
 *
 * @param {string} reason 触发原因（仅用于日志）
 * @returns {boolean} 是否已发起发送
 */
function flushRemainingInitialChunks(reason) {
  if (!Array.isArray(state.initialPromptChunks)) return false;
  const rest = state.initialPromptChunks.slice(state.initialPromptChunkIndex + 1);
  // 先把所有分批状态清干净，无论后面发不发得出去，都不能再屏蔽续跑
  state.awaitingNextInitialChunk = false;
  state.initialPromptChunks = null;
  state.initialPromptChunkIndex = 0;
  state.initialChunkDeferCount = 0;
  state.initialChunkDeferAt = 0;

  if (rest.length === 0) return false;
  if (state.stopped) {
    console.log('[LingYa][分批] 已停止，丢弃剩余 ' + rest.length + ' 段（' + reason + '）');
    return false;
  }

  const merged = rest.join('\n\n');
  state.initialPromptContent = merged;
  state.pendingInitialPrompt = true;
  console.log('[LingYa][分批] ' + reason + ' → 放弃分段，把剩余 ' + rest.length +
    ' 段合并成一条发出（' + merged.length + ' 字符）');
  return sendInitialPromptToInput();
}

/**
 * 等待输入框出现后再发送初始提示
 */
function waitForInitialPromptAndSend() {
  let attempts = 0;
  const maxAttempts = 30;
  console.log('[' + new Date().toISOString() + '] [LingYa] 开始等待输入框出现（最多 ' + maxAttempts + ' 次，每次 500ms）');

  const checkInterval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(checkInterval);
      state.pendingInitialPrompt = false;
      console.log('[' + new Date().toISOString() + '] [LingYa] 等待输入框超时，放弃发送初始提示');
      return;
    }

    const found = !!findInputArea();
    if (attempts === 1 || attempts % 5 === 0 || found) {
      console.log('[' + new Date().toISOString() + '] [LingYa] 等待输入框第 ' + attempts + ' 次检查, 输入框=' + (found ? '找到' : '未找到'));
    }
    if (found) {
      clearInterval(checkInterval);
      sendInitialPromptToInput();
    }
  }, 500);
}
/**
 * 触发发送消息
 */
function triggerSend(input) {
  const provider = getCurrentProvider();

  // 方法 0: 站点原生发送（智谱等免疫合成事件的平台，经主进程注入真实级输入）
  if (provider && typeof provider.triggerSend === 'function') {
    let result = null;
    try { result = provider.triggerSend(input); } catch (_) { /* 站点实现异常时回退通用逻辑 */ }
    if (result && typeof result.then === 'function') {
      return result.then(function (ok) {
        if (ok) {
          console.log('[LingYa] 已通过站点原生发送触发');
          state.lastSendMethod = 'provider-native';
          return true;
        }
        return fallbackSend(provider, input);
      }).catch(function () { return fallbackSend(provider, input); });
    }
    if (result) {
      console.log('[LingYa] 已通过站点原生发送触发');
      state.lastSendMethod = 'provider-native';
      return true;
    }
  }

  return fallbackSend(provider, input);
}

/**
 * 通用发送兜底：可信点击发送按钮，或可信 Enter。
 *
 * 【必须 await】两个 trusted* 函数是 async，且内部已改为「失败返回 false 而非合成事件降级」。
 * 不 await 会导致失败被吞掉、日志打印假成功，用户看到消息没发出去却查不到原因。
 * 全部失败时明确报错，让用户手动发一条恢复循环。
 */
async function fallbackSend(provider, input) {
  // 方法 1: 平台 Provider 提供的发送按钮
  if (provider && typeof provider.findSendButton === 'function') {
    let btn = null;
    try { btn = provider.findSendButton(); } catch (_) { btn = null; }
    if (btn) {
      const ok = await trustedClickElement(btn);
      if (ok) {
        console.log('[LingYa] 已通过可信点击发送按钮');
        state.lastSendMethod = 'trusted-click';
        return true;
      }
      console.warn('[LingYa] 可信点击发送按钮失败，尝试 Enter');
    }
  }

  // 方法 2: 可信 Enter 按键
  if (input) {
    const ok = await trustedPressEnter(input);
    if (ok) {
      console.log('[LingYa] 已通过可信 Enter 触发发送');
      state.lastSendMethod = 'trusted-enter';
      return true;
    }
  }

  console.error('[LingYa] 发送失败：可信点击与可信 Enter 均未成功');
  state.lastSendMethod = 'failed';
  try {
    const { showToast } = require('../overlay/ui');
    if (showToast) showToast('⚠️ 消息未能发送，请手动发一条消息恢复', 6000);
  } catch (_) { /* 覆盖层未就绪时忽略 */ }
  return false;
}
/**
 * 注册主进程消息监听（initial-prompt）
 * 与原 preload.js 顶层注册时机一致：preload 入口加载时同步调用。
 */
function registerIpcListeners() {
// 监听主进程发送的初始提示
// 侧边栏「插入」→ 把文本填进输入框（不自动发送）
// 侧边栏「动作」→ 在 AI 视图侧执行（生成文档/沉浸式/停止/压缩/手动解析/导出）
ipcRenderer.on('lingya-set-setting', (_event, payload) => {
  try {
    const k = (payload && payload.key) || '';
    const v = payload && payload.value;
    if (!k) return;
    if (k === 'auto-inject') { localStorage.setItem('lingya-auto-inject', v ? '1' : '0'); }
    else if (k === 'auto-rename-enabled') { localStorage.setItem('lingya-auto-rename-enabled', v ? '1' : '0'); }
    else if (k === 'initial-send-delay') { localStorage.setItem('lingya-initial-send-delay', String(v)); state.initialSendDelay = Number(v); }
    else if (k === 'think-ratio') { localStorage.setItem('lingya-think-ratio', String(v)); state.thinkRatio = Number(v); console.log('[LingYa] 配置已更新 thinkRatio=' + state.thinkRatio + '（IPC 生效）'); }
    else if (k === 'think-max-delay') { localStorage.setItem('lingya-think-max-delay', String(v)); state.thinkMaxDelay = Number(v); console.log('[LingYa] 配置已更新 thinkMaxDelay=' + state.thinkMaxDelay + '（IPC 生效）'); }
    else if (k === 'global-send-delay-min') { localStorage.setItem('lingya-global-send-delay-min', String(v)); state.globalSendDelayMin = Number(v); }
    else if (k === 'global-send-delay-max') { localStorage.setItem('lingya-global-send-delay-max', String(v)); state.globalSendDelayMax = Number(v); }
    else if (k === 'adaptive-threshold') { localStorage.setItem('lingya-adaptive-threshold', String(v)); state.adaptiveThreshold = Number(v); }
    else if (k === 'auto-compact-enabled') { localStorage.setItem('lingya-auto-compact-enabled', v ? '1' : '0'); }
    else if (k === 'auto-compact-threshold') { localStorage.setItem('lingya-auto-compact-threshold', String(v)); }
    else if (k === 'hide-floating') { localStorage.setItem('lingya-hide-floating', v ? '1' : '0'); try { require('../overlay/ui').applyFloatSettings(); } catch (_) {} }
    else if (k === 'hide-plan-float') { localStorage.setItem('lingya-hide-plan-float', v ? '1' : '0'); try { require('../overlay/ui').applyFloatSettings(); } catch (_) {} }
  } catch (e) { console.error('[LingYa] set-setting 失败:', e.message); }
});

ipcRenderer.on('lingya-run-action', async (_event, payload) => {
  const a = (payload && payload.action) || '';
  try {
    if (a === 'gen-doc') {
      await sendToChat('根据当前项目生成一个类似 claude.md 的项目说明文件，并将文件放到当前项目 .lingyaCode/LINGYA.md', '生成文档', 300);
    } else if (a === 'immersive') {
      await sendToChat('现在你的任何疑问,或没有疑问的选择都需要和我确认 , 确认的方式是 你问一个问题我回答一个问题,然后你再问下一个问题, 最好给我选项, 也要给我个其他的选项, 谢谢 爱你哦', '沉浸式交流', 300);
    } else if (a === 'ai-rename') {
      // 让 AI 回顾完整上下文，用 nameConversation 给本对话重新命名
      const prompt = [
        '请回顾本次对话的**完整上下文**（包括所有历史消息与工具执行结果），提炼这次对话真正在做的核心工作，',
        '然后**只调用一次** nameConversation(title) 工具，给本次对话起一个准确的中文标题（≤20 字）。',
        '',
        '要求：',
        '1. 标题要体现对话的**实际核心内容**，不要用"你好""继续"这类开场词，也不要用最后一条消息的主题代替整体。',
        '2. 直接调用工具，不要输出计划、不要解释、不要做任何其他操作。',
        '3. 调用完只回复一句"已重命名为：<标题>"即可。',
      ].join('\n');
      await sendToChat(prompt, 'AI重命名', 300);
    } else if (a === 'stop') {
      const ev = require('../overlay/events'); if (ev.stopTask) await ev.stopTask(false);
    } else if (a === 'compact') {
      const cp = require('./compaction'); if (cp.runCompaction) await cp.runCompaction();
    } else if (a === 'manual-parse') {
      const io = require('./intercept-observer');
      const text = io.getLastInterceptedText ? io.getLastInterceptedText() : null;
      if (text && io.processInterceptedResponse) await io.processInterceptedResponse(text, true);
    } else if (a === 'clear-history') {
      try { const { commandHistory } = require('../overlay/ui'); if (commandHistory) commandHistory.length = 0; const ui = require('../overlay/ui'); if (ui.renderHistory) ui.renderHistory(); } catch (_) {}
    } else if (a === 'export-md') {
      const log = require('./conversation-log');
      const cnt = log.getCount ? log.getCount() : 0;
      if (cnt === 0) { try { const { showToast } = require('../overlay/ui'); showToast('本窗口尚无对话记录', 3000); } catch (_) {} return; }
      const md = log.exportMarkdown ? log.exportMarkdown() : '';
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const nm = 'lingya-conversation-' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.md';
      await ipcRenderer.invoke('conversation-export-md', { markdown: md, suggestedName: nm });
    }
  } catch (e) { console.error('[LingYa] run-action 失败:', e.message); }
});

// 侧边栏「发送并提交」：填入 + 自动发送（区别于 insert-to-chat 的只填入）
ipcRenderer.on('lingya-send-to-chat', async (_event, payload) => {
  try {
    const text = String((payload && payload.text) || '');
    const tag = String((payload && payload.tag) || '侧边栏发送');
    if (!text.trim()) return;
    await sendMessageToChat(text, tag, { auto: false });
    console.log('[LingYa] 侧边栏发送已提交: ' + tag + ', 长度=' + text.length);
  } catch (e) {
    console.error('[LingYa] 侧边栏发送失败:', e.message);
  }
});

ipcRenderer.on('lingya-insert-to-chat', async (_event, payload) => {
  try {
    const p = payload || {};
    const text = String(p.text || '');
    if (!text) return;
    let input = findInputArea();
    for (let i = 0; !input && i < 5; i++) { await new Promise(r => setTimeout(r, 300)); input = findInputArea(); }
    if (!input) { try { const { showToast } = require('../overlay/ui'); showToast('未找到输入框', 3000); } catch (_) {} return; }
    await setInputContent(input, text);
    try { const { showToast } = require('../overlay/ui'); showToast('已插入', 1500); } catch (_) {}
  } catch (e) { console.error('[LingYa] insert-to-chat 失败:', e.message); }
});

ipcRenderer.on('initial-prompt', (_event, content) => {
  // 分批模式：主进程传 { chunks: [...] }，逐段发送（每段之间等上一条回复结束）
  if (content && Array.isArray(content.chunks) && content.chunks.length > 0) {
    console.log('[' + new Date().toISOString() + '] [LingYa] 收到 initial-prompt 分批事件, 共 ' +
      content.chunks.length + ' 段, 总长度=' + content.chunks.join('').length);
    state.initialPromptChunks = content.chunks.slice();
    state.initialPromptChunkIndex = 0;
    state.awaitingNextInitialChunk = false;   // 新一轮分批，先复位挂起标志
    state.initialPromptContent = content.chunks[0] || '';
    state.pendingInitialPrompt = true;
    try {
      const input = findInputArea();
      if (input) sendInitialPromptToInput();
      else waitForInitialPromptAndSend();
    } catch (e) {
      console.error('[' + new Date().toISOString() + '] [LingYa] initial-prompt 分批处理异常:', e.message);
    }
    return;
  }

  state.initialPromptChunks = null;
  state.initialPromptChunkIndex = 0;
  state.awaitingNextInitialChunk = false;   // 单段模式，清掉可能残留的挂起标志
  console.log('[' + new Date().toISOString() + '] [LingYa] 收到 initial-prompt 事件, content长度=' + (content || '').length);
  state.initialPromptContent = content || '';
  state.pendingInitialPrompt = true;
  // 如果当前已有新的空会话输入框，立即发送
  if (state.pendingInitialPrompt && state.initialPromptContent) {
    try {
      const input = findInputArea();
      console.log('[' + new Date().toISOString() + '] [LingYa] 首次查找输入框结果=' + (input ? '找到' : '未找到'));
      if (input) {
        sendInitialPromptToInput();
      } else {
        // 等待输入框出现
        waitForInitialPromptAndSend();
      }
    } catch (e) {
      console.error('[' + new Date().toISOString() + '] [LingYa] initial-prompt 处理异常:', e.message);
    }
  }
});
}


module.exports = {
  initialDelay,
  setInputContent,
  sendToChat,
  sendMessageToChat,
  sendToolResultToChat,
  sendCombinedJsResultsToChat,
  injectImagesToInput,
  findInputArea,
  isInputVisible,
  sendInitialPromptToInput,
  sendNextInitialPromptChunk,
  flushRemainingInitialChunks,
  waitForInitialPromptAndSend,
  triggerSend,
  registerIpcListeners,
  onUserMessageSent,
};
