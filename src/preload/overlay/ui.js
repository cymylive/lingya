/**
 * 覆盖层 UI 基础能力：注入、提示、历史记录、徽章、面板显隐与巡检
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { ipcRenderer } = require('electron');
const { OVERLAY_HTML, OVERLAY_CSS } = require('./template');
const { TOOL_CARD_CSS } = require('./tool-card');
const { getProviderByUrl } = require('../../../src/providers');
const state = require('../dom/state');
const domPrefix = require('./dom-prefix');

// ========== 前缀劫持（封号风险改造 2026-11-01）==========
// 说明：覆盖层所有元素用 'lingya-*' 前缀注入页面，页面脚本一行 querySelectorAll 即暴露身份。
// 完整迁移到独立 BrowserWindow 成本过高；本模块在注入时把前缀替换为随机串（如 'lx_a3k2_'），
// 并劫持 document.getElementById / querySelectorAll，让所有调用方（overlay 内 172 处
// getElementById、3 处 querySelectorAll('.lingya-*')）无感切换。
//
// 只在注入前劫持一次（幂等），不影响 AI 页面原生 DOM。
let __domPrefixHijacked = false;
function installDomPrefixHijack() {
  if (__domPrefixHijacked) return;
  __domPrefixHijacked = true;
  const LEGACY = domPrefix.LEGACY;
  const PREFIX = domPrefix.PREFIX;

  // selector 字符串里的 'lingya-' 替换为新前缀（仅当含该子串才替换，性能几乎无损）
  function patchSel(s) {
    if (typeof s !== 'string' || s.indexOf(LEGACY) === -1) return s;
    return s.split(LEGACY).join(PREFIX);
  }

  // getElementById：'lingya-xxx' 自动映射为新 id
  const origGetById = Document.prototype.getElementById;
  Document.prototype.getElementById = function(id) {
    if (typeof id === 'string' && id.indexOf(LEGACY) === 0) {
      return origGetById.call(this, domPrefix.mapId(id));
    }
    return origGetById.call(this, id);
  };

  // querySelector / querySelectorAll：Document + Element 四把
  // 让 overlay 内部 '.lingya-tab' 等选择器仍能命中新前缀 DOM；
  // 页面侧同样调用 '.lingya-*' 时被替换成 '.lx_xxx_*'，DOM 里没有 → 返回空（这正是我们要的）
  const origDocQS = Document.prototype.querySelector;
  const origElQS = Element.prototype.querySelector;
  const origDocQSA = Document.prototype.querySelectorAll;
  const origElQSA = Element.prototype.querySelectorAll;
  Document.prototype.querySelector = function(sel) { return origDocQS.call(this, patchSel(sel)); };
  Element.prototype.querySelector = function(sel) { return origElQS.call(this, patchSel(sel)); };
  Document.prototype.querySelectorAll = function(sel) { return origDocQSA.call(this, patchSel(sel)); };
  Element.prototype.querySelectorAll = function(sel) { return origElQSA.call(this, patchSel(sel)); };

  // 劫持 classList：'lingya-hidden' 等 class 操作也映射到新前缀
  // 【关键修复 2026-11-01】否则 el.classList.contains('lingya-hidden') 永远 false，
  // 导致 showOverlay/hideOverlay 判断错乱（点击悬浮球无反应）。
  const origClassAdd = DOMTokenList.prototype.add;
  const origClassRemove = DOMTokenList.prototype.remove;
  const origClassToggle = DOMTokenList.prototype.toggle;
  const origClassContains = DOMTokenList.prototype.contains;
  const origClassReplace = DOMTokenList.prototype.replace;
  DOMTokenList.prototype.add = function() {
    const args = Array.prototype.map.call(arguments, patchSel);
    return origClassAdd.apply(this, args);
  };
  DOMTokenList.prototype.remove = function() {
    const args = Array.prototype.map.call(arguments, patchSel);
    return origClassRemove.apply(this, args);
  };
  DOMTokenList.prototype.toggle = function(token, force) {
    return origClassToggle.call(this, patchSel(token), force);
  };
  DOMTokenList.prototype.contains = function(token) {
    return origClassContains.call(this, patchSel(token));
  };
  DOMTokenList.prototype.replace = function(oldToken, newToken) {
    return origClassReplace.call(this, patchSel(oldToken), patchSel(newToken));
  };

  // 劫持 innerHTML setter：所有 overlay 动态生成的 HTML 字符串（如
  //   list.innerHTML = '<div class="lingya-session-empty">暂无</div>'
  // ）里的 'lingya-' 自动替换为新前缀。否则页面 querySelectorAll('[class*="lingya-"]')
  // 仍能命中这 26 处动态生成的元素。
  //
  // 【安全边界】只在「目标元素位于 overlay 根容器内」时才替换 —— 避免误伤 AI 页面
  // 自身的 innerHTML 渲染（DeepSeek 前端框架大量使用 innerHTML，虽极少含 'lingya-'
  // 字串，但绝不赌）。overlay 根容器用 Object.getOwnPropertyDescriptor 判断不依赖 DOM 顺序。
  const ROOT_ID = domPrefix.mapId('lingya-root');
  const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (innerHTMLDesc && innerHTMLDesc.set) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      get() { return innerHTMLDesc.get.call(this); },
      set(v) {
        if (typeof v === 'string' && v.indexOf(LEGACY) !== -1) {
          // 判断 this 是否在 overlay 内：this 自身是 root，或最近祖先是 root
          try {
            if (this.id === ROOT_ID || (typeof this.closest === 'function' && this.closest('#' + ROOT_ID))) {
              v = patchSel(v);
            }
          } catch (_) { /* closest 失败时保守不替换 */ }
        }
        return innerHTMLDesc.set.call(this, v);
      },
      configurable: true,
      enumerable: innerHTMLDesc.enumerable,
    });
  }
}

// ========== 注入样式 ==========
/**
 * 注入覆盖层 CSS 样式到页面头部
 */
function injectCSS() {
  // 【封号风险改造 2026-11-01】先装前缀劫持，再注入（顺序不能反）
  installDomPrefixHijack();

  // 把 CSS 里的 'lingya-' 前缀替换为随机前缀，使页面无法通过 .lingya-* 选择器命中
  const style = document.createElement('style');
  style.textContent = domPrefix.replacePrefix(OVERLAY_CSS);
  document.head.appendChild(style);

  // 工具调用卡片样式（独立模块）。
  // 【BUG 修复】此前 TOOL_CARD_CSS 只在 tool-card.js 里定义并导出，从未被任何地方注入，
  // 导致卡片 div 渲染出来了但 border/background/字号/折叠全部失效 —— 视觉上与普通文字无异，
  // 在深色 AI 页面上几乎不可见，用户误判为「工具没执行」。
  if (!document.getElementById('lingya-tool-card-style')) {
    const ts = document.createElement('style');
    // 【封号风险改造 2026-11-01】id 也要换成随机前缀，否则下一次 getElementById（已被劫持）找不到它
    ts.id = domPrefix.mapId('lingya-tool-card-style');
    ts.textContent = domPrefix.replacePrefix(TOOL_CARD_CSS);
    document.head.appendChild(ts);
  }
}

// ========== 注入覆盖层 HTML ==========
/**
 * 注入覆盖层 HTML 到页面 body
 * 创建 lingya-root 容器并填充 OVERLAY_HTML 内容
 */
function injectOverlay() {
  // 【封号风险改造 2026-11-01】把 'lingya-' 前缀替换为随机前缀（如 'lx_a3k2_'），
  // 页面 querySelectorAll('[id^="lingya-"]') / ('.lingya-*') 均返回 0，等同独立窗口效果。
  // document.getElementById 已被劫持，所有 'lingya-xxx' 查询自动映射到新 id。
  const container = document.createElement('div');
  container.id = domPrefix.mapId('lingya-root');
  // innerHTML 已被劫持，'lingya-' 前缀会自动替换为新前缀
  container.innerHTML = OVERLAY_HTML;
  document.body.appendChild(container);
  applyFloatSettings(); // 注入后应用显隐设置
  applyFabSize(); // 注入后应用用户配置的悬浮球尺寸
}

// ========== 覆盖层逻辑 ==========

let currentCommand = null;
let isExecuting = false;
let commandIdCounter = 0;
const commandHistory = [];

/**
 * 生成唯一命令 ID
 * @returns {string} 格式为 cmd_时间戳_序号 的唯一标识
 */
function generateId() {
  return `cmd_${Date.now()}_${++commandIdCounter}`;
}

/**
 * 格式化时间戳为 HH:mm:ss 格式
 * @param {number} ts - 时间戳（毫秒）
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 截断文本到指定长度，超出部分以 ... 结尾
 * @param {string} text - 要截断的文本
 * @param {number} maxLen - 最大长度，默认 50
 * @returns {string} 截断后的文本
 */
function truncate(text, maxLen = 50) {
  if (!text || text.length <= maxLen) return text || '';
  return text.substring(0, maxLen) + '...';
}

/**
 * HTML 转义，防止 XSS 攻击
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的 HTML 字符串
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 显示浮动提示弹窗
 * @param {string} text - 提示文本
 * @param {number} duration - 显示时长（毫秒），默认 2200
 */
function showToast(text, duration = 2200) {
  let toast = document.getElementById('lingya-toast');
  if (!toast) {
    toast = document.createElement('div');
    // 【封号风险改造 2026-11-01】动态创建元素 id/class 也换前缀，防页面 querySelectorAll('[id^="lingya-"]') 命中
    toast.id = domPrefix.mapId('lingya-toast');
    toast.className = domPrefix.replacePrefix('lingya-toast');
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

/**
 * 显示带确认/取消按钮的持久提示框（不点击就一直存在）
 * @param {string} text - 提示文本
 * @param {object} [options] - 可选配置
 * @param {string} [options.okText] - 确定按钮文字，默认「确定」
 * @param {boolean} [options.showCancel] - 是否显示取消按钮，默认 false
 * @param {string} [options.cancelText] - 取消按钮文字，默认「取消」
 * @returns {Promise<boolean>} 用户点确定 resolve(true)，点取消 resolve(false)
 */
function showConfirmDialog(text, options) {
  const opts = options || {};
  const okText = opts.okText || '确定';
  const showCancel = !!opts.showCancel;
  const cancelText = opts.cancelText || '取消';

  // 移除旧弹窗
  const old = document.getElementById('lingya-confirm-dialog');
  if (old) old.remove();

  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    // 【封号风险改造 2026-11-01】动态 id 也走前缀替换
    dialog.id = domPrefix.mapId('lingya-confirm-dialog');
    dialog.style.cssText = `
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483648;
      min-width: 280px; max-width: 380px;
      background: rgba(22, 24, 44, 0.96);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(139, 147, 255, 0.35);
      border-radius: 14px;
      padding: 20px 18px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: #dde1ff; font-size: 13px; line-height: 1.6;
      box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);
      text-align: center;
    `;
    const cancelBtnHtml = showCancel
      ? `<button id="lingya-confirm-cancel" style="
          padding: 9px 24px; border: 1px solid rgba(139,147,255,0.4); border-radius: 10px;
          background: transparent; color: #aab0ff;
          font-size: 13px; font-weight: 600; cursor: pointer;
          margin-right: 10px; transition: all 0.2s;
        ">${cancelText}</button>`
      : '';
    // innerHTML 已被劫持，'lingya-' 前缀自动替换
    dialog.innerHTML = `
      <div style="margin-bottom:16px;white-space:pre-wrap;word-break:break-word;">${text}</div>
      <div>${cancelBtnHtml}
        <button id="lingya-confirm-ok" style="
          padding: 9px 28px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #8b93ff, #6d76ff); color: #fff;
          font-size: 13px; font-weight: 600; cursor: pointer;
          transition: all 0.2s;
        ">${okText}</button>
      </div>
    `;
    document.body.appendChild(dialog);

    const cleanup = () => dialog.remove();
    dialog.querySelector('#lingya-confirm-ok').addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
    if (showCancel) {
      dialog.querySelector('#lingya-confirm-cancel').addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
    }
  });
}

/**
 * 悬浮球状态：idle（空闲）/ generating（AI 生成中）/ executing（工具执行中）
 * 悬浮球始终可见，用颜色 + 文字标签提示当前是否还在处理。
 */
let fabState = 'idle';

/**
 * 设置悬浮球状态
 * @param {'idle'|'generating'|'executing'} next
 */
function setFabState(next) {
  fabState = next || 'idle';
  const badge = document.getElementById('lingya-status-badge');
  const label = document.getElementById('lingya-fab-label');
  if (!badge) return;
  badge.classList.remove('lingya-state-idle', 'lingya-state-generating', 'lingya-state-executing', 'lingya-state-stopped', 'lingya-state-done');
  badge.classList.add('lingya-state-' + fabState);
  const text = fabState === 'generating' ? 'AI 生成中（右键停止）'
    : fabState === 'executing' ? '执行中（右键停止）'
    : fabState === 'done' ? '✅ 任务完成'
    : fabState === 'stopped' ? '已停止（发消息恢复）' : '';
  if (label) {
    label.textContent = text;
    label.classList.toggle('lingya-hidden', !text);
  }
  badge.title = text ? ('LingYa - ' + text) : 'LingYa';
  // 生成中/执行中显示「停止」按钮；空闲/已停止隐藏
  const stopBtn = document.getElementById('lingya-btn-stop');
  if (stopBtn) {
    stopBtn.classList.toggle('lingya-hidden', !(fabState === 'generating' || fabState === 'executing'));
  }
}

/** 获取当前悬浮球状态 */
function getFabState() {
  return fabState;
}

// ===== 统一任务状态条 =====
// 状态机（task-state）是唯一真相源；本函数只是它的一个渲染器。
// 无论任务在进行中、等待 AI 响应、还是后台任务未结束，只要状态机非 IDLE，
// 状态条就持续显示，并且秒级刷新已用时 —— 不再因为「等了很久」而消失。
let taskbarUnsub = null;

/** 把毫秒格式化成 12s / 3m24s / 1h02m */
function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/**
 * 渲染任务状态条
 * @param {object} snap 状态机快照
 */
function renderTaskbar(snap) {
  const bar = document.getElementById('lingya-taskbar');
  const textEl = document.getElementById('lingya-taskbar-text');
  const elapsedEl = document.getElementById('lingya-taskbar-elapsed');
  if (!bar) return;

  const bgCount = backgroundTasks.size;
  if ((!snap || snap.state === 'IDLE') && bgCount === 0) {
    bar.classList.add('lingya-hidden');
    reportTaskState({ visible: false });   // 同步隐藏到侧边栏
    return;
  }
  bar.classList.remove('lingya-hidden');

  // 状态 → 文案 + 配色
  const state = snap ? snap.state : 'IDLE';
  let text = '';
  let kind = 'busy';
  if (state === 'SENT') { text = '已发送，等待 AI 响应…'; kind = 'busy'; }
  else if (state === 'AWAITING') { text = 'AI 正在思考 / 生成中…'; kind = 'busy'; }
  else if (state === 'RESPONDED') {
    // 队列被长任务占住时，回复已到但还没轮到处理。
    // 不区分会导致「正在解析」挂几分钟，看起来像卡死。
    text = snap.queued ? '已收到回复，排队等待处理…' : '正在解析回复…';
    kind = 'busy';
  }
  else if (state === 'EXECUTING') {
    // 带上具体工具名/后台任务信息（由 setTaskbarDetail 注入）
    text = taskbarDetail || '正在执行工具…';
    kind = 'executing';
  }

  // 后台任务：即使 AI 这一轮已经结束（IDLE），只要还有后台任务在跑就继续显示
  if (bgCount > 0) {
    const first = backgroundTasks.values().next().value;
    const bgText = bgCount === 1
      ? ('后台任务运行中：' + (first.command || '(未知命令)'))
      : (bgCount + ' 个后台任务运行中');
    if (!text) { text = bgText; kind = 'background'; }
    else { text += '　|　' + bgText; }
  }
  if (taskbarExtraCount > 0) text += '（另有 ' + taskbarExtraCount + ' 个进行中）';
  bar.setAttribute('data-kind', kind);
  if (textEl) textEl.textContent = text;

  // 计时：优先显示当前状态的停留时长；只有后台任务时显示最早那个任务的运行时长
  let ms = 0;
  if (snap && state !== 'IDLE') {
    ms = Date.now() - (Number(snap.enteredAt) || Date.now());
  } else if (bgCount > 0) {
    let oldest = Date.now();
    for (const t of backgroundTasks.values()) {
      if (t.startedAt < oldest) oldest = t.startedAt;
    }
    ms = Date.now() - oldest;
  }
  if (elapsedEl) elapsedEl.textContent = ms > 0 ? formatElapsed(ms) : '';

  // 上报给主进程 → 转发到壳窗口侧边栏。
  // 侧边栏是独立 webContents，拿不到这里的 task-state / backgroundTasks，
  // 必须显式上报。放在 renderTaskbar 末尾是因为它是唯一的状态汇聚点 ——
  // 所有状态变化最终都会走到这里，不用在每处 transition 里重复上报。
  reportTaskState({ visible: true, text: text, kind: kind, elapsedMs: ms });
}

// 上报节流：内容不变就不重发（秒级心跳会每秒触发 renderTaskbar）
let lastReportedSig = '';

/**
 * 把当前任务状态上报给主进程（主进程转发到壳窗口侧边栏）
 * @param {object} payload { visible, text, kind, elapsedMs }
 */
function reportTaskState(payload) {
  try {
    const api = window.electronAPI;
    if (!api || typeof api.reportTaskState !== 'function') return;
    const sig = payload.visible
      ? (payload.kind + '|' + payload.text + '|' + Math.floor(payload.elapsedMs / 1000))
      : 'hidden';
    if (sig === lastReportedSig) return;   // 内容没变（含计时秒数），不重发
    lastReportedSig = sig;
    api.reportTaskState(payload);
  } catch (_) { /* 上报失败不影响本地渲染 */ }
}

// 状态条的可选明细（工具名 / 后台任务描述）与并行计数
let taskbarDetail = '';
let taskbarExtraCount = 0;

// ===== 后台任务登记表 =====
// 为什么单独维护：后台任务（bashBackground 起的服务/爬虫）在 AI 一轮对话结束后
// 仍可能在跑，但状态机会回到 IDLE。只靠状态机，状态条会在任务还活着时消失 ——
// 用户就看不到「还有个 npm run dev 在跑」。
// 这里按 taskId 登记，只要表非空，状态条就保持可见（即使状态机是 IDLE）。
const backgroundTasks = new Map();  // taskId -> { command, startedAt }

/** 登记一个后台任务（bashBackground 成功后调用） */
function addBackgroundTask(taskId, command) {
  if (!taskId) return;
  backgroundTasks.set(String(taskId), {
    command: String(command || '').slice(0, 60),
    startedAt: Date.now(),
  });
  try { renderTaskbar(require('../dom/task-state').snapshot()); } catch (_) {}
}

/** 注销一个后台任务（已完成/被终止时调用） */
function removeBackgroundTask(taskId) {
  if (!taskId) return;
  if (!backgroundTasks.delete(String(taskId))) return;
  try { renderTaskbar(require('../dom/task-state').snapshot()); } catch (_) {}
}

/** 当前后台任务数量（测试/诊断用） */
function backgroundTaskCount() {
  return backgroundTasks.size;
}

/** 清空（用户点停止时调用） */
function clearBackgroundTasks() {
  backgroundTasks.clear();
  try { renderTaskbar(require('../dom/task-state').snapshot()); } catch (_) {}
}

/**
 * 设置状态条明细（由 tool-executor / 后台任务调用），空字符串表示清除。
 * 只在状态机为 EXECUTING 时生效，避免和「AI 生成中」文案打架。
 */
function setTaskbarDetail(detail, extraCount) {
  taskbarDetail = String(detail || '');
  taskbarExtraCount = Number(extraCount) > 0 ? Math.floor(Number(extraCount)) : 0;
  try {
    const taskState = require('../dom/task-state');
    renderTaskbar(taskState.snapshot());
  } catch (_) { /* ignore */ }
}

/**
 * 订阅状态机：状态一变（或每秒心跳）就刷新状态条。
 * 幂等，重复调用只保留一个订阅。
 */
function startTaskbar() {
  if (taskbarUnsub) return;
  let taskState;
  try { taskState = require('../dom/task-state'); } catch (_) { return; }
  taskbarUnsub = taskState.onChange((snap) => {
    try { renderTaskbar(snap); } catch (_) {}
  });
  try { taskState.startTicker(); } catch (_) {}
}

/** 停止订阅（测试/销毁时用） */
function stopTaskbar() {
  if (taskbarUnsub) { taskbarUnsub(); taskbarUnsub = null; }
  try { require('../dom/task-state').stopTicker(); } catch (_) {}
}


/**
 * 设置「停止」状态：更新悬浮球为已停止、同步停止按钮显隐。
 * @param {boolean} stopped
 */
function setStopped(stopped) {
  const badge = document.getElementById('lingya-status-badge');
  const stopBtn = document.getElementById('lingya-btn-stop');
  const resumable = document.getElementById('lingya-stopped-hint');
  if (badge) {
    badge.classList.toggle('lingya-state-stopped', !!stopped);
  }
  if (stopBtn) stopBtn.classList.toggle('lingya-hidden', !!stopped);
  if (resumable) resumable.classList.toggle('lingya-hidden', !stopped);
  if (stopped) {
    setFabState('stopped');
  } else if (fabState === 'stopped') {
    setFabState('idle');
  }
}

/** 是否处于已停止状态 */
function isStopped() {
  return fabState === 'stopped';
}

/** 任务完成标志定时器（done 态几秒后自动回 idle） */
let doneTimer = null;

/**
 * 标记任务完成：悬浮球变绿色「✅ 任务完成」+ 弹提示，几秒后自动回空闲。
 * 由 intercept-observer 在"AI 纯文本收尾、无后续工具"时调用。
 * 已停止状态不覆盖。
 */
function markTaskDone() {
  if (fabState === 'stopped') return;
  setFabState('done');
  showToast('✅ 任务完成', 3000);
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    if (fabState === 'done') setFabState('idle');
  }, 5000);
}

/**
 * 设置任务状态（检测到任务：后面的执行中提示）
 * 同时联动悬浮球：执行中显示橙色，结束后若仍有生成则回到蓝色。
 * @param {boolean} running - 是否执行中
 */
function setTaskStatus(running) {
  const status = document.getElementById('lingya-task-status');
  if (status) {
    status.classList.toggle('lingya-hidden', !running);
  }
  if (running) {
    setFabState('executing');
  } else if (fabState === 'executing') {
    setFabState('idle');
  }
  // 已停止状态优先，不被执行结束覆盖
  if (fabState === 'idle' && document.getElementById('lingya-status-badge') &&
      document.getElementById('lingya-status-badge').classList.contains('lingya-state-stopped')) {
    setFabState('stopped');
  }
}

/**
 * 显示覆盖层（移除 hidden 类）
 */
function showOverlay() {
  const el = document.getElementById('lingya-overlay');
  if (el) el.classList.remove('lingya-hidden');
}

/**
 * 隐藏覆盖层（添加 hidden 类）
 */
function hideOverlay() {
  const el = document.getElementById('lingya-overlay');
  if (el) el.classList.add('lingya-hidden');
}

/**
 * 应用悬浮元素显隐设置（读 localStorage）：
 *   lingya-hide-floating=1 → 隐藏悬浮球 + 覆盖层面板
 *   lingya-hide-plan-float=1 → 隐藏计划悬浮卡
 */
function applyFloatSettings() {
  let hideFloating = false, hidePlan = false;
  try {
    hideFloating = localStorage.getItem('lingya-hide-floating') === '1';
    hidePlan = localStorage.getItem('lingya-hide-plan-float') === '1';
  } catch (_) {}
  const badge = document.getElementById('lingya-status-badge');
  const overlay = document.getElementById('lingya-overlay');
  const planFloat = document.getElementById('lingya-plan-float');
  if (badge) badge.style.display = hideFloating ? 'none' : '';
  if (overlay && hideFloating) overlay.classList.add('lingya-hidden');
  if (planFloat) planFloat.style.display = hidePlan ? 'none' : '';
}


/**
 * 显示命令预览并展开覆盖层
 * @param {Object} cmdData - 命令数据对象，包含 command、timestamp、id 等字段
 */
function displayCommand(cmdData) {
  currentCommand = cmdData;
  const preview = document.getElementById('lingya-cmd-preview');
  const resultSection = document.getElementById('lingya-result-section');
  if (preview) preview.textContent = cmdData.command;
  if (resultSection) resultSection.classList.add('lingya-hidden');
  showToast('发现可执行的命令');
}

/**
 * 确认执行当前显示的命令
 * 已移除：确认执行按钮及相关交互。保留空函数以防其他引用。
 */
async function handleExecute() {
}

/**
 * 忽略当前命令
 * 已移除：忽略按钮及相关交互。保留空函数以防其他引用。
 */
function handleIgnore() {
}

/**
 * 添加一条历史记录
 * @param {Object} entry - 历史记录对象，包含 id、command、success、canceled、output、timestamp 等字段
 */
function addHistory(entry) {
  // 2026-11-05: 写入面板历史前还原占位符，让用户看到真词
  try {
    const { unredactText } = require('../dom/redaction-filter');
    if (unredactText && entry) {
      const e = Object.assign({}, entry);
      if (typeof e.command === 'string') e.command = unredactText(e.command);
      if (typeof e.output === 'string') e.output = unredactText(e.output);
      entry = e;
    }
  } catch (_) {}
  commandHistory.unshift(entry);
  if (commandHistory.length > 50) commandHistory.pop();
  renderHistory();
  try { ipcRenderer.send('lingya-report-history', { entry: entry, total: commandHistory.length }); } catch (_) {}
}

/**
 * 渲染历史记录列表
 * 将 commandHistory 中的记录渲染到界面，并为每条记录绑定点击事件以查看详情
 */
function renderHistory() {
  const list = document.getElementById('lingya-history-list');
  if (!list) return;

  if (commandHistory.length === 0) {
    list.innerHTML = '<div style="color:#666;font-size:12px;font-style:italic;padding:8px 0;">暂无记录</div>';
    return;
  }

  const items = commandHistory.slice(0, 20);
  list.innerHTML = items.map((item) => `
    <div class="lingya-history-item" data-id="${escapeHtml(item.id)}">
      <span class="lingya-cmd-text">${escapeHtml(truncate(item.command, 60))}</span>
      <span class="lingya-cmd-status ${item.canceled ? '' : item.success ? 'success' : 'error'}">
        ${item.canceled ? '⏹ 已忽略' : item.success ? '✅ 成功' : '❌ 失败'}
      </span>
      <span class="lingya-cmd-time">${formatTime(item.timestamp)}</span>
    </div>
  `).join('');

  list.querySelectorAll('.lingya-history-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const entry = commandHistory.find((h) => h.id === id);
      if (entry) {
        const preview = document.getElementById('lingya-cmd-preview');
        const resultSection = document.getElementById('lingya-result-section');
        const resultStatus = document.getElementById('lingya-result-status');
        const resultOutput = document.getElementById('lingya-result-output');
        if (preview) preview.textContent = entry.command;
        if (entry.output && resultSection) {
          resultSection.classList.remove('lingya-hidden');
          if (resultStatus) {
            resultStatus.textContent = entry.canceled ? '⏹ 已忽略' : entry.success ? '✅ 执行成功' : '❌ 执行失败';
            resultStatus.className = `lingya-result-status ${entry.success ? 'success' : 'error'}`;
          }
          if (resultOutput) resultOutput.textContent = entry.output || '(无输出)';
        }
        showOverlay();
      }
    });
  });
}

/**
 * 闪烁状态徽章提示
 */
function flashBadge() {
  const badge = document.getElementById('lingya-status-badge');
  const dot = document.getElementById('lingya-status-dot');
  if (badge) {
    badge.style.background = 'rgba(124,255,178,0.25)';
    badge.style.borderColor = 'rgba(124,255,178,0.6)';
    setTimeout(() => {
      badge.style.background = 'rgba(139, 147, 255, 0.22)';
      badge.style.borderColor = 'rgba(139, 147, 255, 0.4)';
    }, 3000);
  }
  if (dot) {
    dot.style.background = '#ffc107';
    dot.style.animation = 'none';
    setTimeout(() => {
      dot.style.background = '#7cffb2';
      dot.style.animation = 'lingya-pulse 2s infinite';
    }, 3000);
  }
}

/**
 * 根据当前 URL 切换覆盖层首页模式
 * 首页 https://chat.deepseek.com/ 时，只保留「初始化项目」按钮，隐藏其他内容
 * 同时展示首次使用提示浮窗（居中）
 */
function updateHomeMode() {
  const url = window.location.href;
  const provider = getProviderByUrl(url);
  const isHome = provider && provider.homeUrlPattern ? provider.homeUrlPattern.test(url) : false;
  const overlay = document.getElementById('lingya-overlay');
  if (overlay) {
    if (isHome) {
      overlay.classList.add('lingya-home-mode');
      showFirstTimeDialog();
    } else {
      overlay.classList.remove('lingya-home-mode');
      hideFirstTimeDialog();
    }
  }
}


// 首次提示浮窗已移除（底部/侧边栏已有初始化项目按钮）。保留空实现，避免改动所有调用点。
function showFirstTimeDialog() {}
function hideFirstTimeDialog() {}

/**
 * 强制显示覆盖层（移除所有隐藏状态）
 * 用于兜底恢复因异常被隐藏的面板
 */
function forceShowOverlay() {
  const overlay = document.getElementById('lingya-overlay');
  if (overlay) {
    overlay.classList.remove('lingya-hidden');
    // 【BUG 修复 2026-11-01】原实现用 inline style 强制 opacity:1/pointer-events:auto，
    // inline 优先级高于 CSS 类的 .lingya-hidden{opacity:0}，导致「点击悬浮球切换显隐」时
    // class 切换了但视觉上没反应（opacity 一直是 1，或 panel 始终被挡住）。
    // 修复：清除 inline style 残留，让 CSS 类完全控制显隐。
    try {
      overlay.style.transform = '';
      overlay.style.opacity = '';
      overlay.style.pointerEvents = '';
    } catch (_) {}
  }
}

/**
 * 启动定期巡检，防止面板被意外隐藏（最小化、ESC、脚本错误等）
 * 每 5 秒检查一次，如果被隐藏则自动恢复
 */
function startOverlayWatcher() {
  // 方向 C：不再定期强制弹出面板，避免遮挡主界面。
}


/** 悬浮球尺寸的 localStorage 键 */
const FAB_SIZE_KEY = 'lingya-fab-size';
/** 可选尺寸档位 */
const FAB_SIZE_PRESETS = [44, 56, 64, 80];
/** 默认尺寸 */
const FAB_SIZE_DEFAULT = 64;

/**
 * 读取用户配置的悬浮球尺寸。
 * 非法值（非预设档位、非数字、localStorage 不可用）一律回退到默认，
 * 避免用户手改坏了之后悬浮球变成一个看不见的点。
 */
function getFabSize() {
  try {
    const raw = localStorage.getItem(FAB_SIZE_KEY);
    const n = parseInt(raw, 10);
    if (FAB_SIZE_PRESETS.indexOf(n) >= 0) return n;
  } catch (_) { /* localStorage 不可用 */ }
  return FAB_SIZE_DEFAULT;
}

/**
 * 应用悬浮球尺寸：写入 CSS 变量，容器/宠物/标签/状态点全部联动。
 * 不传参数时按 localStorage 的配置应用。
 * @param {number} [size] 目标像素值，会先校验是否为合法档位
 * @returns {number} 实际生效的尺寸
 */
function applyFabSize(size) {
  let target = typeof size === 'number' ? size : getFabSize();
  if (FAB_SIZE_PRESETS.indexOf(target) < 0) target = FAB_SIZE_DEFAULT;
  try {
    document.documentElement.style.setProperty('--lingya-fab-size', target + 'px');
  } catch (_) { /* document 不可用（测试环境） */ }
  // 同步按钮高亮状态
  try {
    const btns = document.querySelectorAll('#lingya-fab-size-switch .lingya-size-btn');
    for (let i = 0; i < btns.length; i++) {
      const v = parseInt(btns[i].getAttribute('data-size'), 10);
      if (v === target) btns[i].classList.add('lingya-size-btn-active');
      else btns[i].classList.remove('lingya-size-btn-active');
    }
  } catch (_) {}
  return target;
}

/**
 * 设置并持久化悬浮球尺寸。
 * @param {number} size 目标像素值
 * @returns {number} 实际生效的尺寸（非法输入时回退默认）
 */
function setFabSize(size) {
  let target = parseInt(size, 10);
  if (FAB_SIZE_PRESETS.indexOf(target) < 0) target = FAB_SIZE_DEFAULT;
  try { localStorage.setItem(FAB_SIZE_KEY, String(target)); } catch (_) {}
  return applyFabSize(target);
}

module.exports = {
  injectCSS,
  injectOverlay,
  generateId,
  formatTime,
  truncate,
  escapeHtml,
  showToast,
  showConfirmDialog,
  setTaskStatus,
  markTaskDone,
  setFabState,
  getFabState,
  startTaskbar,
  stopTaskbar,
  setTaskbarDetail,
  renderTaskbar,
  reportTaskState,
  addBackgroundTask,
  removeBackgroundTask,
  clearBackgroundTasks,
  backgroundTaskCount,
  setStopped,
  isStopped,
  showOverlay,
  hideOverlay,
  applyFloatSettings,
  displayCommand,
  handleExecute,
  handleIgnore,
  addHistory,
  renderHistory,
  commandHistory,
  flashBadge,
  updateHomeMode,
  showFirstTimeDialog,
  hideFirstTimeDialog,
  forceShowOverlay,
  startOverlayWatcher,
  getFabSize,
  setFabSize,
  applyFabSize,
  FAB_SIZE_PRESETS,
  FAB_SIZE_DEFAULT,
};
