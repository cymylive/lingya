/**
 * 下拉浮层窗口的 preload：极简 IPC 桥
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  onInit: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('lingya-dropdown-init', h);
    return () => ipcRenderer.removeListener('lingya-dropdown-init', h);
  },
  action: (name, payload) => ipcRenderer.send('lingya-dropdown-action', { name, payload: payload || {} }),
  close: () => ipcRenderer.send('lingya-dropdown-close', {}),
};

try {
  contextBridge.exposeInMainWorld('dropdownAPI', api);
} catch (_) {
  window.dropdownAPI = api;
}
