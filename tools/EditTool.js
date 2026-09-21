const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

/**
 * 校验 edit 参数（对齐 dsh parseEditArgs）：
 * - file_path trim 后非空
 * - old_string 非空
 * - old_string !== new_string（避免 no-op）
 */
function parseEditArgs(filePath, oldString, newString, replaceAll, dryRun) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('file_path must be a non-empty string');
  }
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error('old_string must be a non-empty string');
  }
  if (typeof newString !== 'string') {
    throw new Error('new_string must be a string');
  }
  if (oldString === newString) {
    throw new Error('old_string and new_string must differ');
  }
  return {
    filePath,
    oldString,
    newString,
    replaceAll: replaceAll === true,
    dryRun: dryRun === true,
  };
}

/**
 * 对齐 dsh formatEditOutput：Claude-style 确认语。
 */
function formatEditOutput(displayPath, replaceAll, occurrences = 1) {
  const noun = occurrences === 1 ? 'occurrence' : 'occurrences';
  return replaceAll
    ? 'The file ' + displayPath + ' has been updated. Replaced ' + occurrences + ' ' + noun + ' successfully.'
    : 'The file ' + displayPath + ' has been updated successfully. Replaced 1 occurrence.';
}

/**
 * dry-run 预览输出：不写文件，只返回将要替换的信息。
 */
function formatDryRunOutput(displayPath, oldString, newString, occurrences, replaceAll) {
  const action = replaceAll
    ? '将全部替换 ' + occurrences + ' 处'
    : '将替换 1 处';
  return '[DRY-RUN] 文件未修改。' + displayPath + '：' + action +
    '。old: ' + JSON.stringify(oldString) + ' → new: ' + JSON.stringify(newString);
}

/**
 * edit 工具 - 仿照 dsh 的 edit。
 * 对现有 UTF-8 文本文件做精确字符串替换。
 */
class EditTool extends Tool {
  constructor() {
    super(
      'edit',
      '对现有 UTF-8 文本文件做精确替换（old_string → new_string）。默认 old_string 必须唯一匹配；多匹配可设置 replaceAll。',
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '要编辑的文件路径（相对路径基于项目根目录，或绝对路径）'
          },
          old_string: {
            type: 'string',
            description: '要替换的字面文本，必须与文件内容精确匹配'
          },
          new_string: {
            type: 'string',
            description: '替换后的字面文本。可用空字符串删除匹配内容'
          },
          replaceAll: {
            type: 'boolean',
            description: '是否替换所有匹配。默认 false；false 时 old_string 必须唯一匹配',
            default: false
          },
          dryRun: {
            type: 'boolean',
            description: '是否只预览不写入。true 时返回将替换的处数和内容，不修改文件',
            default: false
          }
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false
      },
      'edit(filePath, oldString, newString, replaceAll?, dryRun?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:edit',
      order: 102,
      text: '使用 edit 工具对现有 UTF-8 文本文件做定向修改。它用 new_string 替换字面量 old_string；默认 old_string 必须唯一匹配。如果 old_string 出现多次，请提供更具体的 old_string 或设置 replaceAll 为 true。批量替换同一文本时优先用 replaceAll: true 一次完成，避免读全文后整体写回；返回结果会包含实际替换处数，可用于自我校验。批量修改前可用 dryRun: true 预览，确认无误后再真实写入。除非你刚在本会话中创建或编辑过该文件，否则先 read 文件。注意：read 输出的内容带行号，old_string/new_string 必须是文件原始文本，不要包含行号或 footer 提示。'
    };
  }

  async execute(params) {
    const { file_path, old_string, new_string, replaceAll, dryRun, projectDir } = params;

    try {
      const input = parseEditArgs(file_path, old_string, new_string, replaceAll, dryRun);

      // 路径解析：相对路径基于 projectDir
      const normalizedPath = input.filePath.replace(/\//g, path.sep);
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

      // 读取文件内容
      const content = fs.readFileSync(resolvedPath, 'utf-8');

      // 保留原 FileEditTool 的 CRLF 适配能力：
      // 先原样匹配，失败后把 old_string 转 CRLF 再试；new_string 统一转 CRLF
      let oldString = input.oldString;
      let newString = input.newString.replace(/\r?\n/g, '\r\n');

      let occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        oldString = oldString.replace(/\r?\n/g, '\r\n');
        occurrences = content.split(oldString).length - 1;
      }
      if (occurrences === 0) {
        return ToolResult.error('未找到要替换的文本，请检查 old_string 是否与文件内容精确匹配。文件路径: ' + resolvedPath);
      }
      if (occurrences > 1 && !input.replaceAll) {
        return ToolResult.error('old_string 在文件中出现 ' + occurrences + ' 次。若要全部替换，请设置 replaceAll: true；若只替换其中一处，请提供更长的唯一片段（更多上下文）。');
      }

      // 执行替换
      const newContent = input.replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      // dry-run：只预览，不写文件
      if (input.dryRun) {
        console.log('[EditTool] dry-run 预览:', resolvedPath, '将替换', occurrences, '处');
        return ToolResult.success(formatDryRunOutput(input.filePath, input.oldString, input.newString, occurrences, input.replaceAll));
      }

      fs.writeFileSync(resolvedPath, newContent, 'utf-8');

      console.log('[EditTool] 已编辑:', resolvedPath, '替换', occurrences, '处');
      return ToolResult.success(formatEditOutput(input.filePath, input.replaceAll, occurrences));
    } catch (err) {
      return ToolResult.error('编辑文件失败: ' + err.message);
    }
  }
}

module.exports = { EditTool, parseEditArgs, formatEditOutput, formatDryRunOutput };
