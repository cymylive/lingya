/**
 * 暴露给本地插件的运行时 API（挂在 window.__lingyaPluginAPI）。
 *
 * 为什么需要：
 *   插件的 preload 脚本由 `new Function(script)()` 在 preload 隔离世界里执行，
 *   能访问 window，但**不能 require** 项目内部模块 —— 拿不到 sendMessageToChat
 *   和运行时状态。这里把最小必要能力桥接出去，供插件编写「定时催促」「状态同步」
 *   这类功能，而不必复刻整套平台兼容的发送逻辑。
 *
 * 安全边界：
 *   - 只读运行时状态（不暴露任何写操作）
 *   - sendMessage 强制走 auto 模式：用户点停止后消息会被丢弃，插件无法越过停止
 *   - 不暴露文件系统 / 进程 / IPC 裸通道
 */
const chatInput = require('./dom/chat-input');
const state = require('./dom/state');

const API_VERSION = 1;

// 插件注册的回复拦截器。若插件处理了回复，返回 true，核心将停止后续默认处理。
let responseInterceptor = null;

/**
 * 安装到 window。幂等：重复调用返回已有的 API 对象。
 * 必须在插件 preload 脚本执行前调用。
 * @returns {object} 暴露的 API 对象
 */
function install() {
  if (typeof window === 'undefined') return null;
  if (window.__lingyaPluginAPI) return window.__lingyaPluginAPI;

  const api = {
    version: API_VERSION,

    /**
     * 向当前对话发送一条消息。
     * @param {string} text 消息正文
     * @param {string} [tag] 消息标签（用于日志过滤，默认「插件消息」）
     * @returns {Promise<boolean>} 是否进入发送流程（false 表示已停止/不可用）
     */
    sendMessage(text, tag) {
      const body = String(text == null ? '' : text).trim();
      if (!body) return Promise.resolve(false);
      return chatInput.sendMessageToChat(body, tag || '插件消息', { auto: true });
    },

    /**
     * 读取当前会话的运行时状态快照（只读）。
     * @returns {{
     *   sessionId: string|null,
     *   stopped: boolean,
     *   awaitingUserInput: boolean,
     *   awaitingNextInitialChunk: boolean,
     *   taskDeclaredDone: boolean,
     *   lastActivityAt: number
     * }}
     */
    getRuntimeState() {
      return {
        sessionId: state.currentSessionId || null,
        stopped: !!state.stopped,
        awaitingUserInput: !!state.awaitingUserInput,
        awaitingNextInitialChunk: !!state.awaitingNextInitialChunk,
        taskDeclaredDone: !!state.taskDeclaredDone,
        lastActivityAt: state.lastActivityAt || 0,
        lastUserMessage: state.lastUserMessage || '',
        lastUserMessageAt: state.lastUserMessageAt || 0,
      };
    },

    /**
     * 注册纯文本回复拦截器。插件可以在 AI 回复时先拿到内容，决定是否进行处理（例如检测拒绝并改写）。
     * 注意：只有不含工具调用的纯文本回复才会触发此拦截器。
     * @param {Function} fn async (text) => boolean。返回 true 表示插件已接管处理，默认流程将被终止。
     */
    registerResponseInterceptor(fn) {
      responseInterceptor = fn;
    },

    /**
     * 读取当前会话的待办列表。
     * @returns {Promise<{todos: Array, archived: boolean}>} 失败时返回空列表
     */
    async getTodos() {
      try {
        const r = await window.electronAPI.getTodos();
        if (r && r.success) {
          return { todos: Array.isArray(r.todos) ? r.todos : [], archived: !!r.archived };
        }
      } catch (_) { /* IPC 不可用：当作无待办 */ }
      return { todos: [], archived: false };
    },
  };

  window.__lingyaPluginAPI = api;
  return api;
}

/**
 * 供 intercept-observer 调用的内部方法：尝试触发插件拦截。
 * @param {string} text
 * @returns {Promise<boolean>} 是否被插件拦截并处理
 */
async function tryIntercept(text) {
  if (!responseInterceptor) return false;
  try {
    return await responseInterceptor(text);
  } catch (err) {
    console.error('[LingYa] 插件回复拦截器异常:', err);
    return false;
  }
}

module.exports = { install, tryIntercept, API_VERSION };
