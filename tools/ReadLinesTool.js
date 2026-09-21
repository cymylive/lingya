const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');
const { READ_LIMIT, parseReadArgs, buildWindow } = require('./ReadTool');

/**
 * readLines 工具 - 返回结构化行数据（数组），供 AI 在内存中精确处理。
 * 与 read 的区别：
 * - read 返回纯文本 envelope（给 AI "看"）
 * - readLines 返回结构化数组（给 AI "程序处理"）
 */
class ReadLinesTool extends Tool {
  constructor() {
    super(
      'read_lines',
      '读取 UTF-8 文本文件并返回结构化行数组，供 AI 在内存中精确处理。支持 offset/limit 分段读取大文件。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '要读取的文件路径（相对路径基于项目根目录，或绝对路径）'
          },
          offset: {
            type: 'number',
            description: '1-based 起始行号，默认 1'
          },
          limit: {
            type: 'number',
            description: '最大返回行数，默认 ' + READ_LIMIT + '，上限 ' + READ_LIMIT
          }
        },
        required: ['file_path'],
        additionalProperties: false
      },
      'readLines(filePath, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:read_lines',
      order: 101,
      text: '使用 readLines 工具读取文件的结构化行数据（数组，每个元素含 number 和 text 字段），适合在内存中批量处理（如 map/filter/join 后写回）。如果只是查看文件内容，用 read 即可。'
    };
  }

  async execute(params) {
    const { file_path, offset, limit, projectDir } = params;

    try {
      const input = parseReadArgs(file_path, offset, limit);

      // 路径解析：相对路径基于 projectDir
      const normalizedPath = String(file_path).replace(/\//g, path.sep);
      let resolvedPath = normalizedPath;
      if (!path.isAbsolute(normalizedPath) && projectDir) {
        resolvedPath = path.join(projectDir, normalizedPath);
      } else if (!path.isAbsolute(normalizedPath)) {
        resolvedPath = path.resolve(normalizedPath);
      }

      // 文件存在性与类型检查
      if (!fs.existsSync(resolvedPath)) {
        return ToolResult.error('文件不存在: ' + resolvedPath);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return ToolResult.error('不是文件: ' + resolvedPath);
      }

      // 读取整个文件内容
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const window = buildWindow(content, {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: 2000,
        maxBytes: 50 * 1024,
      }, file_path);

      console.log('[ReadLinesTool] 已读取:', resolvedPath, 'offset=' + input.offset, 'limit=' + input.limit, 'totalLines=' + window.totalLines);

      // 返回结构化数据：lines 数组 + 元信息
      return ToolResult.success({
        lines: window.lines,
        totalLines: window.totalLines,
        offset: input.offset,
        truncatedByBytes: window.truncatedByBytes,
      });
    } catch (err) {
      return ToolResult.error('读取文件失败: ' + err.message);
    }
  }
}

module.exports = { ReadLinesTool };
