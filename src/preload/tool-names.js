/**
 * preload 可识别的工具名称集合
 * 替代原 preload.js 内联的 UnifiedToolManager：preload 只负责校验 AI 回复中的
 * toolName 是否存在（原实现仅使用 tools.has()/keys()），实际执行由主进程工具
 * 注册表（tools/index.js）完成。列表与顺序保持与原内联注册表一致。
 */
/**
 * preload 可识别的工具名称集合
 *
 * 【重要】原来这里是静态数组硬编码；自插件系统上线后，工具集可能在运行时
 * 变化（插件加载/卸载会注册/注销工具）。因此改为：
 *   - STATIC_TOOL_NAMES：内置工具兜底（主进程不可用/未初始化时使用）
 *   - dynamicToolNames：从主进程拉取的当前完整工具名集合（含插件贡献的）
 *   - hasTool() 优先查 dynamic，未就绪时回退 static
 *
 * 刷新时机：preload init 时调用 refreshToolNames()；
 * 主进程插件启用/禁用/重载后广播 'lingya-tools-changed'，由 setupToolNamesListener 接收。
 */
// 注意：不要在顶层 require('electron')——既有单元测试在纯 Node 环境下 require 本模块，
// 顶层依赖 electron 会让测试因 MODULE_NOT_FOUND 崩溃。改为惰性获取。
function getIpcRenderer() {
  try {
    return require('electron').ipcRenderer;
  } catch (_) {
    return null;
  }
}

// 兜底工具名清单（主进程 tool-list-names 不可用时使用）。
// 只列实际注册的工具：旧版 file_write / file_read / file_edit / file_glob / file_grep
// 已不再注册进 registry，列在这里会让 AI 误以为可用。
const STATIC_TOOL_NAMES = [
  'write',
  'read',
  'read_lines',
  'edit',
  'glob',
  'grep',
  'file_delete',
  'todo_write',
  'bash',
  'bash_background',
  'bash_output',
  'bash_kill',
  'pwsh',
  'mysql',
  'web_fetch',
  'open_browser_window',
  'inject_js',
  'view_image',
  'mcp_list_servers',
  'mcp_get_tools',
  'nameConversation',
  'listPlugins',
  'purge',
];

// 动态工具名集合（含插件贡献），null 表示尚未拉取
let dynamicToolNames = null;

/** 判断工具名是否存在 */
function hasTool(name) {
  if (dynamicToolNames && dynamicToolNames.has(name)) return true;
  // 动态集合未就绪或未命中时回退静态表（保证内置工具永远可用）
  return STATIC_TOOL_NAMES.includes(name);
}

/** 工具名列表字符串（用于错误提示） */
function toolNamesList() {
  if (dynamicToolNames && dynamicToolNames.size > 0) {
    return Array.from(dynamicToolNames).join(', ');
  }
  return STATIC_TOOL_NAMES.join(', ');
}

/** 从主进程拉取当前完整工具名集合（含插件贡献） */
async function refreshToolNames() {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return null;
  try {
    const res = await ipcRenderer.invoke('tool-list-names');
    if (res && res.success && Array.isArray(res.names)) {
      dynamicToolNames = new Set(res.names);
      return Array.from(dynamicToolNames);
    }
  } catch (err) {
    console.warn('[LingYa] 刷新工具名集合失败:', err && err.message);
  }
  return null;
}

/** 监听主进程广播的工具集变化（插件启用/禁用/重载后触发） */
function setupToolNamesListener() {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;
  ipcRenderer.on('lingya-tools-changed', () => { refreshToolNames(); });
}

module.exports = { TOOL_NAMES: STATIC_TOOL_NAMES, hasTool, toolNamesList, refreshToolNames, setupToolNamesListener };
