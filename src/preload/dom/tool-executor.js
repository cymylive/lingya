/**
 * 工具/JS 脚本执行器（与回复获取方式无关）
 * 拦截模式和 DOM 模式共用的执行逻辑：执行工具调用、执行 JS 脚本、通知 UI。
 */
const { showToast, setTaskStatus, addHistory, truncate, flashBadge } = require('../overlay/ui');
const { sendToolResultToChat } = require('./chat-input');
const state = require('./state');

// 是否正在执行命令或工具
let isExecuting = false;

/**
 * 通知用户检测到工具调用（闪烁状态徽章 + 更新预览）
 */
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
  try {
    const result = await window.electronAPI.executeJs(code, callId);

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
    } else {
      if (resultStatus) {
        resultStatus.textContent = '❌ JS 脚本执行失败';
        resultStatus.className = 'lingya-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
    }

    addHistory({
      id: callId,
      command: '[JS] ' + truncate((code.split(String.fromCharCode(10))[0] || code), 60),
      success: result.success,
      output: result.success ? (result.output || '') : (result.error || '未知错误'),
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
    setTaskStatus(false);
  }
}

/**
 * 执行工具调用
 */
async function handleToolCall(toolCall) {
  const { toolName, params, callId } = toolCall;
  // 已停止：不再执行新工具
  if (state.stopped) {
    console.log('[LingYa] 已停止，跳过工具执行: ' + toolName);
    return;
  }
  console.log('[LingYa] 执行工具: ' + toolName, params);

  isExecuting = true;
  setTaskStatus(true);
  showToast('开始执行命令');

  try {
    const result = await window.electronAPI.executeTool(toolName, params, callId);

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
    } else {
      if (resultStatus) {
        resultStatus.textContent = '❌ 工具 ' + toolName + ' 执行失败';
        resultStatus.className = 'lingya-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
    }

    addHistory({
      id: callId,
      command: '[工具] ' + toolName,
      success: result.success,
      output: result.success ? JSON.stringify(result.data, null, 2) : (result.error || '未知错误'),
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
    if (!state.stopped) {
      sendToolResultToChat(toolCall, { success: false, error: '系统异常: ' + (err.message || String(err)) });
    }
  } finally {
    isExecuting = false;
    setTaskStatus(false);
  }
}

module.exports = {
  handleToolCall,
  handleJsToolScript,
  notifyToolCallDetected,
  notifyJsScriptDetected,
};
