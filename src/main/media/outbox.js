/**
 * 媒体发件箱：发送前校验
 *
 * 职责：
 *   - 校验本地文件存在、可读、非空
 *   - 按通道能力（图片/文件大小上限）做前置检查
 *   - 按扩展名判定是图片还是普通文件
 *   - 不做实际上传（那是各通道适配器的事）
 *
 * 为什么不把校验塞进适配器：
 *   三个通道的上限不同（飞书图 10MB/文件 30MB，微信更小），
 *   但"文件是否存在""是不是空文件""扩展名是什么"这些是共性的。
 *   抽出来放这里，适配器只管上传。
 */
const fs = require('fs');
const path = require('path');

/**
 * 图片扩展名白名单。
 *
 * 只收飞书官方文档明确支持的 9 种（JPG/JPEG/PNG/WEBP/GIF/BMP/ICO/TIFF/HEIC）。
 * 其余格式（.psd/.svg/.raw/.avif 等）一律走「文件」接口发送——
 * 飞书的文件接口不限格式，只是收不到图片预览。
 *
 * 这样做的目的：让「格式限制」消失。用户发什么格式都能到，只是非白名单
 * 的显示为文件图标。代价是 .tiff/.heic 这类飞书会自动转 JPG 的格式，
 * 走图片接口反而会被转码，走文件接口能保留原样。
 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.tif', '.heic']);

/** 按扩展名判定类型：'image' | 'file' */
function detectKind(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return IMAGE_EXTS.has(ext) ? 'image' : 'file';
}

/**
 * 发送前检查。
 *
 * @param {string} filePath 本地绝对路径
 * @param {object} caps 通道能力 { maxImageMB, maxFileMB, supportsImage, supportsFile }
 * @returns {{ok: boolean, kind?: string, size?: number, fileName?: string, error?: string}}
 */
function validate(filePath, caps) {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'filePath 不能为空' };
    }
    // 必须绝对路径：相对路径会随进程 cwd 漂移，容易发错文件
    if (!path.isAbsolute(filePath)) {
      return { ok: false, error: 'filePath 必须是绝对路径（当前: ' + filePath + '）' };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: '文件不存在: ' + filePath };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      return { ok: false, error: '不是文件（目录不支持发送）: ' + filePath };
    }
    if (st.size === 0) {
      return { ok: false, error: '文件内容为空: ' + filePath };
    }

    const kind = detectKind(filePath);
    const c = caps || {};

    // 通道显示名，用于错误提示
    const label = c.label || c.name || '该通道';

    if (kind === 'image') {
      if (c.supportsImage === false) {
        return { ok: false, error: label + ' 不支持发送图片' };
      }
      const limitMB = Number(c.maxImageMB) || 10;
      if (st.size > limitMB * 1048576) {
        return {
          ok: false,
          error: '图片 ' + (st.size / 1048576).toFixed(1) + 'MB 超过 ' + label + ' 的 ' + limitMB + 'MB 上限。' +
            '这是平台强制限制，无法绕过。可压缩图片后重试，或改用「文件」方式发送（飞书文件上限 30MB）。',
        };
      }
    } else {
      if (c.supportsFile === false) {
        return { ok: false, error: label + ' 不支持发送文件' };
      }
      const limitMB = Number(c.maxFileMB) || 30;
      if (st.size > limitMB * 1048576) {
        return {
          ok: false,
          error: '文件 ' + (st.size / 1048576).toFixed(1) + 'MB 超过 ' + label + ' 的 ' + limitMB + 'MB 上限。' +
            '这是平台强制限制，无法绕过。可拆分/压缩后重试。',
        };
      }
    }

    return {
      ok: true,
      kind,
      size: st.size,
      fileName: path.basename(filePath),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  validate,
  detectKind,
  IMAGE_EXTS,
};
