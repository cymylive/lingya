/**
 * 系统托盘：图标 + 右键菜单（开机自启 / 显示窗口 / 隐藏窗口 / 退出）
 */
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const windowState = require('./window');

let tray = null;

/**
 * 获取托盘图标路径
 * 打包后图标在 resources 内，开发时在 assets/
 */
function getIconPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* continue */ }
  }
  return null;
}

/** 显示所有窗口（无窗口则新建） */
function showWindows() {
  const wins = windowState.getAllWindows();
  if (wins.length === 0) {
    // 由 index.js 注册的回调重建窗口
    if (typeof global.__lingyaCreateWindow === 'function') {
      global.__lingyaCreateWindow();
    }
    return;
  }
  for (const win of wins) {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  }
}

/** 隐藏所有窗口 */
function hideWindows() {
  for (const win of windowState.getAllWindows()) {
    if (win && !win.isDestroyed()) win.hide();
  }
}

/**
 * 取用于开机自启的可执行文件路径。
 * 便携版（portable）每次运行会把自己解压到 %TEMP% 下的随机目录再运行，
 * process.execPath 指向的是那个临时 exe，退出后即失效，写进注册表会导致自启无效。
 * electron-builder 的便携版会注入 PORTABLE_EXECUTABLE_FILE 指向真正的便携 exe，优先使用它。
 *
 * 注意：这里从不硬编码任何盘符/目录，路径全部在运行时动态取得，
 * 因此便携版 exe 无论放在哪里、搬到哪里，都能指向"当前这个 exe"。
 */
function getLaunchPath() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  return process.execPath;
}

// ========== 开机自启"意图"持久化 ==========
// 注册表只能写绝对路径，exe 移动后即失效。这里单独记录"用户是否想要自启"，
// 每次启动时按当前 exe 位置自愈（重写注册表），实现"跟随 exe 位置"的效果。
// 注意：惰性求值路径——本模块可能在 app.setPath('userData') 之前被 require，
// 顶层直接读 app.getPath('userData') 会拿到默认路径，故延迟到首次调用时再算。
function getAutoLaunchFlagPath() {
  return path.join(app.getPath('userData'), 'lingya-autolaunch.json');
}

function readAutoLaunchIntent() {
  try {
    const flag = getAutoLaunchFlagPath();
    if (fs.existsSync(flag)) {
      const obj = JSON.parse(fs.readFileSync(flag, 'utf-8'));
      return !!obj.enabled;
    }
  } catch (err) {
    console.error('[Tray] 读取自启意图失败:', err.message);
  }
  return false;
}

function writeAutoLaunchIntent(enabled) {
  try {
    const flag = getAutoLaunchFlagPath();
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, JSON.stringify({ enabled: !!enabled }), 'utf-8');
  } catch (err) {
    console.error('[Tray] 写入自启意图失败:', err.message);
  }
}

/**
 * 启动时自愈：若用户此前开启过自启，则按当前 exe 位置重写注册表。
 * 这样便携版 exe 被移动/改名后，开机自启仍指向正确位置，无需手动重勾。
 */
function healAutoLaunch() {
  if (!readAutoLaunchIntent()) return;
  try {
    const opts = { openAtLogin: true };
    if (process.platform === 'win32' && app.isPackaged) {
      opts.path = getLaunchPath();
    }
    app.setLoginItemSettings(opts);
    console.log('[Tray] 开机自启已自愈，路径=' + (opts.path || process.execPath));
  } catch (err) {
    console.error('[Tray] 开机自启自愈失败:', err.message);
  }
}

/** 读取当前开机自启状态（以用户意图为准，避免注册表路径失效导致的误判） */
function isAutoLaunchEnabled() {
  if (readAutoLaunchIntent()) return true;
  try {
    if (process.platform === 'win32' && app.isPackaged) {
      return app.getLoginItemSettings({ path: getLaunchPath() }).openAtLogin;
    }
    return app.getLoginItemSettings().openAtLogin;
  } catch (err) {
    console.error('[Tray] 读取开机自启状态失败:', err.message);
    return false;
  }
}

/** 设置开机自启 */
function setAutoLaunch(enabled) {
  try {
    const opts = { openAtLogin: !!enabled };
    if (process.platform === 'win32' && app.isPackaged) {
      // 便携版用 PORTABLE_EXECUTABLE_FILE，安装版用 process.execPath
      opts.path = getLaunchPath();
    }
    app.setLoginItemSettings(opts);
    writeAutoLaunchIntent(!!enabled);
    console.log('[Tray] 开机自启已' + (enabled ? '开启' : '关闭') + '，路径=' + (opts.path || process.execPath));
  } catch (err) {
    console.error('[Tray] 设置开机自启失败:', err.message);
  }
}

/** 构建右键菜单 */
function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showWindows(),
    },
    {
      label: '隐藏窗口',
      click: () => hideWindows(),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: isAutoLaunchEnabled(),
      click: (item) => setAutoLaunch(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        // 标记为真正退出，避免被常驻逻辑拦截
        global.__lingyaQuitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * 创建托盘
 */
function createTray() {
  if (tray) return tray;
  // 启动自愈：若此前开启过自启，按当前 exe 位置重写注册表（跟随 exe 移动）
  healAutoLaunch();
  const iconPath = getIconPath();
  let image;
  if (iconPath) {
    image = nativeImage.createFromPath(iconPath);
  } else {
    image = nativeImage.createEmpty();
    console.warn('[Tray] 未找到托盘图标文件');
  }
  try {
    tray = new Tray(image);
  } catch (err) {
    console.error('[Tray] 创建托盘失败:', err.message);
    return null;
  }
  tray.setToolTip('LingYa');
  tray.setContextMenu(buildContextMenu());

  // 左键单击：切换显示/隐藏
  tray.on('click', () => {
    const wins = windowState.getAllWindows().filter((w) => w && !w.isDestroyed());
    const anyVisible = wins.some((w) => w.isVisible());
    if (anyVisible) {
      hideWindows();
    } else {
      showWindows();
    }
  });

  console.log('[Tray] 托盘已创建');
  return tray;
}

/** 刷新右键菜单（开机自启状态变化后调用） */
function refreshMenu() {
  if (tray) tray.setContextMenu(buildContextMenu());
}

/** 托盘是否已创建 */
function hasTray() {
  return !!tray;
}

module.exports = { createTray, showWindows, hideWindows, refreshMenu, hasTray, healAutoLaunch };
