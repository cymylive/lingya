/**
 * 新会话自动注入
 *
 * 目的：开启后，每进入一个新会话自动执行一次项目初始化，
 * 从而把「长期记忆 + 已启用技能」随系统提示词一起注入，AI 无需手动操作即可看到。
 *
 * 前提（方案 A）：首次仍需用户手动点一次「初始化项目」以确定项目目录；
 * 之后目录被记住（localStorage: lingya-last-project-dir），新会话自动复用。
 *
 * 开关：localStorage: lingya-auto-inject（'1' 开启）
 * 去重：同一会话只注入一次（按会话 ID 记忆）。
 */
const { getProviderByUrl } = require('../../../src/providers');

let timer = null;
let lastInjectedSessionId = null;

/** 是否开启自动注入 */
function isEnabled() {
  try { return localStorage.getItem('lingya-auto-inject') === '1'; } catch (_) { return false; }
}

/** 取最近记住的项目目录（无则 null） */
function getLastDir() {
  try {
    const d = localStorage.getItem('lingya-last-project-dir');
    return d && d.trim() ? d : null;
  } catch (_) { return null; }
}

/** 取当前页面会话 ID（首页/无会话返回 null） */
function getSessionId() {
  try {
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/** 检查并执行自动注入 */
function maybeInject() {
  if (!isEnabled()) return;
  const sid = getSessionId();
  if (!sid) return;                         // 首页/无会话：等待
  if (sid === lastInjectedSessionId) return; // 该会话已注入过
  const dir = getLastDir();
  if (!dir) return;                         // 无记住的目录：退回手动（方案 A）
  lastInjectedSessionId = sid;
  console.log('[LingYa AutoInject] 新会话 ' + sid + '，自动注入记忆+技能（目录=' + dir + '）');
  try {
    window.electronAPI.initProject(dir, false);
  } catch (err) {
    console.error('[LingYa AutoInject] 自动注入失败:', err && err.message);
  }
}

/** 标记某会话已注入（供手动初始化后调用，避免重复注入） */
function markSessionInjected(sid) {
  if (sid) lastInjectedSessionId = sid;
}

/** 取当前会话 ID（供外部调用） */
function getCurrentSessionId() {
  return getSessionId();
}

/** 启动新会话自动注入监视（轮询会话 ID 变化） */
function startAutoInjectWatcher() {
  if (timer) return;
  // 基线：把"当前已打开的会话"视为已处理，只对之后新出现的会话注入，
  // 避免启动瞬间对已在进行的对话重复注入。
  lastInjectedSessionId = getSessionId();
  timer = setInterval(maybeInject, 2000);
  console.log('[LingYa AutoInject] 新会话自动注入监视已启动（基线会话=' + lastInjectedSessionId + '）');
}

module.exports = { startAutoInjectWatcher, maybeInject, markSessionInjected, getCurrentSessionId };
