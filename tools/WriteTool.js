const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

/**
 * 校验 write 参数：
 * - file_path 必须是非空字符串
 * - content 允许为空字符串（写空文件是合法的）
 */
function parseWriteArgs(filePath, content) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('file_path must be a non-empty string');
  }
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  return { filePath, content };
}

/**
 * 与 dsh formatWriteOutput 对齐：返回 envelope，不回显内容。
 */
function formatWriteOutput(displayPath, operation) {
  const verb = operation === 'create' ? 'Created' : 'Updated';
  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + verb + ' file\n</content>';
}

/**
 * write 工具 - 仿照 dsh 的 write。
 * 创建或完全覆盖 UTF-8 文本文件。
 */
class WriteTool extends Tool {
  constructor() {
    super(
      'write',
      '创建或完全覆盖 UTF-8 文本文件。返回 Created/Updated 确认信息。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '要写入的文件路径（相对路径基于项目根目录，或绝对路径）'
          },
          content: {
            type: 'string',
            description: '完整 UTF-8 文本内容。空字符串合法（写入空文件）'
          }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      },
      'write(filePath, content)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:write',
      order: 101,
      text: '使用 write 工具创建文件或完全替换文件内容。已有文件会被覆盖，所以覆盖前先 read 文件，针对局部修改优先用 edit。注意：read 输出的内容带行号和 footer，写入的 content 必须是文件原始内容，不要包含行号、<path>/<content> 包装或 footer 提示。'
    };
  }

  async execute(params) {
    const { file_path, content, projectDir } = params;

    try {
      const input = parseWriteArgs(file_path, content);

      // 路径解析：相对路径基于 projectDir
      const normalizedPath = input.filePath.replace(/\//g, path.sep);
      let resolvedPath = normalizedPath;
      if (!path.isAbsolute(normalizedPath) && projectDir) {
        resolvedPath = path.join(projectDir, normalizedPath);
      } else if (!path.isAbsolute(normalizedPath)) {
        resolvedPath = path.resolve(normalizedPath);
      }

      // 检查路径是否为目录
      if (fs.existsSync(resolvedPath)) {
        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          return ToolResult.error('写入失败: 目标路径是目录，不是文件: ' + resolvedPath);
        }
      }

      // 判断是 create 还是 update（最小移植不读 before/after）
      const operation = fs.existsSync(resolvedPath) ? 'update' : 'create';

      // 确保目录存在
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写文件
      fs.writeFileSync(resolvedPath, input.content, 'utf-8');

      console.log('[WriteTool] ' + (operation === 'create' ? 'Created' : 'Updated') + ':', resolvedPath);
      return ToolResult.success(formatWriteOutput(input.filePath, operation));
    } catch (err) {
      return ToolResult.error('写入文件失败: ' + err.message);
    }
  }
}

module.exports = { WriteTool, parseWriteArgs, formatWriteOutput };
