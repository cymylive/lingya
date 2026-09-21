const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

/**
 * 文件写入工具 - 仿照 Claude Code 的 FileWriteTool
 * 用于创建新文件或覆盖现有文件
 */
class FileWriteTool extends Tool {
  constructor() {
    super(
      'file_write', '创建新文件或覆盖已有文件。父目录不存在时自动创建。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件的绝对路径或相对路径'
          },
          content: {
            type: 'string',
            description: '要写入的文件内容'
          },
          encoding: {
            type: 'string',
            description: '文件编码，默认 utf-8',
            default: 'utf-8'
          }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      },
      null
    );
  }

  /**
   * 执行文件写入
   * @param {Object} params - { file_path, content, encoding? }
   * @returns {Promise<ToolResult>}
   */
  async execute(params) {
    const { file_path, content, encoding = 'utf-8', projectDir } = params;

    try {
      // 规范化路径：将正斜杠转换为反斜杠（Windows兼容）
      const normalizedPath = file_path.replace(/\//g, path.sep);

      // 如果是相对路径且有项目目录，则相对于项目目录解析
      let resolvedPath = normalizedPath;
      if (!path.isAbsolute(normalizedPath) && projectDir) {
        resolvedPath = path.join(projectDir, normalizedPath);
      } else if (!path.isAbsolute(normalizedPath)) {
        // 相对路径但无项目目录，使用当前工作目录
        resolvedPath = path.resolve(normalizedPath);
      } else {
        resolvedPath = normalizedPath;
      }

      // 确保目录存在
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写入文件
      fs.writeFileSync(resolvedPath, content, encoding);

      // 获取绝对路径
      const absolutePath = path.resolve(resolvedPath);
      console.log('[FileWriteTool] 文件已写入:', absolutePath);
      console.log('[FileWriteTool] 文件大小:', Buffer.byteLength(content, encoding), 'bytes');
      console.log('[FileWriteTool] 编码:', encoding);

      return ToolResult.success({
        message: `文件已写入: ${absolutePath}`,
        bytes: Buffer.byteLength(content, encoding),
        path: absolutePath
      });
    } catch (err) {
      return ToolResult.error(`写入文件失败: ${err.message}`);
    }
  }
}

module.exports = { FileWriteTool };