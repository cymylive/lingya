/**
 * 媒体通道适配器注册表
 *
 * 每个通道实现同一套接口，registry 负责查表分发。
 *
 * 适配器接口：
 *   {
 *     name: string,                          // 'feishu' | 'weixin' | 'qq'
 *     label: string,                         // 显示名，用于错误提示
 *     capabilities: {
 *       supportsImage: boolean,
 *       supportsFile: boolean,
 *       maxImageMB: number,
 *       maxFileMB: number,
 *     },
 *     sendImage(localPath, target) -> Promise<{success, error?}>,
 *     sendFile(localPath, target)  -> Promise<{success, error?}>,
 *   }
 *
 * 为什么用注册表而不是 if-else：
 *   后续加 QQ 通道时只需 register 一个新适配器，不改分发逻辑。
 */
const outbox = require('./outbox');

/** name -> adapter */
const adapters = new Map();

function register(adapter) {
  if (!adapter || !adapter.name) throw new Error('适配器必须有 name');
  if (typeof adapter.sendImage !== 'function' && typeof adapter.sendFile !== 'function') {
    throw new Error('适配器至少要实现 sendImage 或 sendFile');
  }
  adapters.set(adapter.name, adapter);
  console.log('[Media] 已注册适配器:', adapter.name);
  return adapter;
}

function list() {
  return Array.from(adapters.values()).map((a) => ({
    name: a.name,
    label: a.label || a.name,
    capabilities: a.capabilities || {},
  }));
}

/**
 * 统一发送入口。
 *
 * @param {string} channelName 通道名
 * @param {string} filePath 本地绝对路径
 * @param {string} target 目标（飞书 chatId/openId，微信 userId）
 * @returns {Promise<{success: boolean, kind?: string, error?: string}>}
 */
async function send(channelName, filePath, target) {
  const adapter = adapters.get(String(channelName || ''));
  if (!adapter) {
    const names = Array.from(adapters.keys()).join(', ') || '（无）';
    return { success: false, error: '未知通道: ' + channelName + '。已注册: ' + names };
  }

  // 把 label/name 一并交给 validate，让超限错误提示能说出具体是哪个通道
  const caps = Object.assign({}, adapter.capabilities || {}, {
    label: adapter.label || adapter.name,
    name: adapter.name,
  });
  const v = outbox.validate(filePath, caps);
  if (!v.ok) return { success: false, error: v.error };

  try {
    let r;
    if (v.kind === 'image') {
      if (typeof adapter.sendImage !== 'function') {
        return { success: false, error: (adapter.label || adapter.name) + ' 不支持发送图片' };
      }
      r = await adapter.sendImage(filePath, target);
    } else {
      if (typeof adapter.sendFile !== 'function') {
        return { success: false, error: (adapter.label || adapter.name) + ' 不支持发送文件' };
      }
      r = await adapter.sendFile(filePath, target);
    }
    if (r && r.success) {
      console.log('[Media] 发送成功:', channelName, v.fileName, '(' + v.size + ' 字节)');
      return { success: true, kind: v.kind, fileName: v.fileName, size: v.size };
    }
    return { success: false, error: (r && r.error) || '发送失败' };
  } catch (err) {
    console.error('[Media] 发送异常:', channelName, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { register, list, send };
