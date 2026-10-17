/**
 * 浏览器窗口/标签管理器
 *
 * 0.6.62 起：优先在当前窗口内开「标签页」（WebContentsView），
 * 不再默认弹独立 BrowserWindow —— 用户体验等同浏览器多标签。
 *
 * 兼容：
 *   - injectJS(id, code) / closeWindow(id) 语义不变
 *   - 老代码传自定义 id 也照常工作
 *
 * 退化策略：如果当前没有可用的主窗口上下文（如启动早期），
 * 才回退到新建独立 BrowserWindow，保证工具不失效。
 */
const { BrowserWindow } = require('electron');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class BrowserWindowManager {
  constructor() {
    // id -> { kind: 'tab'|'window', windowId?, tabId?, win?, view? }
    this.entries = new Map();
    this.nextAutoId = 1;
  }

  /** 取当前活动窗口上下文 */
  _getActiveContext() {
    try {
      const windowState = require('../src/main/window');
      return windowState.getMainContext();
    } catch (_) { return null; }
  }

  /**
   * 打开浏览器（标签优先）
   * @returns {string} id，后续用于 injectJS / closeWindow
   */
  openWindow(customId, url, options = {}) {
    let id;
    if (customId) {
      if (this.entries.has(customId)) {
        throw new Error('窗口 ID "' + customId + '" 已存在，请换一个 ID 或复用现有窗口');
      }
      id = customId;
    } else {
      do { id = 'win-' + (this.nextAutoId++); } while (this.entries.has(id));
    }

    // ---- 优先：当前窗口内开标签 ----
    const ctx = this._getActiveContext();
    if (ctx && ctx.tabs && ctx.rawWin && !ctx.rawWin.isDestroyed()) {
      try {
        const tabManager = require('../src/main/tab-manager');
        const tab = tabManager.createTab(ctx, {
          url: url || 'about:blank',
          activate: true,
        });
        // 自定义 id 用作可读别名
        this.entries.set(id, { kind: 'tab', tabId: tab.id, ctx });
        return id;
      } catch (err) {
        console.warn('[LingYa] 开标签失败，退化到独立窗口:', err.message);
      }
    }

    // ---- 退化：独立 BrowserWindow ----
    const win = new BrowserWindow({
      width: options.width || 1200,
      height: options.height || 800,
      ...options,
    });
    win.webContents.setUserAgent(USER_AGENT);
    win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
    if (url) win.loadURL(url);
    this.entries.set(id, { kind: 'window', win });
    win.on('closed', () => this.entries.delete(id));
    return id;
  }

  /** 解析 id -> webContents */
  _resolveWebContents(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error('窗口 ID "' + id + '" 不存在');
    if (e.kind === 'tab') {
      const tab = e.ctx.tabs.get(e.tabId);
      if (!tab || !tab.view || tab.view.webContents.isDestroyed()) {
        throw new Error('标签 "' + id + '" 已被关闭');
      }
      return tab.view.webContents;
    }
    if (!e.win || e.win.isDestroyed()) throw new Error('窗口 "' + id + '" 已被关闭');
    return e.win.webContents;
  }

  async injectJS(id, jsCode) {
    const wc = this._resolveWebContents(id);

    // 语法预检
    try {
      new Function('return (async () => {\n' + jsCode + '\n})');
    } catch (err) {
      throw new Error('JS 语法错误: ' + err.message);
    }

    const hasReturn = /^\s*return\b/.test(jsCode);
    let wrapped;
    if (hasReturn) {
      wrapped = '(async () => {\n  try {\n    const __result = await (async () => {\n' + jsCode + '\n    })();\n    return { ok: true, value: __result };\n  } catch (err) {\n    return { ok: false, error: err && err.message ? err.message : String(err) };\n  }\n})()';
    } else {
      wrapped = '(async () => {\n  try {\n    const __result = await (' + jsCode + ');\n    return { ok: true, value: __result };\n  } catch (err) {\n    return { ok: false, error: err && err.message ? err.message : String(err) };\n  }\n})()';
    }
    const result = await wc.executeJavaScript(wrapped, true);
    if (result && result.ok === false) throw new Error(result.error);
    return result ? result.value : undefined;
  }

  getAllWindowIds() {
    return Array.from(this.entries.keys());
  }

  closeWindow(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error('窗口 ID "' + id + '" 不存在');
    if (e.kind === 'tab') {
      try {
        const tabManager = require('../src/main/tab-manager');
        tabManager.closeTab(e.ctx, e.tabId);
      } catch (_) {}
    } else if (e.win && !e.win.isDestroyed()) {
      e.win.close();
    }
    this.entries.delete(id);
  }
}

module.exports = new BrowserWindowManager();
