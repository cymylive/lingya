const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

/**
 * 文件读取工具
 * 用于读取项目中的文件内容
 */
class FileReadTool extends Tool {
  constructor() {
    super(
      'file_read', '读取指定文件的内容，返回字符串。超过 1MB 只返回前 1MB。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件的相对路径或绝对路径'
          },
          encoding: {
            type: 'string',
            description: '文件编码，默认 utf-8',
            default: 'utf-8'
          },
          format: {
            type: 'string',
            description: '输出格式: plain (原始内容) 或 escaped (转义为JSON字符串)',
            default: 'plain',
            enum: ['plain', 'escaped']
          },
          line_numbers: {
            type: 'boolean',
            description: '是否在每行前添加行号（用于 AI 阅读），默认 false',
            default: false
          }
        },
        required: ['file_path'],
        additionalProperties: false
      },
      null
    );
  }

  /**
   * 执行文件读取
   * @param {Object} params - { file_path, encoding?, format? }
   * @returns {Promise<ToolResult>}
   */
  async execute(params) {
    const { file_path, encoding = 'utf-8', projectDir, format = 'plain', line_numbers = false } = params;

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

      // 检查文件是否存在
      if (!fs.existsSync(resolvedPath)) {
        return ToolResult.error(`文件不存在: ${resolvedPath}`);
      }

      // 检查是否是文件
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return ToolResult.error(`不是文件: ${resolvedPath}`);
      }

      // 限制读取大小 1MB，避免超大文件
      const MAX_SIZE = 1024 * 1024; // 1MB
      const isTruncated = stat.size > MAX_SIZE;

      let content;
      if (isTruncated) {
        // 只读取前 1MB
        const fd = fs.openSync(resolvedPath, 'r');
        const buffer = Buffer.alloc(MAX_SIZE);
        fs.readSync(fd, buffer, 0, MAX_SIZE, 0);
        fs.closeSync(fd);
        content = buffer.toString(encoding);
        // 去除可能的截断导致的半个字符
        content = content.replace(/�/g, '');
      } else {
        content = fs.readFileSync(resolvedPath, encoding);
      }

      // 可选：添加行号（readFileWithLines 使用）
      if (line_numbers) {
        content = content.split(/\r?\n/).map((line, idx) => (idx + 1) + ': ' + line).join('\n');
      }

      const absolutePath = path.resolve(resolvedPath);
      console.log('[FileReadTool] 文件已读取:', absolutePath, '大小:', stat.size, 'bytes, format:', format);
      // 直接返回文件内容字符串，不包装额外字段
      // 如果 format 为 'escaped'，返回转义后的字符串（便于在 JSON 中使用）
      if (format === 'escaped') {
        return ToolResult.success(JSON.stringify(content));
      } else {
        return ToolResult.success(content);
      }
    } catch (err) {
      return ToolResult.error(`读取文件失败: ${err.message}`);
    }
  }
}

module.exports = { FileReadTool };