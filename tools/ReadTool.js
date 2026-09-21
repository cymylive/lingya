const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

// 与 dsh read 对齐的默认上限
const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;

/**
 * 校验并归一化 read 参数。
 * offset/limit 必须是正整数，limit 不能超过 READ_LIMIT。
 */
function parseReadArgs(filePath, offset, limit) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('file_path must be a non-empty string');
  }
  const parsedOffset = offset === undefined || offset === null ? 1 : Number(offset);
  const parsedLimit = limit === undefined || limit === null ? READ_LIMIT : Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 1) {
    throw new Error('offset must be a positive integer');
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new Error('limit must be a positive integer');
  }
  if (parsedLimit > READ_LIMIT) {
    throw new Error('limit must be less than or equal to ' + READ_LIMIT);
  }
  return { offset: parsedOffset, limit: parsedLimit };
}

function truncateLine(line, maxLineLength) {
  return line.length > maxLineLength
    ? line.substring(0, maxLineLength) + '... (line truncated to ' + maxLineLength + ' chars)'
    : line;
}

function lineByteSize(line, currentLineCount) {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0);
}

function stripCarriageReturn(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 从全文构建带行号的窗口，逻辑对齐 dsh read-render.buildWindow。
 */
function buildWindow(text, request, displayPath) {
  const acc = { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false };
  const rawLines = text.split(/\r?\n/);

  // 按行扫描：每行都计入 totalLines，但只保留窗口内的行
  for (const rawLine of rawLines) {
    acc.totalLines += 1;
    if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) continue;

    const lineText = stripCarriageReturn(rawLine);
    const text = truncateLine(lineText, request.maxLineLength);
    const bytes = lineByteSize(text, acc.lines.length);
    if (acc.outputBytes + bytes > request.maxBytes) {
      acc.truncatedByBytes = true;
      continue;
    }
    acc.outputBytes += bytes;
    acc.lines.push({ number: acc.totalLines, text });
  }

  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new Error('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + acc.totalLines + ' lines)');
  }

  return {
    lines: acc.lines,
    totalLines: acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes,
  };
}

/**
 * 与 dsh formatReadOutput 保持一致：返回 envelope，包含行号和 footer。
 */
function formatReadOutput(displayPath, outcome) {
  const endLine = outcome.lines.length > 0
    ? outcome.lines[outcome.lines.length - 1].number
    : Math.max(0, outcome.offset - 1);

  let footer;
  if (outcome.truncatedByBytes) {
    footer = '(Output capped. Showing lines ' + outcome.offset + '-' + endLine + '. Use offset=' + (endLine + 1) + ' to continue.)';
  } else if (endLine < outcome.totalLines) {
    footer = '(Showing lines ' + outcome.offset + '-' + endLine + ' of ' + outcome.totalLines + '. Use offset=' + (endLine + 1) + ' to continue.)';
  } else {
    footer = '(End of file - total ' + outcome.totalLines + ' lines)';
  }

  const body = outcome.lines.length > 0
    ? outcome.lines.map(line => line.number + ': ' + line.text).join('\n') + '\n\n' + footer
    : footer;

  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + body + '\n</content>';
}

/**
 * read 工具 - 完全仿照 dsh 的 read。
 * 返回带行号的文本窗口，支持 offset/limit 分段读取大文件。
 */
class ReadTool extends Tool {
  constructor() {
    super(
      'read',
      '读取 UTF-8 文本文件并返回带行号的内容窗口。支持 offset/limit 分段读取大文件。',
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
      'read(filePath, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:read',
      order: 100,
      text: '使用 read 工具（而不是 cat 等 shell 命令）来查看文本文件。结果包含行号。使用 offset 和 limit 继续读取大文件。'
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

      // 读取整个文件内容（当前实现与 dsh 流式不同，但保证 totalLines 精确）
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const request = {
        offset: input.offset,
        limit: input.limit,
        maxLineLength: READ_MAX_LINE_LENGTH,
        maxBytes: READ_MAX_BYTES,
      };
      const window = buildWindow(content, request, file_path);

      console.log('[ReadTool] 已读取:', resolvedPath, 'offset=' + input.offset, 'limit=' + input.limit, 'totalLines=' + window.totalLines);
      return ToolResult.success(formatReadOutput(file_path, { ...window, offset: input.offset }));
    } catch (err) {
      return ToolResult.error('读取文件失败: ' + err.message);
    }
  }
}

module.exports = { ReadTool, READ_LIMIT, READ_MAX_LINE_LENGTH, READ_MAX_BYTES, parseReadArgs, buildWindow, formatReadOutput };
