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
// 会话「空」稳定性计数：连续观察多少次仍为空才注入。
//
// 为什么需要：打开历史对话时 URL 立刻变成会话 ID，但消息内容是异步加载的。
// 若只判断一次，可能在 DOM 还没渲染出消息时就误判为「新会话」并注入。
// 要求连续 3 次（约 6 秒）都确认无消息，才认为是真的空会话。
// 代价：新会话首次注入延迟约 6 秒（用户此刻通常还在打字，无感）。
const EMPTY_CONFIRM_POLLS = 3;
let emptyPollCount = 0;
let emptyPollSessionId = null;

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

/**
 * 判断当前会话是否已有消息内容（历史对话 / 已开始的对话）。
 *
 * 为什么需要：原判据是「这个会话 ID 我没见过就注入」——
 * 但历史对话当然也没见过。启动时基线在首页（sid=null），用户点开任何
 * 历史对话，sid 从 null 变成历史 ID，就被误判为「新会话」并注入，
 * 表现为打开旧对话时整段系统提示词被当成用户消息发进去。
 *
 * 选择器策略与 dom-fallback.js 一致：多组模糊匹配，命中任一即认为有内容。
 * 宁可漏注入（用户手动初始化）也不要误注入（污染历史对话）。
 */
function hasExistingMessages() {
  try {
    // AI 回复的 markdown 容器（DeepSeek 主选择器）
    if (document.querySelector('.ds-markdown')) return true;
    // 用户消息气泡（DeepSeek 类名片段，见 dom-fallback 的 USER_MESSAGE_HINTS）
    if (document.querySelector('[class*="fbb737a4"]')) return true;
    // 通用兜底：主流聊天站的 markdown / prose 容器
    if (document.querySelector('main [class*="prose"]')) return true;
  } catch (_) { /* DOM 不可用时保守返回 false */ }
  return false;
}

/** 检查并执行自动注入 */
function maybeInject() {
  const sid = getSessionId();

  // ===== 【新增】优先处理「会话迁移」待承接数据 =====
  // 使用 localStorage 状态机，避免页面刷新导致 setTimeout 丢失
  const pendingMig = localStorage.getItem('lingya-pending-migration');
  if (pendingMig) {
    let data = {};
    try { data = JSON.parse(pendingMig); } catch (_) {}
    if (!data.stage) data.stage = 'init';

    // 阶段 1：等待输入框，并执行项目初始化
    if (data.stage === 'init') {
      const input = document.querySelector('textarea[placeholder*="发送"], textarea[placeholder*="输入"], textarea');
      if (!input) return; // 等待页面加载

      console.log('[LingYa 迁移] 已到达首页，准备初始化项目并注入历史（长度=' + (data.history ? data.history.length : 0) + '）');
      require('./../overlay/ui').showToast('正在承接上一个会话的历史...', 4000);
      
      if (data.projectDir) {
        try { window.electronAPI.initProject(data.projectDir, false); } catch (_) {}
      }
      
      data.stage = 'wait';
      data.initAt = Date.now();
      localStorage.setItem('lingya-pending-migration', JSON.stringify(data));
      return;
    }

    // 阶段 2：等待系统提示词发送完毕（延时），然后发出历史
    if (data.stage === 'wait') {
      // 超时 60 秒，如果项目初始化死锁，直接清理，防止永久卡死
      if (Date.now() - data.initAt > 60000) {
        localStorage.removeItem('lingya-pending-migration');
        console.error('[LingYa 迁移] 初始化等待超时，取消迁移');
        return;
      }
      
      // 用户如果是手动点了停止，就尊重用户，不发了
      const state = require('./state');
      if (state.stopped) {
        localStorage.removeItem('lingya-pending-migration');
        console.log('[LingYa 迁移] 检测到用户已停止，取消发送历史');
        return;
      }

      if (Date.now() - data.initAt > 8000) {
        const input = document.querySelector('textarea[placeholder*="发送"], textarea[placeholder*="输入"], textarea');
        if (!input) return;

        console.log('[LingYa 迁移] 延时已到，准备发送历史');
        try {
          // 解除停止状态，允许发送
          state.stopped = false;
          state.stoppedAt = 0;
          if (window.electronAPI && window.electronAPI.clearAbort) {
            window.electronAPI.clearAbort();
          }
          state.initializationDone = true;
          state.pendingInitialPrompt = false;

          const msg = '【历史上下文承接】\n以下是上一个会话的完整历史记录，请仔细阅读并继续之前的工作。\n\n' + data.history;
          console.log('[LingYa 迁移] 准备调用 sendMessageToChat, 长度=' + msg.length);
          
          // 发送成功，才标记为 sent
          require('./chat-input').sendMessageToChat(msg, '历史迁移', { auto: true });
          
          data.stage = 'sent';
          localStorage.setItem('lingya-pending-migration', JSON.stringify(data));
          console.log('[LingYa 迁移] sendMessageToChat 调用完成，标记为已发送');
        } catch (e) {
          console.error('[LingYa 迁移] 发送历史异常，取消迁移:', e);
          localStorage.removeItem('lingya-pending-migration');
        }
      }
      return;
    }

    // 阶段 3：已发送，清理状态，并静默删除旧会话
    if (data.stage === 'sent') {
      localStorage.removeItem('lingya-pending-migration');
      console.log('[LingYa 迁移] 历史迁移流程全部结束');
      
      // 静默删除旧会话
      if (data.oldSessionId) {
        console.log('[LingYa 迁移] 开始执行静默删除: ' + data.oldSessionId);
        try {
          const archiver = require('./deepseek-history-archiver');
          if (archiver.deleteSessionSilent) {
            archiver.deleteSessionSilent(data.oldSessionId).then((ok) => {
              if (ok) require('./../overlay/ui').showToast('旧会话已自动删除', 3000);
            });
          } else {
            console.error('[LingYa 迁移] archiver.deleteSessionSilent 不存在');
          }
        } catch (e) {
          console.error('[LingYa 迁移] 调用静默删除失败:', e);
        }
      } else {
        console.log('[LingYa 迁移] 没有拿到 oldSessionId，跳过删除');
      }
      return;
    }
  }
  // ===== 迁移处理结束 =====

  if (!isEnabled()) return;
  if (!sid) return;                         // 首页/无会话：等待
  if (sid === lastInjectedSessionId) return; // 该会话已注入过

  // 【关键】已有消息 = 历史对话或已开始的对话，绝不能注入。
  // 注入会把整段系统提示词当作一条用户消息发进去，直接污染对话内容。
  if (hasExistingMessages()) {
    lastInjectedSessionId = sid;
    emptyPollCount = 0;
    emptyPollSessionId = null;
    console.log('[LingYa AutoInject] 会话 ' + sid + ' 已有消息（历史对话），跳过自动注入');
    return;
  }

  // 【稳定性守卫】DOM 可能还没渲染出消息，不能凭一次空判定就注入。
  // 要求连续 EMPTY_CONFIRM_POLLS 次（同一会话）都为空，才认为确实是新会话。
  if (emptyPollSessionId !== sid) {
    // 换了会话，重新计数
    emptyPollSessionId = sid;
    emptyPollCount = 1;
    return;
  }
  emptyPollCount++;
  if (emptyPollCount < EMPTY_CONFIRM_POLLS) {
    return;   // 继续观察，暂不注入
  }

  const dir = getLastDir();
  if (!dir) return;                         // 无记住的目录：退回手动（方案 A）
  lastInjectedSessionId = sid;
  emptyPollCount = 0;
  emptyPollSessionId = null;
  // 新会话：清空任务型标记，避免上一会话的状态串到新会话
  try { require('./state').resetTaskFlags(); } catch (_) {}
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
  emptyPollCount = 0;
  emptyPollSessionId = null;
  timer = setInterval(maybeInject, 2000);
  console.log('[LingYa AutoInject] 新会话自动注入监视已启动（基线会话=' + lastInjectedSessionId + '）');
}

module.exports = { startAutoInjectWatcher, maybeInject, markSessionInjected, getCurrentSessionId, hasExistingMessages };
