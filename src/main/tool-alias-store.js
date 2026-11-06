/**
 * 工具别名映射存储（2026-11-06）
 * 
 * 目的：将真实的工具名（如 bash, read）在系统提示词中伪装成别名（如 sys_exec, sys_read），
 * 防止真实的本地执行工具泄露给 AI 平台。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ALIASES = {
  read: 'sys_read',
  write: 'sys_write',
  edit: 'sys_edit',
  readLines: 'sys_read_lines',
  glob: 'sys_glob',
  grep: 'sys_grep',
  bash: 'sys_exec',
  pwsh: 'sys_pwsh',
  todoWrite: 'sys_todo',
  deleteFile: 'sys_delete'
};

let cache = null;

function getStorePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'lingya-tool-aliases.json');
  } catch (_) {
    return path.join(process.cwd(), 'lingya-tool-aliases.json');
  }
}

function ensureLoaded() {
  if (cache) return cache;
  const p = getStorePath();
  try {
    if (fs.existsSync(p)) {
      cache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } else {
      cache = { ...DEFAULT_ALIASES };
      persist();
    }
  } catch (e) {
    cache = { ...DEFAULT_ALIASES };
  }
  return cache;
}

function persist() {
  try {
    const p = getStorePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (_) {}
}

function getAliases() {
  return ensureLoaded();
}

function getRealName(alias) {
  const data = ensureLoaded();
  for (const [real, al] of Object.entries(data)) {
    if (al === alias) return real;
  }
  return alias;
}

module.exports = { getAliases, getRealName };
