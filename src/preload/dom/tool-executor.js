/**
 * 工具/JS 脚本执行器（与回复获取方式无关）
 * 拦截模式和 DOM 模式共用的执行逻辑：执行工具调用、执行 JS 脚本、通知 UI。
 */
const { showToast, setTaskStatus, addHistory, truncate, flashBadge, setTaskbarDetail, addBackgroundTask, removeBackgroundTask } = require('../overlay/ui');
const { sendToolResultToChat } = require('./chat-input');
const state = require('./state');
const { upsertToolCard } = require('../overlay/tool-card');
const { withTimeout, TIMEOUTS } = require('./timeout');
const idempotency = require('./idempotency');

// 是否正在执行命令或工具
let isExecuting = false;

// 历史记录单条输出上限（防止大输出常驻内存）
const HISTORY_OUTPUT_LIMIT = 8 * 1024;  // 8KB

/**
 * 截断历史记录的输出，避免大结果常驻内存
 * @param {string} text
 * @returns {string}
 */
function clipForHistory(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= HISTORY_OUTPUT_LIMIT) return s;
  return s.slice(0, HISTORY_OUTPUT_LIMIT) + String.fromCharCode(10) + '...（历史记录已截断，完整输出仅当次可见）';
}

/**
 * 通知用户检测到工具调用（闪烁状态徽章 + 更新预览）
 */
/**
 * 渲染/更新工具卡片（仿 dsh ui-tool）。
 *
 * 【BUG 修复】原实现只在「执行完成后」调一次，且卡片所在的 #lingya-result-section 默认带
 * lingya-hidden，用户要手动展开覆盖层「日志」页签才看得到，执行过程中完全无反馈 —— 表现为
 * 「AI 说了要调工具，界面上什么都没有」，误以为工具没跑。
 * 现在：执行前先插入 running 卡片（并自动展开结果区），完成后按 cardId 原地替换。
 *
 * @param {string} cardId 卡片唯一 id，用于原地更新
 * @param {string} name 工具名
 * @param {*} args 参数
 * @param {'running'|'success'|'error'} status 状态
 * @param {*} output 输出（running 时为空）
 */
function renderResultCard(cardId, name, args, status, output) {
  const box = document.getElementById('lingya-tool-cards');
  if (!box) return;
  // 有卡片了就把结果区展开，保证用户立刻能看到执行反馈
  const section = document.getElementById('lingya-result-section');
  if (section) section.classList.remove('lingya-hidden');
  upsertToolCard(box, {
    cardId: cardId,
    name: name,
    args: args,
    status: status,
    output: output
  });
}

function notifyToolCallDetected(toolCall) {
  const preview = document.getElementById('lingya-cmd-preview');
  if (preview) {
    preview.textContent = '[工具] ' + toolCall.toolName + '\n参数: ' + JSON.stringify(toolCall.params, null, 2);
  }
  flashBadge('LingYa - 工具调用检测到');
}

/**
 * 通知用户检测到 JS 工具脚本（更新预览 + 闪烁徽章）
 */
function notifyJsScriptDetected(code) {
  const preview = document.getElementById('lingya-cmd-preview');
  if (preview) {
    preview.textContent = '[JS 工具脚本]' + String.fromCharCode(10) + code;
  }
  flashBadge('LingYa - JS 工具脚本检测到');
}

/**
 * 执行检测到的 JS 工具脚本
 * @param {string} code
 * @returns {Promise<{code: string, result: object}>}
 */
async function handleJsToolScript(code) {
  state.touch(); // 脚本执行 = 有活动
  // 已停止：不再执行新脚本
  if (state.stopped) {
    console.log('[LingYa] 已停止，跳过 JS 脚本执行');
    return { code, result: { success: false, error: '任务已被用户停止' } };
  }
  isExecuting = true;
  notifyJsScriptDetected(code);
  setTaskStatus(true);
  showToast('开始执行命令');

  const callId = 'js_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  console.log('[LingYa] [诊断] 即将执行的代码(JSON转义): ' + JSON.stringify(code));
  // 执行前先出卡片：让用户立刻看到「正在跑」，而不是等结束后才出现
  renderResultCard(callId, 'JS 脚本', code.slice(0, 60), 'running', '执行中…');
  try { setTaskbarDetail('正在执行 JS 脚本…'); } catch (_) {}
  try {
    // 幂等检查：同一份代码重复执行大概率是重试，复用上次结果，
    // 配合状态机/DOM 兜底的重试机制，让重试不会造成重复副作用。
    const jsIdemScope = state.currentProjectDir || '';
    let cachedJs = null;
    try { cachedJs = idempotency.lookup('__js_script__', { code: code }, jsIdemScope); } catch (_) { cachedJs = null; }

    let result;
    if (cachedJs) {
      console.log('[LingYa] JS 脚本命中幂等缓存，跳过实际执行');
      result = cachedJs;
    } else {
      // 超时保护：主进程崩溃/IPC 失效时，await 会永久挂起，导致整个队列卡死
      result = await withTimeout(
        window.electronAPI.executeJs(code, callId),
        TIMEOUTS.executeJs,
        'JS 脚本执行'
      );
      if (result && result.success) {
        try { idempotency.record('__js_script__', { code: code }, result, jsIdemScope); } catch (_) {}
      }
    }

    const resultSection = document.getElementById('lingya-result-section');
    const resultStatus = document.getElementById('lingya-result-status');
    const resultOutput = document.getElementById('lingya-result-output');
    if (resultSection) resultSection.classList.remove('lingya-hidden');

    if (result.success) {
      if (resultStatus) {
        resultStatus.textContent = '✅ JS 脚本执行成功';
        resultStatus.className = 'lingya-result-status success';
      }
      if (resultOutput) {
        resultOutput.textContent = result.output || '(脚本执行完成，无输出)';
      }
      renderResultCard(callId, 'JS 脚本', code.slice(0, 60), 'success', result.output || '(无输出)');
    } else {
      if (resultStatus) {
        resultStatus.textContent = '❌ JS 脚本执行失败';
        resultStatus.className = 'lingya-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
      renderResultCard(callId, 'JS 脚本', code.slice(0, 60), 'error', result.error || '未知错误');
    }

    addHistory({
      id: callId,
      command: '[JS] ' + truncate((code.split(String.fromCharCode(10))[0] || code), 60),
      success: result.success,
      output: clipForHistory(result.success ? (result.output || '') : (result.error || '未知错误')),
      timestamp: Date.now(),
    });

    return { code, result };
  } catch (err) {
    console.error('[LingYa] JS 工具脚本执行异常:', err);
    const resultSection = document.getElementById('lingya-result-section');
    const resultStatus = document.getElementById('lingya-result-status');
    const resultOutput = document.getElementById('lingya-result-output');
    if (resultSection) resultSection.classList.remove('lingya-hidden');
    if (resultStatus) {
      resultStatus.textContent = '❌ 系统错误';
      resultStatus.className = 'lingya-result-status error';
    }
    if (resultOutput) {
      resultOutput.textContent = err.message || String(err);
    }
    return { code, result: { success: false, error: '系统异常: ' + (err.message || String(err)) } };
  } finally {
    isExecuting = false;
    try { setTaskbarDetail(''); } catch (_) {}
    setTaskStatus(false);
    // 【状态机复位】工具跑完就该切出 EXECUTING，不能等 AI 回复来推动。
    //
    // 原实现的死区：EXECUTING 只有 ai-start / ai-response 事件能切走。
    // 若 AI 不回复（已停止、撞风控、网络断），状态机会一直挂在 EXECUTING，
    // 要等监督者 720 秒（12 分钟）后才发现「工具卡死」——实际工具早就跑完了，
    // 界面白白显示 12 分钟「正在执行工具」。
    //
    // 正常路径下 sendToolResultToChat 已把结果发出去，语义就是「等 AI 响应」，
    // 切到 SENT（阈值 30s）比留在 EXECUTING（阈值 720s）准确得多。
    try {
      const ts = require('./task-state');
      if (ts.snapshot().state === ts.STATES.EXECUTING) {
        if (state.stopped) ts.reset('已停止，工具结果未回传');
        else ts.transition(ts.STATES.SENT, { lastSentTag: '工具结果回传' });
      }
    } catch (_) {}
  }
}

/**
 * 执行工具调用
 */
async function handleToolCall(toolCall) {
  state.touch(); // 工具执行 = 有活动
  const { toolName, params, callId } = toolCall;
  // 已停止：不再执行新工具
  if (state.stopped) {
    console.log('[LingYa] 已停止，跳过工具执行: ' + toolName);
    return;
  }
  console.log('[LingYa] 执行工具: ' + toolName, params);

  isExecuting = true;
  // 执行前先出卡片：用户能立刻看到哪个工具在跑
  renderResultCard(callId || ('tool_' + toolName + '_' + Date.now()), toolName, params, 'running', '执行中…');
  // 状态条显示具体工具名（比「正在执行工具」有信息量）
  try { setTaskbarDetail('正在执行 ' + toolName + '…'); } catch (_) {}
  setTaskStatus(true);
  showToast('开始执行命令');

  try {
    // 幂等检查：若上次相同调用已成功，直接复用结果，避免重复副作用。
    // 只对白名单内的纯读工具生效（bash/pwsh 等有副作用的默认不缓存）。
    // 必须带 projectDir —— 否则跨项目会串数据（A 项目读到 B 项目的文件）。
    const idemScope = state.currentProjectDir || '';
    let cachedTool = null;
    if (idempotency.isIdempotent(toolName)) {
      try { cachedTool = idempotency.lookup(toolName, params, idemScope); } catch (_) { cachedTool = null; }
    }

    let result;
    if (cachedTool) {
      console.log('[LingYa] 工具 ' + toolName + ' 命中幂等缓存，跳过实际执行');
      result = cachedTool;
    } else {
      // 超时保护：同 executeJs，防 IPC 永久挂起
      result = await withTimeout(
        window.electronAPI.executeTool(toolName, params, callId),
        TIMEOUTS.executeTool,
        '工具 ' + toolName + ' 执行'
      );
      // 只记录成功结果：失败可能是暂时的（网络/锁），重试有意义
      if (result && result.success) {
        try { idempotency.record(toolName, params, result, idemScope); } catch (_) {}
      }
    }

    const resultSection = document.getElementById('lingya-result-section');
    const resultStatus = document.getElementById('lingya-result-status');
    const resultOutput = document.getElementById('lingya-result-output');

    if (resultSection) resultSection.classList.remove('lingya-hidden');

    if (result.success) {
      if (resultStatus) {
        resultStatus.textContent = '✅ 工具 ' + toolName + ' 执行成功';
        resultStatus.className = 'lingya-result-status success';
      }
      if (resultOutput) {
        resultOutput.textContent = JSON.stringify(result.data, null, 2);
      }
      renderResultCard(callId || ('tool_' + toolName), toolName, params, 'success', result.data);

      // 后台任务登记：AI 这一轮结束后任务可能还在跑，状态条要能继续显示。
      // bash_background 的返回文本里带「任务 ID: bg_xxx」，从中提取。
      if (toolName === 'bash_background') {
        try {
          const txt = typeof result.data === 'string' ? result.data : JSON.stringify(result.data || '');
          const m = txt.match(/任务\s*ID:\s*(bg_[A-Za-z0-9_]+)/);
          if (m) {
            addBackgroundTask(m[1], (params && params.command) || '');
            console.log('[LingYa] 已登记后台任务到状态条: ' + m[1]);
          }
        } catch (_) {}
      }
      // 结束/终止后台任务时注销
      if (toolName === 'bash_kill' && params && params.task_id) {
        try { removeBackgroundTask(params.task_id); } catch (_) {}
      }
    } else {
      if (resultStatus) {
        resultStatus.textContent = '❌ 工具 ' + toolName + ' 执行失败';
        resultStatus.className = 'lingya-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
      renderResultCard(callId || ('tool_' + toolName), toolName, params, 'error', result.error || '未知错误');
    }

    // bash_output 返回里若显示任务已完成，同步从状态条注销
    if (toolName === 'bash_output' && params && params.task_id && result && result.success) {
      try {
        const t = typeof result.data === 'string' ? result.data : JSON.stringify(result.data || '');
        if (/\[\s*已完成\s*\(退出码/.test(t)) removeBackgroundTask(params.task_id);
      } catch (_) {}
    }

    addHistory({
      id: callId,
      command: '[工具] ' + toolName,
      success: result.success,
      output: clipForHistory(result.success ? JSON.stringify(result.data, null, 2) : (result.error || '未知错误')),
      timestamp: Date.now(),
    });

    // 已停止：不回传结果，避免 AI 收到后继续自动执行
    if (!state.stopped) {
      sendToolResultToChat(toolCall, result);
    } else {
      console.log('[LingYa] 已停止，丢弃工具结果回传');
    }
  } catch (err) {
    console.error('[LingYa] 工具执行异常:', err);
    const resultSection = document.getElementById('lingya-result-section');
    const resultStatus = document.getElementById('lingya-result-status');
    const resultOutput = document.getElementById('lingya-result-output');
    if (resultSection) resultSection.classList.remove('lingya-hidden');
    if (resultStatus) {
      resultStatus.textContent = '❌ 系统错误';
      resultStatus.className = 'lingya-result-status error';
    }
    if (resultOutput) resultOutput.textContent = err.message || String(err);
    renderResultCard(callId || ('tool_' + toolName), toolName, params, 'error', err.message || String(err));
    if (!state.stopped) {
      sendToolResultToChat(toolCall, { success: false, error: '系统异常: ' + (err.message || String(err)) });
    }
  } finally {
    isExecuting = false;
    try { setTaskbarDetail(''); } catch (_) {}
    setTaskStatus(false);
    // 同 handleJsToolScript：工具跑完必须切出 EXECUTING，否则状态机会挂到
    // 监督者 720 秒超时才发现（那时工具早已完成，界面白显示 12 分钟）。
    try {
      const ts = require('./task-state');
      if (ts.snapshot().state === ts.STATES.EXECUTING) {
        if (state.stopped) ts.reset('已停止，工具结果未回传');
        else ts.transition(ts.STATES.SENT, { lastSentTag: '工具结果回传' });
      }
    } catch (_) {}
  }
}

module.exports = {
  handleToolCall,
  handleJsToolScript,
  notifyToolCallDetected,
  notifyJsScriptDetected,
  clipForHistory,
};
