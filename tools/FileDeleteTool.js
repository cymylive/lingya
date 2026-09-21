const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

/**
 * 文件删除工具
 * 用于删除指定的文件（不可恢复）
 */
class FileDeleteTool extends Tool {
  constructor() {
    super(
      'file_delete',
      '删除指定文件（不可恢复，请谨慎使用）。返回 { message, path }，其中 path 为被删除文件的绝对路径。',
      {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要删除的文件的相对路径（相对于项目目录）' }
        },
        required: ['file_path']
      },
      'deleteFile(file_path)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:deleteFile',
      order: 112,
      text: '使用 deleteFile 工具永久删除文件。此操作不可撤销。返回 { message, path }，path 为被删除文件的绝对路径。删除前请仔细确认路径。'
    };
  }

  async execute(params) {
    const { file_path, projectDir } = params;
    if (!file_path) {
      return ToolResult.error('缺少参数 file_path');
    }

    // 解析绝对路径
    let absolutePath = file_path;
    if (!path.isAbsolute(absolutePath) && projectDir) {
      absolutePath = path.join(projectDir, file_path);
    } else if (!path.isAbsolute(absolutePath)) {
      absolutePath = path.resolve(file_path);
    }

    try {
      // 检查文件是否存在
      await fs.promises.access(absolutePath, fs.constants.F_OK);
      // 检查是否为文件（不是目录）
      const stat = await fs.promises.stat(absolutePath);
      if (!stat.isFile()) {
        return ToolResult.error(`路径不是文件: ${absolutePath}`);
      }
      // 删除文件
      await fs.promises.unlink(absolutePath);
      return ToolResult.success({ message: `文件已删除: ${absolutePath}`, path: absolutePath });
    } catch (err) {
      return ToolResult.error(`删除文件失败: ${err.message}`);
    }
  }
}

module.exports = { FileDeleteTool };
