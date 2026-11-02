/**
 * 纯净对话模式（Harness）页面 preload
 * 对齐 Cuckoo Code 0.8.19 的 harnessAPI 接口（含所有 stub）
 */
const { contextBridge, ipcRenderer } = require('electron');

const harnessAPI = {
  // ===== 核心功能 =====
  sendMessage: (text) => ipcRenderer.invoke('harness-send', { text }),
  exitToWeb: () => ipcRenderer.invoke('harness-exit'),
  stop: () => ipcRenderer.invoke('harness-stop'),
  attach: (files) => ipcRenderer.invoke('harness-attach', { files }),
  reload: () => ipcRenderer.invoke('harness-reload'),
  newConversation: () => ipcRenderer.invoke('harness-new-conversation'),
  getState: () => ipcRenderer.invoke('harness-get-state'),
  initProject: () => ipcRenderer.invoke('harness-init-project'),
  listTools: () => ipcRenderer.invoke('harness-list-tools'),

  // ===== 订阅 =====
  onState: (cb) => {
    ipcRenderer.on('harness-state', (_e, payload) => cb(payload));
  },
  onEvent: (cb) => {
    ipcRenderer.on('harness-event', (_e, payload) => cb(payload));
  },
  setBusy: (busy) => ipcRenderer.send('harness-set-busy', { busy: !!busy }),
  ready: () => ipcRenderer.send('harness-ready'),

  // ===== 主题（stub：始终浅色）=====
  themeGet: () => Promise.resolve({
    success: true,
    snapshot: {
      active: {
        id: 'lingya-light',
        name: 'LingYa Light',
        colorScheme: 'light',
        tokens: {
          '--ck-bg': '#ffffff',
          '--ck-bg-sub': '#fbfbfd',
          '--ck-surface': '#f5f6f8',
          '--ck-surface-hover': '#eef0f4',
          '--ck-border': 'rgba(16,24,40,0.07)',
          '--ck-border-strong': 'rgba(16,24,40,0.12)',
          '--ck-text': '#16181d',
          '--ck-text-2': '#545a67',
          '--ck-text-dim': '#8a8f9b',
          '--ck-primary': '#2dd4bf',
          '--ck-primary-soft': 'rgba(45,212,191,0.08)',
          '--ck-green': '#30a46c',
          '--ck-danger': '#e5484d',
        },
      },
    },
  }),
  themeSubscribe: () => Promise.resolve({ success: true }),
  onThemeChanged: (cb) => {
    setTimeout(() => {
      try {
        cb({
          active: {
            colorScheme: 'light',
            tokens: {
              '--ck-primary': '#2dd4bf',
              '--ck-bg': '#ffffff',
              '--ck-text': '#16181d',
            },
          },
        });
      } catch (_) {}
    }, 30);
  },

  // ===== 插件样式（stub：LingYa 无插件 CSS 注入）=====
  onPluginStyle: () => {},
  onPluginStyleRemove: () => {},
  listPluginStyles: () => Promise.resolve({ success: true, styles: [] }),

  // ===== 插件壁纸（stub：LingYa 无壁纸系统）=====
  onHarnessBackground: () => {},
  getHarnessBackground: () => Promise.resolve({ success: true, background: null }),
};

try {
  contextBridge.exposeInMainWorld('harnessAPI', harnessAPI);
} catch (err) {
  console.error('[LingYa Harness] contextBridge 失败:', err);
}
window.harnessAPI = harnessAPI;
