const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

// 需要忽略的目录（与 main.js / GlobTool 一致）
const IGNORED_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out',
  '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.coverage',
  'vendor', 'bower_components', 'jspm_packages',
  '.idea', '.vscode', '.vs',
  'logs', 'tmp', 'temp',
  'bin', 'obj',
]);

// 匹配结果上限，防止输出爆炸
const MAX_MATCHES = 200;
// 跳过超大文件（1MB）
const MAX_FILE_SIZE = 1024 * 1024;
// 单行输出截断长度
const MAX_LINE_LEN = 500;

/**
 * 将 glob 模式转换为正则表达式（与 GlobTool 相同的实现）
 */
function globToRegex(pattern) {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { regex += '(?:.*/)?'; i += 3; continue; }
        regex += '.*'; i += 2; continue;
      }
      regex += '[^/]*'; i++; continue;
    }
    if (ch === '?') { regex += '[^/]'; i++; continue; }
    if ('\\.+()[]{}^$|'.includes(ch)) { regex += '\\' + ch; i++; continue; }
    regex += ch; i++;
  }
  return new RegExp('^' + regex + '$');
}

/**
 * 截断过长的行
 */
function truncateLine(line) {
  if (line.length <= MAX_LINE_LEN) return line;
  return line.substring(0, MAX_LINE_LEN) + '...[已截断]...';
}

/**
 * 递归遍历目录，搜索文件内容
 */
function grepDir(dir, baseDir, regex, fileRegex, outputMode, context, matches, counts) {
  if (matches.length >= MAX_MATCHES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) return;
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      grepDir(fullPath, baseDir, regex, fileRegex, outputMode, context, matches, counts);
    } else if (entry.isFile()) {
      // 相对路径（/ 分隔）
      const rel = path.relative(baseDir, fullPath).split(path.sep).join('/');
      // 文件类型过滤
      if (fileRegex && !fileRegex.test(rel)) continue;
      // 大小限制
      let stat;
      try { stat = fs.statSync(fullPath); } catch (e) { continue; }
      if (stat.size > MAX_FILE_SIZE) continue;
      // 读取内容
      let content;
      try { content = fs.readFileSync(fullPath, 'utf-8'); } catch (e) { continue; }
      // 跳过二进制文件
      if (content.includes('\0')) continue;

      const lines = content.split('\n');
      const fileMatches = [];
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          if (outputMode === 'count') {
            counts[rel] = (counts[rel] || 0) + 1;
          } else {
            fileMatches.push({ line: i + 1, content: truncateLine(lines[i]) });
            // 上下文行
            if (context > 0) {
              for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
                if (j === i) continue;
                fileMatches.push({ line: j + 1, content: truncateLine(lines[j]), context: true });
              }
            }
          }
        }
      }
      if (fileMatches.length > 0) {
        matches.push({ file: rel, matches: fileMatches });
      }
    }
  }
}

/**
 * Grep 搜索工具 - 仿照 Claude Code 的 Grep 工具
 * 在项目文件中按正则表达式或文本搜索内容
 */
class GrepTool extends Tool {
  constructor() {
    super(
      'file_grep', '在项目文件中按正则表达式或文本搜索，返回匹配的文件、行号与行内容。',
      {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '要搜索的正则表达式或纯文本'
          },
          path: {
            type: 'string',
            description: '搜索的起始目录（相对路径），默认项目根目录'
          },
          glob: {
            type: 'string',
            description: '限定搜索的文件类型，如 *.java、**/*.js（可选）'
          },
          ignore_case: {
            type: 'boolean',
            description: '忽略大小写，默认 false',
            default: false
          },
          output_mode: {
            type: 'string',
            description: 'content（输出匹配行）或 count（仅统计数量），默认 content',
            default: 'content'
          },
          context: {
            type: 'number',
            description: '匹配行前后各输出的上下文行数，默认 0',
            default: 0
          }
        },
        required: ['pattern'],
        additionalProperties: false
      },
      null
    );
  }

  /**
   * 执行 grep 搜索
   * @param {Object} params - { pattern, path?, glob?, ignore_case?, output_mode?, context?, projectDir? }
   * @returns {Promise<ToolResult>}
   */
  async execute(params) {
    const { pattern, path: searchPath, glob, ignore_case = false, output_mode = 'content', context = 0, projectDir } = params;

    try {
      if (!pattern || typeof pattern !== 'string') {
        return ToolResult.error('pattern 不能为空');
      }

      // 编译正则
      let regex;
      try {
        regex = new RegExp(pattern, ignore_case ? 'i' : '');
      } catch (e) {
        return ToolResult.error('无效的正则表达式: ' + e.message + '，如需搜索纯文本请转义特殊字符');
      }

      // 确定搜索起始目录
      let baseDir;
      if (searchPath) {
        const normalized = searchPath.replace(/\//g, path.sep);
        baseDir = path.isAbsolute(normalized)
          ? normalized
          : (projectDir ? path.join(projectDir, normalized) : path.resolve(normalized));
      } else if (projectDir) {
        baseDir = projectDir;
      } else {
        baseDir = path.resolve('.');
      }

      if (!fs.existsSync(baseDir)) {
        return ToolResult.error(`目录不存在: ${baseDir}`);
      }
      if (!fs.statSync(baseDir).isDirectory()) {
        return ToolResult.error(`不是目录: ${baseDir}`);
      }

      // 文件类型过滤
      let fileRegex = null;
      if (glob) {
        fileRegex = globToRegex(glob);
      }

      const matches = [];
      const counts = {};
      grepDir(baseDir, baseDir, regex, fileRegex, output_mode, context, matches, counts);

      // 按文件路径排序
      matches.sort((a, b) => a.file.localeCompare(b.file));

      console.log(`[GrepTool] 搜索完成: pattern=${pattern}, baseDir=${baseDir}, 匹配文件 ${matches.length} 个`);

      if (output_mode === 'count') {
        return ToolResult.success({
          message: `搜索完成，共匹配 ${Object.keys(counts).length} 个文件`,
          pattern: pattern,
          baseDir: baseDir,
          counts: counts,
          totalMatches: Object.values(counts).reduce((sum, n) => sum + n, 0)
        });
      }

      return ToolResult.success({
        message: `搜索完成，共 ${matches.length} 个文件包含匹配`,
        pattern: pattern,
        baseDir: baseDir,
        matches: matches,
        truncated: matches.length >= MAX_MATCHES
      });
    } catch (err) {
      return ToolResult.error(`Grep 搜索失败: ${err.message}`);
    }
  }
}

module.exports = { GrepTool };