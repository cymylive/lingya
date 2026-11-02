/**
 * IPC 来源校验（2026-10-31 审计 P0）
 *
 * 【问题】
 * 项目有 80+ 个 ipcMain.handle 处理器，绝大多数不校验 event.sender 来源。
 * LingYa 的架构是：把 electronAPI 注入 DeepSeek 网页（不可信主世界），
 * 网页里的任何脚本（XSS、恶意注入、插件）都能直接调用这些 IPC。
 *
 * 敏感操作（读凭证、导出记忆、导入插件、打开任意目录）一旦被网页脚本
 * 触发，等于本地全权限泄漏。
 *
 * 【方案】
 * 用 monkey-patch 包一层 ipcMain.handle，对「敏感通道」强制校验来源。
 * 来源判据：event.sender.getURL() 是否为 file:// 协议。
 *   - file:// → LingYa 自己的 shell.html，可信
 *   - http(s):// → AI 网页（DeepSeek/ChatGPT等），只允许普通通道
 *
 * 【为什么不改 80 处】
 * 改动面太大，容易漏、容易出错。只改「注册入口」一处最安全。
 *
 * 【敏感通道清单】
 * 白名单模式：显式列出不允许网页调用的通道。新增敏感通道时加进来即可。
 */

/** 敏感通道（只允许 LingYa 自己页面调用） */
const SENSITIVE_CHANNELS = new Set([
  // 记忆系统（读写用户记忆库）
  'memory-status', 'memory-collect', 'memory-list',
  'memory-import', 'memory-export',
  // 技能系统（读任意目录）
  'skill-import-folder',
  // 插件系统（加载任意代码、打开任意目录）
  // 【2026-11-01 修复】移出 'plugin-preloads'：它只返回「要注入的脚本文本」，
  // 不读写用户目录、不加载任意代码（加载在 plugin-import 那步已完成）。
  // AI 页面必须能拿它来执行插件 preload（如 task-watcher 的定时监听），
  // 列在白名单里会直接让所有插件的 preload 失效。
  'plugin-import', 'plugin-open-dir', 'plugin-export-skill',
  // DSH 插件（外部生态）
  'dsh-open-dir',
  // 安全配置（CTF 注入、破甲规则）
  'security-get-config', 'security-reset-config', 'security-get-ctf-prompt',
  // 通道凭证（飞书/微信/QQ 的 appid/secret）
  'feishu-get-config', 'feishu-list-chats',
  'weixin-get-config', 'weixin-list-recent-users', 'weixin-get-qrcode', 'weixin-logout',
  'qq-get-config', 'qq-list-recent-users',
  // 窗口管理（创建/删除 profile 意味着读写用户数据目录）
  'list-profiles', 'create-profile-window', 'delete-profile-window',
  'list-providers', 'import-provider',
  // MCP 配置
  'list-mcp-servers', 'get-mcp-tools',
  // 定时任务（可让 AI 未来自动执行任意操作）
  'schedule-list', 'schedule-list-windows',
]);

/** 判断事件来源是否可信（LingYa 自己的 file:// 页面） */
function isTrustedSender(event) {
  try {
    if (!event || !event.sender) return false;
    const url = String(event.sender.getURL() || '');
    // file:// 是 LingYa 自己加载的页面（shell.html 及其子页面）
    return url.startsWith('file://');
  } catch (_) {
    return false;
  }
}

/**
 * 给 ipcMain 打补丁：对敏感通道包一层来源校验。
 * 必须在所有 registerXXXIpc() 调用之前执行。
 * @param {Electron.IpcMain} ipcMain
 */
function install(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    console.warn('[IPC-Guard] ipcMain 不可用，跳过安装');
    return;
  }
  if (ipcMain.__lingyaGuarded) {
    console.log('[IPC-Guard] 已安装过，跳过');
    return;
  }
  const origHandle = ipcMain.handle.bind(ipcMain);

  ipcMain.handle = function guardedHandle(channel, handler) {
    if (!SENSITIVE_CHANNELS.has(channel)) {
      // 普通通道：原样放行（AI 网页需要调用）
      return origHandle(channel, handler);
    }
    // 敏感通道：包一层来源校验
    return origHandle(channel, async function guardedHandler(event, ...args) {
      if (!isTrustedSender(event)) {
        let from = '(unknown)';
        try { from = event && event.sender ? event.sender.getURL() : '(no sender)'; } catch (_) {}
        console.warn('[IPC-Guard] 拒绝非信任来源调用敏感通道: ' + channel + ' | 来源: ' + from);
        return { success: false, error: '权限不足：该操作仅限 LingYa 内部调用（来源不匹配）' };
      }
      return handler(event, ...args);
    });
  };

  // 标记已安装，防止重复打补丁
  try { ipcMain.__lingyaGuarded = true; } catch (_) {}
  console.log('[IPC-Guard] 已安装，敏感通道白名单 ' + SENSITIVE_CHANNELS.size + ' 个');
}

module.exports = { install, SENSITIVE_CHANNELS, isTrustedSender };
