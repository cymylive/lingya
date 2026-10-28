/**
 * 飞书媒体适配器
 *
 * 上传流程（官方 SDK）：
 *   图片：im.image.create({data:{image_type:'message', image: fs.createReadStream(path)}}) → image_key
 *         im.message.create({msg_type:'image', content: JSON.stringify({image_key})})
 *   文件：im.file.create({data:{file_type:'stream', file_name, file: stream}}) → file_key
 *         im.message.create({msg_type:'file', content: JSON.stringify({file_key, file_name})})
 *
 * 限制（飞书官方）：
 *   图片 ≤ 10MB，文件 ≤ 30MB
 */
const fs = require('fs');
const path = require('path');

let lark = null;
try { lark = require('@larksuiteoapi/node-sdk'); } catch (_) {}

/** 由 client.js 注入已创建的 apiClient 与配置读取函数，避免重复建实例 */
let getApiClient = () => null;
let getDefaultTarget = () => '';

function bind(ctx) {
  if (ctx && typeof ctx.getApiClient === 'function') getApiClient = ctx.getApiClient;
  if (ctx && typeof ctx.getDefaultTarget === 'function') getDefaultTarget = ctx.getDefaultTarget;
}

/** 解析接收方：优先传进来的 target，否则回退默认（已记录的 openId / 绑定群） */
function resolveTarget(target) {
  return target || getDefaultTarget() || '';
}

/** 发一条 message，receive_id_type 按 target 形态判断（群 chat_id 以 oc_ 开头） */
async function sendMessage(msgType, contentObj, target) {
  const client = getApiClient();
  if (!client) return { success: false, error: '飞书未连接' };
  const rid = resolveTarget(target);
  if (!rid) return { success: false, error: '没有可用的接收方' };

  const idType = rid.startsWith('oc_') ? 'chat_id' : 'open_id';
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: idType },
      data: { receive_id: rid, msg_type: msgType, content: JSON.stringify(contentObj) },
    });
    if (res && (res.code === 0 || res.code === undefined)) return { success: true };
    return { success: false, error: (res && res.msg) || '发送失败' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 创建带 error 兜底的文件流。
 *
 * 为什么必须加监听：fs.createReadStream 在文件被删/被锁/权限不足时会 emit 'error'。
 * 没有监听器 → Node 抛 uncaughtException → 整个 Electron 主进程崩溃。
 * 加空监听器只是兜底，真正的错误在创建流之前用 access 检查过。
 */
function makeSafeReadStream(localPath) {
  const stream = fs.createReadStream(localPath);
  stream.on('error', (err) => {
    console.error('[Feishu] 文件流错误:', localPath, err.message);
  });
  return stream;
}

/** 上传前检查文件可读（比等流报错更早给出清晰错误） */
async function ensureReadable(localPath) {
  try {
    await fs.promises.access(localPath, fs.constants.R_OK);
    return null;
  } catch (err) {
    return '文件不可读（可能已被删除或被占用）: ' + localPath;
  }
}

async function sendImage(localPath, target) {
  const client = getApiClient();
  if (!client) return { success: false, error: '飞书未连接' };

  const unreadable = await ensureReadable(localPath);
  if (unreadable) return { success: false, error: unreadable };

  try {
    const up = await client.im.image.create({
      data: {
        image_type: 'message',
        image: makeSafeReadStream(localPath),
      },
    });
    const imageKey = up && up.data && up.data.image_key;
    if (!imageKey) return { success: false, error: '上传图片未返回 image_key' };
    return await sendMessage('image', { image_key: imageKey }, target);
  } catch (err) {
    return { success: false, error: '上传图片失败: ' + err.message };
  }
}

async function sendFile(localPath, target) {
  const client = getApiClient();
  if (!client) return { success: false, error: '飞书未连接' };

  const unreadable = await ensureReadable(localPath);
  if (unreadable) return { success: false, error: unreadable };

  const fileName = path.basename(localPath);
  try {
    const up = await client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: makeSafeReadStream(localPath),
      },
    });
    const fileKey = up && up.data && up.data.file_key;
    if (!fileKey) return { success: false, error: '上传文件未返回 file_key' };
    return await sendMessage('file', { file_key: fileKey, file_name: fileName }, target);
  } catch (err) {
    return { success: false, error: '上传文件失败: ' + err.message };
  }
}

/** 下载消息里的资源（图片/文件），返回 Buffer */
async function downloadResource(messageId, fileKey, type) {
  const client = getApiClient();
  if (!client) throw new Error('飞书未连接');
  // SDK: im.messageResource.get({ path:{message_id, file_key}, params:{type} })
  const res = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: type === 'image' ? 'image' : 'file' },
  });
  // SDK 返回 { writeFile, getReadableStream } 形态，按能力取 Buffer
  if (res && typeof res.getReadableStream === 'function') {
    const stream = res.getReadableStream();
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  if (res && typeof res.writeFile === 'function') {
    const os = require('os');
    const tmp = path.join(os.tmpdir(), 'feishu-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    try {
      await res.writeFile(tmp);
      return fs.readFileSync(tmp);
    } finally {
      // 无论读成功还是抛错，临时文件都必须删
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  throw new Error('SDK 未提供可用的下载方法');
}

const adapter = {
  name: 'feishu',
  label: '飞书',
  capabilities: { supportsImage: true, supportsFile: true, maxImageMB: 10, maxFileMB: 30 },
  sendImage,
  sendFile,
};

module.exports = { adapter, bind, downloadResource };
