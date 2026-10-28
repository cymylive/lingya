/**
 * IPC：媒体收件箱配置
 *
 * 目前只暴露一组通道：读配置 / 存配置 / 选目录 / 打开当前目录。
 * 目录合法性由 media/config.js 的 validateDir 把关，这里不做二次校验。
 */
const { ipcMain, shell, dialog } = require('electron');
const windowState = require('./window');
const path = require('path');
const fs = require('fs');

function getMediaModule() {
  return require('./media');
}

function registerMediaIpc() {
  // 读配置 + 当前生效目录
  ipcMain.handle('media-get-config', async () => {
    try {
      const media = getMediaModule();
      const cfg = media.config.readConfig();
      const effective = media.config.getEffectiveDir();
      return {
        success: true,
        inboxDir: cfg.inboxDir || '',
        effectiveDir: effective,
        defaultDir: media.config.getDefaultDir(),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 存配置（改目录）
  ipcMain.handle('media-save-config', async (_event, { data } = {}) => {
    try {
      const media = getMediaModule();
      const dir = (data && typeof data.inboxDir === 'string') ? data.inboxDir.trim() : '';

      // 空字符串 = 恢复默认
      if (!dir) {
        const ok = media.config.writeConfig({ inboxDir: '' });
        if (!ok) return { success: false, error: '保存失败' };
        media.inbox.refreshRootDir();
        return { success: true, effectiveDir: media.config.getEffectiveDir() };
      }

      // 非空 = 校验
      const v = media.config.validateDir(dir);
      if (!v.ok) return { success: false, error: v.error };

      // 尝试创建目录（父目录不存在时递归创建）
      try {
        fs.mkdirSync(v.resolved, { recursive: true });
      } catch (err) {
        return { success: false, error: '无法创建目录: ' + err.message };
      }

      const ok = media.config.writeConfig({ inboxDir: v.resolved });
      if (!ok) return { success: false, error: '保存失败' };

      // 立即生效
      media.inbox.refreshRootDir();
      return { success: true, effectiveDir: media.config.getEffectiveDir() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 弹出目录选择框
  ipcMain.handle('media-pick-dir', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const win = ctx ? (ctx.rawWin || ctx.win) : windowState.getMainWindow();
      const res = dialog.showOpenDialogSync(win || undefined, {
        title: '选择接收文件保存目录',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选择此目录',
      });
      if (!res || res.length === 0) return { success: false, canceled: true };
      return { success: true, dir: res[0] };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 在系统文件管理器中打开当前目录
  ipcMain.handle('media-open-dir', async () => {
    try {
      const media = getMediaModule();
      const dir = media.config.getEffectiveDir();
      if (!dir) return { success: false, error: '目录未初始化' };
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      await shell.openPath(dir);
      return { success: true, dir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[Media] IPC 已注册');
}

module.exports = { registerMediaIpc };
