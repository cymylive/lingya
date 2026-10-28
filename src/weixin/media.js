/**
 * 微信 iLink 媒体适配器
 *
 * 协议要点（源自腾讯 iLink Bot API）：
 *
 * 上传（AES-128-ECB + PKCS7）：
 *   1. 生成 16 字节随机 aes_key，hex 编码
 *   2. PKCS7 填充后 AES-128-ECB 加密原文
 *   3. POST /ilink/bot/getuploadurl
 *        { filekey, media_type, to_user_id, rawsize, rawfilemd5,
 *          filesize(密文长度), aeskey(hex), no_need_thumb:true }
 *      → { upload_full_url } 或 { upload_param }
 *   4. POST 密文到 upload_url（Content-Type: application/octet-stream）
 *      → 响应头 x-encrypted-param 即下载凭据
 *   5. 发送 aes_key 用 base64(hex字符串) 编码
 *
 * 发送 item 结构：
 *   图片 type:2 image_item { media:{encrypt_query_param,aes_key,encrypt_type:1}, mid_size }
 *   文件 type:4 file_item  { media:{...}, file_name, len }
 *
 * 下载：
 *   GET {cdn}/download?encrypted_query_param=xxx → AES-128-ECB 解密
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '2.0.0';

/** 微信媒体类型：1=图片 3=文件 */
const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_FILE = 3;

/** 由 client.js 注入运行时上下文（baseUrl / token / contextToken 查询） */
let ctxProvider = null;

function bind(provider) {
  ctxProvider = provider;
}

function getCtx() {
  if (!ctxProvider || typeof ctxProvider !== 'function') return null;
  try { return ctxProvider(); } catch (_) { return null; }
}

/** iLink 通用请求头 */
function makeWechatUin() {
  const n = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
  return Buffer.from(String(n), 'utf-8').toString('base64');
}

function buildHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': makeWechatUin(),
  };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/** POST 到 iLink 业务接口 */
async function apiPost(baseUrl, pathName, body, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + pathName, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(Object.assign({ base_info: { channel_version: CHANNEL_VERSION } }, body || {})),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) {
      throw new Error('响应非 JSON (HTTP ' + res.status + '): ' + text.slice(0, 200));
    }
  } finally {
    clearTimeout(timer);
  }
}

// ================= AES-128-ECB =================

/** PKCS7 填充后的密文长度 */
function paddedSize(n) {
  return ((n + 1 + 15) / 16 | 0) * 16;
}

function aesEcbEncrypt(data, keyBuf) {
  const padLen = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function aesEcbDecrypt(data, keyBuf) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(data), decipher.final()]);
  // 手工去 PKCS7 填充
  const padLen = raw[raw.length - 1];
  if (padLen === 0 || padLen > 16) return raw;
  return raw.subarray(0, raw.length - padLen);
}

/** 把消息里的 aes_key（hex 或 base64）统一转成 16 字节 Buffer */
function normalizeAesKey(aesKey) {
  const s = String(aesKey || '');
  if (!s) throw new Error('aes_key 为空');
  // 1) 32 位 hex
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');
  // 2) base64 → 解码后可能是 hex 字符串(32) 或裸 key(16)
  const dec = Buffer.from(s, 'base64');
  if (dec.length === 32 && /^[0-9a-fA-F]{32}$/.test(dec.toString('latin1'))) {
    return Buffer.from(dec.toString('latin1'), 'hex');
  }
  if (dec.length === 16) return dec;
  throw new Error('无法识别的 aes_key 格式');
}

// ================= CDN 上传 =================

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * 上传文件到微信 CDN。
 * @param {string} filePath 本地绝对路径
 * @param {string} toUserId 目标用户
 * @param {number} mediaType 1=图片 3=文件
 * @returns {Promise<{encryptQueryParam: string, aesKeyB64: string, cipherSize: number, rawSize: number}>}
 */
async function uploadToCdn(filePath, toUserId, mediaType) {
  const ctx = getCtx();
  if (!ctx || !ctx.baseUrl || !ctx.token) throw new Error('微信未连接（缺少 baseUrl/token）');

  // 异步读，避免大文件阻塞主进程（Electron 主进程阻塞 = 整个 UI 卡死 + IPC 停摆）
  const raw = await fs.promises.readFile(filePath);
  const rawSize = raw.length;
  const rawMd5 = md5Hex(raw);
  const cipherSize = paddedSize(rawSize);

  const aesKeyBuf = crypto.randomBytes(16);
  const aesKeyHex = aesKeyBuf.toString('hex');
  const encrypted = aesEcbEncrypt(raw, aesKeyBuf);

  const MAX_RETRY = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const filekey = crypto.randomBytes(16).toString('hex');
    try {
      // 1) 申请上传地址
      const up = await apiPost(ctx.baseUrl, '/ilink/bot/getuploadurl', {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: rawMd5,
        filesize: cipherSize,
        aeskey: aesKeyHex,
        no_need_thumb: true,
      }, ctx.token, 60000);

      if (!up || up.ret !== 0) {
        throw new Error('getuploadurl 失败: ' + ((up && (up.errmsg || up.ret)) || '未知'));
      }

      // 2) 组装 CDN 上传地址
      let cdnUrl = '';
      if (up.upload_full_url) {
        cdnUrl = up.upload_full_url;
      } else if (up.upload_param) {
        cdnUrl = CDN_BASE + '/upload?encrypted_query_param=' + encodeURIComponent(up.upload_param)
          + '&filekey=' + encodeURIComponent(filekey);
      } else {
        throw new Error('getuploadurl 未返回 upload_full_url / upload_param');
      }

      // 3) POST 密文
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      let resp;
      try {
        resp = await fetch(cdnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(encrypted.length),
          },
          body: encrypted,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (resp.status >= 400 && resp.status < 500) {
        const msg = resp.headers.get('x-error-message') || '';
        throw new Error('CDN 客户端错误 ' + resp.status + (msg ? ': ' + msg : ''));
      }
      if (!resp.ok) {
        throw new Error('CDN 上传失败 HTTP ' + resp.status);
      }

      const downloadParam = resp.headers.get('x-encrypted-param') || '';
      if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');

      // 发送时 aes_key 用 base64(hex 字符串) 编码
      const aesKeyB64 = Buffer.from(aesKeyHex, 'utf-8').toString('base64');

      return {
        encryptQueryParam: downloadParam,
        aesKeyB64,
        cipherSize,
        rawSize,
      };
    } catch (err) {
      lastErr = err;
      if (/客户端错误/.test(err.message)) throw err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr || new Error('CDN 上传失败');
}

// ================= 发送 =================

/** 发一批 item 到指定用户 */
async function sendItems(toUserId, items) {
  const ctx = getCtx();
  if (!ctx || !ctx.baseUrl || !ctx.token) return { success: false, error: '微信未连接' };
  if (typeof ctx.getContextToken !== 'function') return { success: false, error: '缺少 context_token 提供者' };

  const ctxToken = ctx.getContextToken(toUserId);
  if (!ctxToken) {
    return { success: false, error: '缺少 context_token（对方需先发过消息才能接收推送）' };
  }

  try {
    const data = await apiPost(ctx.baseUrl, '/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: String(toUserId),
        client_id: crypto.randomBytes(8).toString('hex'),
        message_type: 2,
        message_state: 2,
        context_token: ctxToken,
        item_list: items,
      },
    }, ctx.token, 60000);

    if (data && (data.ret === -14 || data.errcode === -14)) {
      return { success: false, error: '会话已过期，请重新扫码登录' };
    }
    if (!data || data.ret !== 0) {
      return { success: false, error: (data && data.errmsg) || '发送失败' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendImage(localPath, target) {
  const ctx = getCtx();
  const userId = target || (ctx && ctx.defaultUserId) || '';
  if (!userId) return { success: false, error: '缺少接收方 userId' };
  try {
    const up = await uploadToCdn(localPath, userId, MEDIA_TYPE_IMAGE);
    return await sendItems(userId, [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: up.encryptQueryParam,
          aes_key: up.aesKeyB64,
          encrypt_type: 1,
        },
        mid_size: up.cipherSize,
      },
    }]);
  } catch (err) {
    return { success: false, error: '发送图片失败: ' + err.message };
  }
}

async function sendFile(localPath, target) {
  const ctx = getCtx();
  const userId = target || (ctx && ctx.defaultUserId) || '';
  if (!userId) return { success: false, error: '缺少接收方 userId' };
  const fileName = path.basename(localPath);
  try {
    const up = await uploadToCdn(localPath, userId, MEDIA_TYPE_FILE);
    return await sendItems(userId, [{
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: up.encryptQueryParam,
          aes_key: up.aesKeyB64,
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(up.rawSize),
      },
    }]);
  } catch (err) {
    return { success: false, error: '发送文件失败: ' + err.message };
  }
}

// ================= 下载 =================

/**
 * 从微信 CDN 下载并解密媒体。
 * @param {string} encryptQueryParam 消息里 media.encrypt_query_param
 * @param {string} aesKey 消息里 media.aes_key
 * @returns {Promise<Buffer>}
 */
/**
 * 从微信 CDN 下载并解密媒体。
 *
 * 安全上限：边读边累计字节数，超过 maxBytes 立即中断。
 * 为什么不先看 Content-Length：那是服务端声称的值，不可信；
 * 而且某些 CDN 用 chunked 编码根本不返回该头。只有实际读取计数才可靠。
 *
 * @param {string} encryptQueryParam 消息里 media.encrypt_query_param
 * @param {string} aesKey 消息里 media.aes_key
 * @param {number} [maxBytes] 上限，默认 100MB（与 inbox 一致）
 * @returns {Promise<Buffer>}
 */
async function downloadMedia(encryptQueryParam, aesKey, maxBytes) {
  if (!encryptQueryParam) throw new Error('缺少 encrypt_query_param');
  const limit = Number(maxBytes) || 100 * 1024 * 1024;
  const url = CDN_BASE + '/download?encrypted_query_param=' + encodeURIComponent(encryptQueryParam);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const chunks = [];
  let total = 0;
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('CDN 下载失败 HTTP ' + resp.status);

    // 流式读取并累计，超限立即 abort
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          try { reader.cancel(); } catch (_) {}
          throw new Error('下载内容超过上限（' + (total / 1048576).toFixed(1) + 'MB > ' + (limit / 1048576).toFixed(0) + 'MB）');
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      // 兜底：无流式 API 时用 arrayBuffer，读完后检查
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > limit) {
        throw new Error('下载内容超过上限（' + (ab.byteLength / 1048576).toFixed(1) + 'MB > ' + (limit / 1048576).toFixed(0) + 'MB）');
      }
      chunks.push(Buffer.from(ab));
    }
  } finally {
    clearTimeout(timer);
  }

  const buf = Buffer.concat(chunks);

  if (!aesKey) return buf;
  const keyBuf = normalizeAesKey(aesKey);
  return aesEcbDecrypt(buf, keyBuf);
}

const adapter = {
  name: 'weixin',
  label: '微信',
  capabilities: { supportsImage: true, supportsFile: true, maxImageMB: 10, maxFileMB: 20 },
  sendImage,
  sendFile,
};

module.exports = { adapter, bind, downloadMedia, uploadToCdn };
