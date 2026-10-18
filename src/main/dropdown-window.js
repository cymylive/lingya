/**
 * 下拉浮层窗口（标签列表 / 收藏夹）
 *
 * 为什么必须独立窗口：
 *   AI 网页是 WebContentsView（原生层），永远盖在 BrowserWindow 的 HTML 之上。
 *   壳页面里的任何 DOM（包括下拉面板）只要落在 AI view 区域就会被遮住。
 *   所以下拉必须用独立的 BrowserWindow（无边框/透明/置顶/父窗口）浮在最上层。
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');

let _win = null;
let _owner = null;
let _onAction = null;

const DROPDOWN_PRELOAD = path.join(__dirname, '..', 'preload', 'dropdown-preload.js');
const DROPDOWN_HTML = path.join(__dirname, '..', 'ui', 'dropdown.html');

/**
 * 打开下拉
 * @param {BrowserWindow} ownerWin 主窗口（作为 parent）
 * @param {object} opts { type: 'tabs'|'bookmarks', anchor: {x,y,w,h}, data: any, onAction }
 */
function open(ownerWin, opts) {
  const o = opts || {};
  close();

  _owner = ownerWin;
  _onAction = o.onAction || null;

  const anchor = o.anchor || { x: 100, y: 60, w: 26, h: 26 };
  const width = 340;
  const height = 380;

  const disp = screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: 1, height: 1 });
  const wa = disp.workArea;

  let x = Math.round(anchor.x);
  if (x + width > wa.x + wa.width - 8) x = wa.x + wa.width - width - 8;
  if (x < wa.x + 8) x = wa.x + 8;

  let y = Math.round(anchor.y + anchor.h + 4);
  if (y + height > wa.y + wa.height - 8) {
    y = Math.max(wa.y + 8, Math.round(anchor.y - height - 4));
  }

  _win = new BrowserWindow({
    parent: ownerWin,
    modal: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: DROPDOWN_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  _win.setBounds({ x, y, width, height });
  try { _win.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) { _win.setAlwaysOnTop(true); }

  // 失焦自动关闭
  _win.on('blur', () => { close(); });
  _win.on('closed', () => { _win = null; });

  _win.loadFile(DROPDOWN_HTML);
  _win.webContents.once('did-finish-load', () => {
    try {
      _win.webContents.send('lingya-dropdown-init', {
        type: o.type || 'tabs',
        data: o.data || null,
        theme: o.theme || 'dark',
      });
      _win.show();
      _win.focus();
    } catch (e) { console.error('[LingYa Dropdown] init 失败:', e.message); }
  });

  return { success: true };
}

function close() {
  if (_win && !_win.isDestroyed()) {
    try { _win.destroy(); } catch (_) {}
  }
  _win = null;
  _onAction = null;
  _owner = null;
}

function emitAction(action, payload) {
  const cb = _onAction;
  close();
  try { cb && cb(action, payload || {}); } catch (e) { console.error('[LingYa Dropdown] action 回调异常:', e.message); }
}

function isOpen() {
  return !!(_win && !_win.isDestroyed());
}

module.exports = { open, close, emitAction, isOpen };
