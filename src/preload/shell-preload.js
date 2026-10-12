/**
 * 壳页面 preload：左侧栏独立视图的桥接
 * 暴露 shellAPI 给壳页面（shell.html），与主进程通信。
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // 侧栏开合：主进程负责窗口加宽 + AI view 重排
  // open=true 时 width 为展开宽度；open=false 时收起
  toggleSidebar: (open, width) => ipcRenderer.invoke('shell-sidebar-toggle', { open, width }),
  // 拖拽中实时调宽（不改窗口宽，只重排 AI view）
  resizeSidebar: (width) => ipcRenderer.invoke('shell-sidebar-resize', { width }),
  // 拖拽开始/结束：拖拽期间把 AI view 移出，避免鼠标事件被 AI 网页抢走
  startSidebarDrag: () => ipcRenderer.invoke('shell-sidebar-drag', { phase: 'start' }),
  endSidebarDrag: () => ipcRenderer.invoke('shell-sidebar-drag', { phase: 'end' }),
  // 读文件树（复用已有 IPC）
  getFileTree: (options) => ipcRenderer.invoke('get-file-tree', options || {}),
  readFilePreview: (filePath) => ipcRenderer.invoke('read-file-preview', { filePath }),
  // 选择项目目录（弹系统目录选择框，只更新目录）
  chooseDir: () => ipcRenderer.invoke('shell-choose-dir'),
  // 读当前项目目录
  getDir: () => ipcRenderer.invoke('shell-get-dir'),
};

try {
  contextBridge.exposeInMainWorld('shellAPI', api);
} catch (_) {
  window.shellAPI = api;
}

console.log('[LingYa Shell] preload 就绪');
