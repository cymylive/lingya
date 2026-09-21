const { BrowserWindow } = require('electron');

class BrowserWindowManager {
  constructor() {
    this.windows = new Map();
    this.nextAutoId = 1;
  }

  openWindow(customId, url, options = {}) {
    let id;
    if (customId) {
      if (this.windows.has(customId)) {
        throw new Error(`窗口 ID "${customId}" 已存在，请换一个 ID 或复用现有窗口`);
      }
      id = customId;
    } else {
      do {
        id = `win-${this.nextAutoId++}`;
      } while (this.windows.has(id));
    }

    const win = new BrowserWindow({
      width: options.width || 1200,
      height: options.height || 800,
      ...options
    });

    // 设置与主窗口一致的 Chrome 130 普通 UA，避免暴露 Electron 标识
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(userAgent);

    // 忽略页面 beforeunload 拦截：工具调试窗口应能随时关闭。
    // 否则若目标网页注册了 beforeunload（返回非空），Electron 会静默取消关闭，
    // 表现为点右上角 X 或菜单"关闭窗口"均无反应。
    win.webContents.on('will-prevent-unload', (event) => {
      event.preventDefault();
    });

    if (url) win.loadURL(url);
    this.windows.set(id, win);
    win.on('closed', () => this.windows.delete(id));
    return id;
  }

  async injectJS(id, jsCode) {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);

    // 先检查语法错误（解析阶段错误无法被 try-catch 捕获）
    // 包裹为 async 函数体，避免 await 被误报
    try {
      new Function('return (async () => {\n' + jsCode + '\n})');
    } catch (err) {
      throw new Error(`JS 语法错误: ${err.message}`);
    }

    const hasReturn = /^\s*return\b/.test(jsCode);
    let wrapped;
    if (hasReturn) {
      // 用户代码以 return 开头，保持原来的函数体包装
      wrapped = `(async () => {
  try {
    const __result = await (async () => {
${jsCode}
    })();
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`;
    } else {
      // 用户代码是表达式（如 IIFE），直接 await 表达式捕获返回值
      wrapped = `(async () => {
  try {
    const __result = await (${jsCode});
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`;
    }
    const result = await win.webContents.executeJavaScript(wrapped, true);
    if (result && result.ok === false) {
      throw new Error(result.error);
    }
    return result ? result.value : undefined;
  }

  getWindow(id) {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);
    return win;
  }

  getAllWindowIds() {
    return Array.from(this.windows.keys());
  }

  closeWindow(id) {
    const win = this.getWindow(id);
    win.close();
    this.windows.delete(id);
  }
}

module.exports = new BrowserWindowManager();
