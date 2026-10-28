/**
 * QQ 通道媒体适配器
 *
 * 发送流程（官方富媒体 API）：
 *   1. POST /v2/users/{openid}/files  或  /v2/groups/{group_openid}/files
 *      body: { file_type, file_data(base64) 或 url, srv_send_msg:false, file_name? }
 *      → { file_info, file_uuid }
 *   2. POST /v2/users/{openid}/messages（或 groups）
 *      body: { msg_type:7, media:{file_info}, msg_id, msg_seq }
 *
 * file_type：1=图片 2=视频 3=语音 4=文件
 *
 * 限制：
 *   - base64 单次上限 5MB（超过需分片上传，本实现未做，直接报错）
 *   - 依赖被动回复（需 msg_id），主动发媒体不支持
 */
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.sgroup.qq.com';

const FILE_TYPE_IMAGE = 1;
const FILE_TYPE_FILE = 4;

/** base64 直传上限 5MB */
const B64_LIMIT = 5 * 1024 * 1024;

/** 由 client.js 注入运行时上下文 */
let ctxProvider = null;

function bind(provider) {
  ctxProvider = provider;
}

function getCtx() {
  if (!ctxProvider || typeof ctxProvider !== 'function') return null;
  try { return ctxProvider(); } catch (_) { return null; }
}

async function authHeaders() {
  const ctx = getCtx();
  if (!ctx || typeof ctx.getToken !== 'function') throw new Error('QQ 未连接');
  const token = await ctx.getToken();
  return {
    'Authorization': 'QQBot ' + token,
    'Content-Type': 'application/json',
  };
}

/** 拼上传/发送的基础 URL（区分单聊/群） */
function resolveBase(kind, openid) {
  if (kind === 'group') return API_BASE + '/v2/groups/' + encodeURIComponent(openid);
  return API_BASE + '/v2/users/' + encodeURIComponent(openid);
}

/**
 * 上传本地文件到 QQ 富媒体，返回 file_info。
 * @param {string} localPath 本地绝对路径
 * @param {number} fileType 1=图片 4=文件
 * @param {'c2c'|'group'} kind
 * @param {string} openid 用户/群 openid
 * @returns {Promise<string>} file_info
 */
async function uploadRichMedia(localPath, fileType, kind, openid) {
  const stat = fs.statSync(localPath);
  if (stat.size > B64_LIMIT) {
    throw new Error('文件 ' + (stat.size / 1048576).toFixed(1) + 'MB 超过 QQ base64 直传上限 5MB（分片上传未实现）');
  }

  const buf = await fs.promises.readFile(localPath);
  const body = {
    file_type: fileType,
    file_data: buf.toString('base64'),
    srv_send_msg: false,
  };
  if (fileType === FILE_TYPE_FILE) {
    body.file_name = path.basename(localPath);
  }

  const url = resolveBase(kind, openid) + '/files';
  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('上传失败 HTTP ' + res.status + ': ' + text.slice(0, 200));
  }
  let data = null;
  try { data = JSON.parse(text); } catch (_) {
    throw new Error('上传响应非 JSON: ' + text.slice(0, 200));
  }
  if (!data.file_info) throw new Error('上传未返回 file_info');
  return data.file_info;
}

/**
 * 发送富媒体消息（msg_type=7）。
 */
async function sendRichMedia(fileInfo, kind, openid, msgId, msgSeq) {
  const url = resolveBase(kind, openid) + '/messages';
  const body = {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_id: msgId,
    msg_seq: msgSeq || 1,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    return { success: false, error: '发送失败 HTTP ' + res.status + ': ' + t.slice(0, 200) };
  }
  return { success: true };
}

/**
 * 通用：上传 + 发送。
 *
 * 目标解析优先级（QQ 发媒体必须被动回复，需 msg_id）：
 *   1. target 是对象且带 msgId → 直接用
 *   2. target 是字符串 → 当作 openid，从最近的来源消息中匹配
 *   3. target 为空 → 自动取最近一条入站消息的来源
 *
 * 为什么要自动推断：send_media 工具的参数是 path/channel/target(string)，
 * 而 QQ 必须带 msg_id 才能发媒体。AI 无从得知 msg_id，
 * 只能由适配器从运行时状态里找「最近跟谁在聊」。
 */
async function sendMedia(localPath, target, fileType) {
  const ctx = getCtx();
  if (!ctx) return { success: false, error: 'QQ 未连接' };

  let openid = '';
  let kind = 'c2c';
  let msgId = '';

  if (target && typeof target === 'object') {
    // 显式对象
    openid = target.openid || '';
    kind = target.kind || 'c2c';
    msgId = target.msgId || '';
  } else if (typeof target === 'string' && target) {
    // 字符串当作 openid
    openid = target;
  }

  // 拿不到完整三元组时，自动取最近来源
  if (!openid || !msgId) {
    const recent = typeof ctx.getRecentSource === 'function' ? ctx.getRecentSource() : null;
    if (!recent) {
      return { success: false, error: '没有可用的 QQ 消息来源（需先收到过一条消息）' };
    }
    // 若指定的 openid 与最近来源不一致，仍用指定的 openid 但借用 msgId 不可能（msgId 绑定来源）
    // 所以直接以最近来源为准
    if (!openid) openid = recent.openid;
    kind = recent.kind || kind;
    if (!msgId) msgId = recent.msgId;
  }

  if (!openid) return { success: false, error: '缺少接收方 openid' };
  if (!msgId) return { success: false, error: 'QQ 发媒体必须被动回复（需 msg_id），缺少来源消息' };

  try {
    const fileInfo = await uploadRichMedia(localPath, fileType, kind, openid);
    const seq = typeof ctx.nextMsgSeq === 'function' ? ctx.nextMsgSeq(msgId) : 1;
    return await sendRichMedia(fileInfo, kind, openid, msgId, seq);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendImage(localPath, target) {
  return sendMedia(localPath, target, FILE_TYPE_IMAGE);
}

async function sendFile(localPath, target) {
  return sendMedia(localPath, target, FILE_TYPE_FILE);
}

/**
 * 下载 QQ 附件（接收侧用）。
 * @param {string} url 附件 URL（可能无 scheme）
 * @param {number} maxBytes 上限
 * @returns {Promise<Buffer>}
 */
async function downloadAttachment(url, maxBytes) {
  if (!url) throw new Error('附件 URL 为空');
  const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const limit = Number(maxBytes) || 100 * 1024 * 1024;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const chunks = [];
  let total = 0;
  try {
    const resp = await fetch(full, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);

    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          try { reader.cancel(); } catch (_) {}
          throw new Error('附件超过上限（' + (total / 1048576).toFixed(1) + 'MB）');
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > limit) throw new Error('附件超过上限');
      chunks.push(Buffer.from(ab));
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

const adapter = {
  name: 'qq',
  label: 'QQ',
  capabilities: { supportsImage: true, supportsFile: true, maxImageMB: 5, maxFileMB: 5 },
  sendImage,
  sendFile,
};

module.exports = { adapter, bind, downloadAttachment, uploadRichMedia };
