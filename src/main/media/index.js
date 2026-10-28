/**
 * 媒体模块引导：初始化收件箱、注册适配器、绑定运行时上下文。
 *
 * 为什么单独一个文件：
 *   适配器需要运行时上下文（飞书的 apiClient、微信的 token/contextToken），
 *   这些东西由各自的 client.js 持有。放在这里统一装配，避免 adapters 之间互相 require。
 */
const inbox = require('./inbox');
const registry = require('./registry');
const mediaConfig = require('./config');

let inited = false;

/**
 * 初始化媒体子系统。
 * @param {string} userDataDir Electron userData 目录
 */
function init(userDataDir) {
  if (inited) return { success: true, already: true };
  inited = true;

  try {
    mediaConfig.init(userDataDir);
    inbox.init(userDataDir);
  } catch (err) {
    console.error('[Media] 收件箱初始化失败:', err.message);
  }

  // 注册飞书适配器
  try {
    const feishuMedia = require('../../feishu/media');
    const feishuClient = require('../../feishu/client');
    // 绑定 apiClient 提供者：client.js 内部持有 apiClient
    feishuMedia.bind({
      getApiClient: () => feishuClient.getApiClient ? feishuClient.getApiClient() : null,
      getDefaultTarget: () => {
        try {
          const cfg = require('../../feishu/config').readConfig();
          return cfg.targetOpenId || '';
        } catch (_) { return ''; }
      },
    });
    registry.register(feishuMedia.adapter);
  } catch (err) {
    console.warn('[Media] 注册飞书适配器失败:', err.message);
  }

  // 注册微信适配器
  try {
    const weixinMedia = require('../../weixin/media');
    const weixinClient = require('../../weixin/client');
    weixinMedia.bind(() => weixinClient.getMediaContext());
    registry.register(weixinMedia.adapter);
  } catch (err) {
    console.warn('[Media] 注册微信适配器失败:', err.message);
  }

  // 注册 QQ 适配器
  try {
    const qqMedia = require('../../qq/media');
    const qqClient = require('../../qq/client');
    qqMedia.bind(() => qqClient.getMediaContext());
    registry.register(qqMedia.adapter);
  } catch (err) {
    console.warn('[Media] 注册 QQ 适配器失败:', err.message);
  }

  // 每日清理一次过期文件（避开启动高峰）
  try {
    const timer = setInterval(() => {
      try { inbox.cleanupExpired(); } catch (_) {}
    }, 24 * 3600 * 1000);
    if (timer.unref) timer.unref();
  } catch (_) {}

  console.log('[Media] 媒体子系统已初始化，适配器:', registry.list().map((a) => a.name).join(', '));
  return { success: true };
}

module.exports = { init, config: mediaConfig, inbox };
