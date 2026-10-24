/**
 * 自动重命名 —— 初始化项目完成后自动触发 AI 重命名
 *
 * 背景：手动点「AI 重命名」太麻烦。init-project 是「新会话正式开始工作」的信号，
 * 此时让 AI 回顾上下文（含刚注入的项目说明）自动起名最合适。
 *
 * 去重：任何一次重命名（AI 调 nameConversation / 手动改名 / 自动改名）都会写入
 * localStorage 的已命名集合，所以同一会话不会重复自动触发。
 *
 * 时机：init-project 成功后，等 AI 处理完初始化回复（fab 回到 idle），再发重命名指令。
 */

const STORAGE_KEY = 'lingya-auto-renamed-sessions';
const ENABLED_KEY = 'lingya-auto-rename-enabled'; // '0' 显式关闭；未设置默认开启
const INITIAL_DELAY_MS = 5000;   // 给 init 提示词留出送出时间
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 180000;      // 最多等 3 分钟
const IDLE_STREAK_REQUIRED = 2;  // 连续 2 次空闲才认为 AI 真的闲了

/** 开关（默认开启，localStorage 可关） */
function isEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) !== '0'; } catch (_) { return true; }
}

/** 已命名会话集合 */
function getRenamedSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) { return new Set(); }
}

function hasRenamed(sid) {
  if (!sid) return false;
  return getRenamedSet().has(sid);
}

function markRenamed(sid) {
  if (!sid) return;
  try {
    const s = getRenamedSet();
    if (s.has(sid)) return;
    s.add(sid);
    // 只保留最近 300 个，防止 localStorage 无限增长
    const arr = Array.from(s).slice(-300);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    console.log('[LingYa AutoRename] 标记会话已命名: ' + sid);
  } catch (_) { /* ignore */ }
}

/** 当前会话 ID */
function getCurrentSessionId() {
  try {
    const { getProviderByUrl } = require('../../providers');
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/** 从悬浮球徽标判断 AI 是否忙碌 */
function isAiBusy() {
  try {
    const el = document.getElementById('lingya-status-badge');
    if (!el) return false;
    return el.classList.contains('lingya-state-generating')
      || el.classList.contains('lingya-state-executing');
  } catch (_) { return false; }
}

// 只允许一个待触发的任务，避免多次 init 叠加
let _pending = null;
let _pollTimer = null;

/** 取消待触发的自动重命名 */
function cancel() {
  _pending = null;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

/**
 * init-project 成功后调用：等 AI 处理完初始化，再自动发重命名指令。
 * @param {object} [opts] { projectDir, isCompaction }
 */
function scheduleAfterInit(opts) {
  if (!isEnabled()) {
    console.log('[LingYa AutoRename] 已关闭（localStorage ' + ENABLED_KEY + '=0）');
    return;
  }
  cancel();
  const startedAt = Date.now();
  let idleStreak = 0;
  console.log('[LingYa AutoRename] 初始化完成，' + (INITIAL_DELAY_MS / 1000) + 's 后开始监测 AI 空闲状态');

  const tick = () => {
    _pollTimer = null;
    if (!_pending) return;
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      console.log('[LingYa AutoRename] 超时放弃（等待 AI 空闲超过 ' + (MAX_WAIT_MS / 1000) + 's）');
      cancel();
      return;
    }
    const sid = getCurrentSessionId();
    if (!sid) {
      // 还没拿到 sessionId：继续等
      _pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    if (hasRenamed(sid)) {
      console.log('[LingYa AutoRename] 会话 ' + sid + ' 已命名过，跳过');
      cancel();
      return;
    }
    if (isAiBusy()) {
      idleStreak = 0;
      _pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    idleStreak++;
    if (idleStreak < IDLE_STREAK_REQUIRED) {
      _pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    // AI 空闲稳定 → 发重命名指令
    cancel();
    doRename(sid);
  };

  _pending = { startedAt };
  // 先等 INITIAL_DELAY_MS，让 init 提示词有足够时间送达并触发生成
  _pollTimer = setTimeout(() => {
    if (!_pending) return;
    tick();
  }, INITIAL_DELAY_MS);
}

/** 真正发送重命名指令 */
async function doRename(sid) {
  try {
    const { sendToChat } = require('./chat-input');
    const prompt = [
      '帮我总结一下咱们刚才聊的核心内容，然后用 nameConversation 工具给这个对话起个短标题（不超过20字）。',
      '直接调工具就行，不用解释。',
    ].join('\n');
    console.log('[LingYa AutoRename] 发送自动重命名指令: ' + sid);
    const ok = await sendToChat(prompt, '自动重命名', 300);
    if (ok) {
      // 立刻标记，防止重复触发（即便 AI 最终没调工具，也不再重发）
      markRenamed(sid);
    } else {
      console.log('[LingYa AutoRename] 发送失败（输入框不可用）');
    }
  } catch (e) {
    console.error('[LingYa AutoRename] 失败:', e && e.message);
  }
}

module.exports = {
  scheduleAfterInit,
  cancel,
  hasRenamed,
  markRenamed,
  getCurrentSessionId,
};
