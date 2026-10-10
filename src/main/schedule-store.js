/**
 * 定时任务存储（<userData>/lingya-schedules.json）
 * 结构：{ windowProfileId: string|null, tasks: [{ id, name, cron, prompt, enabled, profileId, createdAt, lastRunAt, lastResult }] }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let STORE_DIR = null;

function init(storeDir) { STORE_DIR = storeDir || null; }

function getUserDir() {
  const override = process.env.LINGYA_HOME;
  if (override) return override;
  if (STORE_DIR) return STORE_DIR;
  return path.join(os.homedir(), '.lingya');
}

function getFile() { return path.join(getUserDir(), 'lingya-schedules.json'); }

function defaultData() { return { windowProfileId: null, tasks: [] }; }

function read() {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return defaultData();
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return defaultData();
    return {
      windowProfileId: typeof raw.windowProfileId === 'string' ? raw.windowProfileId : null,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    };
  } catch (err) {
    console.error('[Schedule] 读取失败:', err.message);
    return defaultData();
  }
}

function write(data) {
  try {
    const file = getFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Schedule] 写入失败:', err.message);
    return false;
  }
}

function listTasks() { return read().tasks; }

function getTask(id) { return read().tasks.find((t) => t.id === id) || null; }

function addTask({ name, cron, prompt, enabled, profileId, projectDir }) {
  const data = read();
  const task = {
    id: 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: String(name || '未命名任务').trim(),
    cron: String(cron || '').trim(),
    prompt: String(prompt || '').trim(),
    enabled: enabled !== false,
    // 目标窗口 profileId（空表示用当前活跃窗口）
    profileId: String(profileId || '').trim(),
    // 项目目录（可选，新开对话后注入工具能力用）
    projectDir: String(projectDir || '').trim(),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastResult: null,
  };
  data.tasks.push(task);
  write(data);
  return task;
}

function updateTask(id, patch) {
  const data = read();
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return null;
  if (typeof patch.name === 'string') t.name = patch.name.trim();
  if (typeof patch.cron === 'string') t.cron = patch.cron.trim();
  if (typeof patch.prompt === 'string') t.prompt = patch.prompt.trim();
  if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled;
  if (typeof patch.profileId === 'string') t.profileId = patch.profileId.trim();
  if (typeof patch.projectDir === 'string') t.projectDir = patch.projectDir.trim();
  write(data);
  return t;
}

function deleteTask(id) {
  const data = read();
  const idx = data.tasks.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  data.tasks.splice(idx, 1);
  write(data);
  return true;
}

function markRun(id, result) {
  const data = read();
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return null;
  t.lastRunAt = new Date().toISOString();
  if (result !== undefined) t.lastResult = result;
  write(data);
  return t;
}

function getWindowProfileId() { return read().windowProfileId; }

function setWindowProfileId(pid) {
  const data = read();
  data.windowProfileId = pid || null;
  write(data);
}

module.exports = {
  init, getFile, listTasks, getTask, addTask, updateTask, deleteTask,
  markRun, getWindowProfileId, setWindowProfileId, read, write,
};
