/**
 * 项目文件树：只读递归读取当前项目目录
 *
 * 设计约束：
 *  - 忽略 node_modules / .git / dist 等大目录（可配置）
 *  - 节点数上限保护（默认 5000），超限标记 truncated
 *  - 深度上限（默认 12），避免超深目录卡死
 *  - 单次 IPC 返回整树（前端做搜索过滤，避免多次往返）
 */
const fs = require('fs');
const path = require('path');

// 默认忽略的目录名（精确匹配）
// 仅忽略「必然导致卡死或纯垃圾」的目录（放开 dist/build/out 等，让文件树显示完整项目）
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',      // 版本库/依赖：动辄数万节点，必须忽略
  '__pycache__', '.pytest_cache', '.mypy_cache', '.cache',   // Python 缓存
  'venv', '.venv',                             // 虚拟环境（数千文件）
  '.DS_Store',                                 // 系统文件
]);

const MAX_NODES = 5000;
const MAX_DEPTH = 12;

/**
 * 递归构建目录树
 * @param {string} root 项目根目录
 * @param {{maxNodes?:number, maxDepth?:number, ignoreDirs?:Set<string>}} [options]
 * @returns {{tree: Array, truncated: boolean, nodeCount: number, error?: string}}
 */
function buildFileTree(root, options) {
  const opts = options || {};
  const maxNodes = opts.maxNodes || MAX_NODES;
  const maxDepth = opts.maxDepth || MAX_DEPTH;
  const ignore = opts.ignoreDirs || IGNORE_DIRS;

  if (!root) return { tree: [], truncated: false, nodeCount: 0, error: '未提供项目目录' };
  if (!fs.existsSync(root)) return { tree: [], truncated: false, nodeCount: 0, error: '目录不存在: ' + root };
  if (!fs.statSync(root).isDirectory()) return { tree: [], truncated: false, nodeCount: 0, error: '不是目录: ' + root };

  let nodeCount = 0;
  let truncated = false;

  function walk(dir, depth) {
    if (depth > maxDepth) { truncated = true; return []; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return [];   // 权限不足等，静默跳过
    }

    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        dirs.push(e);
      } else if (e.isFile()) {
        files.push(e);
      }
      // 符号链接等忽略
    }

    // 目录在前，文件在后；各自按名称排序（不区分大小写）
    const cmp = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    dirs.sort(cmp);
    files.sort(cmp);

    const nodes = [];
    for (const e of dirs) {
      if (nodeCount >= maxNodes) { truncated = true; break; }
      const full = path.join(dir, e.name);
      nodeCount++;
      const children = walk(full, depth + 1);
      nodes.push({ name: e.name, path: full, type: 'dir', children: children });
    }
    for (const e of files) {
      if (nodeCount >= maxNodes) { truncated = true; break; }
      nodeCount++;
      nodes.push({ name: e.name, path: path.join(dir, e.name), type: 'file' });
    }
    return nodes;
  }

  const tree = walk(root, 1);
  return { tree: tree, truncated: truncated, nodeCount: nodeCount };
}

module.exports = { buildFileTree, IGNORE_DIRS, MAX_NODES, MAX_DEPTH };
