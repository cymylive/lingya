/**
 * 状态栏溢出浮层窗口（显示全部窗口的 token / 速度）
 *
 * 为什么必须独立窗口：AI 网页是 WebContentsView（原生层），
 * 永远盖在 BrowserWindow 的 HTML 之上。壳页面里的浮层只要落在
 * AI view 区域就会被遮住。所以必须用独立 BrowserWindow 浮在最上层。
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');

let _win = null;
let _owner = null;
let _blurGuardUntil = 0;

const OVERFLOW_PRELOAD = path.join(__dirname, '..', 'preload', 'dropdown-preload.js');
const OVERFLOW_HTML = path.join(__dirname, '..', 'ui', 'overflow.html');

const WIN_WIDTH = 400;
const WIN_HEIGHT = 420;

/**
 * 打开浮层（已打开则只更新数据）
 * @param {BrowserWindow} ownerWin
 * @param {object} opts { anchor: {x,y,w,h}, items: Array<{winNo,tokens,tps}>, theme }
 */
function open(ownerWin, opts) {
  const o = opts || {};
  _owner = ownerWin;
  _blurGuardUntil = Date.now() + 600;   // 打开后 600ms 内忽略 blur，避免 focus 前瞬时失焦误关

  const anchor = o.anchor || { x: 100, y: 600, w: 60, h: 24 };

  const disp = screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: 1, height: 1 });
  const wa = disp.workArea;

  let x = Math.round(anchor.x + anchor.w - WIN_WIDTH);   // 右对齐到按钮右边
  if (x + WIN_WIDTH > wa.x + wa.width - 8) x = wa.x + wa.width - WIN_WIDTH - 8;
  if (x < wa.x + 8) x = wa.x + 8;

  // 浮在按钮上方
  let y = Math.round(anchor.y - WIN_HEIGHT - 6);
  if (y < wa.y + 8) y = wa.y + 8;

  // 已存在：只推送新数据
  if (_win && !_win.isDestroyed()) {
    try {
      _win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
      _win.webContents.send('lingya-dropdown-init', {
        type: 'overflow',
        data: { items: o.items || [] },
        theme: o.theme || 'dark',
      });
    } catch (_) {}
    return { success: true, reused: true };
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
      preload: OVERFLOW_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  _win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
  try { _win.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) { _win.setAlwaysOnTop(true); }

  _win.on('blur', () => {
    if (Date.now() < _blurGuardUntil) return;
    close();
  });
  _win.on('closed', () => { _win = null; _owner = null; });

  _win.loadFile(OVERFLOW_HTML);
  _win.webContents.once('did-finish-load', () => {
    try {
      _win.webContents.send('lingya-dropdown-init', {
        type: 'overflow',
        data: { items: o.items || [] },
        theme: o.theme || 'dark',
      });
      _win.show();
      _win.focus();   // 关键：不 focus 会立刻触发 blur → 自动关闭
    } catch (e) { console.error('[LingYa Overflow] init 失败:', e.message); }
  });

  return { success: true };
}

/** 浮层已打开时推送新数据（token 更新时调用） */
function update(items, theme) {
  if (!_win || _win.isDestroyed()) return false;
  try {
    _win.webContents.send('lingya-dropdown-init', {
      type: 'overflow',
      data: { items: items || [] },
      theme: theme || 'dark',
    });
    return true;
  } catch (_) { return false; }
}

function close() {
  if (_win && !_win.isDestroyed()) {
    console.log('[LingYa Overflow] close() 被调用, stack=' + new Error().stack.split('\n').slice(1,4).join(' | '));
    try { _win.destroy(); } catch (_) {}
  }
  _win = null;
  _owner = null;
  _blurGuardUntil = 0;
}

function isOpen() {
  return !!(_win && !_win.isDestroyed());
}

module.exports = { open, update, close, isOpen };
