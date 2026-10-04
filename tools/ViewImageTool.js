/**
 * 查看图片工具 - 读取本地图片，作为附件发送给多模态模型查看。
 * 图片经主进程读取后通过 IPC 回传，由 preload 层注入聊天输入框（paste 为 File）。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

class ViewImageTool extends Tool {
  constructor() {
    super(
      'view_image',
      '读取本地图片文件，将其作为图片附件发送给多模态模型查看。支持 png/jpg/jpeg/gif/webp/bmp。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '图片文件路径（相对项目根目录或绝对路径）',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      'viewImage(filePath)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:view_image',
      order: 120,
      text: [
        '## 查看图片',
        '',
        '需要"看"图片（截图、照片、图表、UI、验证码等）时，调用 viewImage(filePath)。',
        '图片会作为附件发送给多模态模型，你可以直接看到其内容。',
        '支持 png/jpg/jpeg/gif/webp/bmp，单张上限 5MB。',
        '示例：await viewImage("screenshot.png");',
      ].join('\n'),
    };
  }

  async execute(params) {
    const { file_path, projectDir, imageCollector } = params;
    if (!file_path || typeof file_path !== 'string') {
      return ToolResult.error('file_path 不能为空');
    }
    let abs = file_path.replace(/\//g, path.sep);
    if (!path.isAbsolute(abs)) {
      abs = projectDir ? path.join(projectDir, abs) : path.resolve(abs);
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return ToolResult.error('不是文件: ' + abs);
      if (st.size > MAX_IMAGE_BYTES) {
        return ToolResult.error('图片过大 (' + st.size + ' bytes)，上限 ' + MAX_IMAGE_BYTES + ' bytes');
      }
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) return ToolResult.error('不支持的图片格式: ' + (ext || '(无扩展名)'));
      const buf = fs.readFileSync(abs);
      const img = {
        name: path.basename(abs),
        mime: mime,
        base64: buf.toString('base64'),
        size: st.size,
        path: abs,
      };
      if (Array.isArray(imageCollector)) imageCollector.push(img);
      console.log('[ViewImageTool] 已加载图片: ' + abs + ' (' + st.size + ' bytes, ' + mime + ')');
      return ToolResult.success(
        '已加载图片 ' + path.basename(abs) + ' (' + st.size + ' bytes, ' + mime + ')，将作为附件发送给模型查看。'
      );
    } catch (err) {
      return ToolResult.error('读取图片失败: ' + err.message);
    }
  }
}

module.exports = { ViewImageTool, MIME_BY_EXT, MAX_IMAGE_BYTES };
