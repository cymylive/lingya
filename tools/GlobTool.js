const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

// 需要忽略的目录（与 main.js 的 getDirectoryTree 一致）
const IGNORED_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out',
  '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.coverage',
  'vendor', 'bower_components', 'jspm_packages',
  '.idea', '.vscode', '.vs',
  'logs', 'tmp', 'temp',
  'bin', 'obj',
]);

// 匹配结果上限，防止超大目录爆炸
const MAX_RESULTS = 1000;

/**
 * 将 glob 模式转换为正则表达式
 * 支持：* 匹配单层内任意字符、** 匹配任意层目录、? 匹配单个字符
 */
function globToRegex(pattern) {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { regex += '(?:.*/)?'; i += 3; continue; } // **/
        regex += '.*'; i += 2; continue; // **
      }
      regex += '[^/]*'; i++; continue; // *
    }
    if (ch === '?') { regex += '[^/]'; i++; continue; }
    if ('\\.+()[]{}^$|'.includes(ch)) { regex += '\\' + ch; i++; continue; }
    regex += ch; i++;
  }
  return new RegExp('^' + regex + '$');
}

/**
 * 递归遍历目录，收集匹配 glob 模式的文件
 */
function walkDir(dir, baseDir, regex, results) {
  if (results.length >= MAX_RESULTS) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return; // 无权限等，跳过
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return;
    if (entry.name.startsWith('.')) continue; // 隐藏文件
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkDir(fullPath, baseDir, regex, results);
    } else if (entry.isFile()) {
      // 统一使用 / 分隔符匹配
      const rel = path.relative(baseDir, fullPath).split(path.sep).join('/');
      if (regex.test(rel)) {
        results.push(rel);
      }
    }
  }
}

/**
 * Glob 搜索工具 - 仿照 Claude Code 的 Glob 工具
 * 按 glob 模式递归搜索项目中的文件
 */
class GlobTool extends Tool {
  constructor() {
    super(
      'file_glob', '按 glob 模式递归搜索项目文件，返回匹配的相对路径列表（自动跳过 node_modules 等目录）。',
      {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'glob 匹配模式，如 **/*.java、src/**/*.js、*.json'
          },
          path: {
            type: 'string',
            description: '搜索的起始目录（相对路径），默认项目根目录'
          }
        },
        required: ['pattern'],
        additionalProperties: false
      },
      null
    );
  }

  /**
   * 执行 glob 搜索
   * @param {Object} params - { pattern, path?, projectDir? }
   * @returns {Promise<ToolResult>}
   */
  async execute(params) {
    const { pattern, path: searchPath, projectDir } = params;

    try {
      if (!pattern || typeof pattern !== 'string') {
        return ToolResult.error('pattern 不能为空');
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

      const regex = globToRegex(pattern);
      const results = [];
      walkDir(baseDir, baseDir, regex, results);
      results.sort((a, b) => a.localeCompare(b));

      console.log(`[GlobTool] 搜索完成: pattern=${pattern}, baseDir=${baseDir}, 匹配 ${results.length} 个文件`);

      return ToolResult.success({
        message: `找到 ${results.length} 个匹配文件`,
        pattern: pattern,
        baseDir: baseDir,
        files: results,
        truncated: results.length >= MAX_RESULTS
      });
    } catch (err) {
      return ToolResult.error(`Glob 搜索失败: ${err.message}`);
    }
  }
}

module.exports = { GlobTool };