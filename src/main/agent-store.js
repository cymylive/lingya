/**
 * Agent 状态存储（每个窗口 profile 独立，JSON 持久化）
 * 存储文件：<userData>/lingya-agents.json
 *
 * 结构：{ "<profileId>": "build" | "plan" }
 *
 * 与 memory-store / skill-store 不同，agent 是 per-profile 的，
 * 因为不同窗口可能对应不同项目，规划/构建状态天然按窗口隔离。
 */
const fs = require('fs');
const path = require('path');
const { DEFAULT_AGENT_ID, listAgentIds } = require('./agents');

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-agents.json');
  cache = null;
  console.log('[AgentStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
      return cache;
    }
  } catch (err) {
    console.error('[AgentStore] 读取失败:', err.message);
  }
  cache = {};
  return cache;
}

function writeRaw(data) {
  cache = data;
  try {
    if (STORE_FILE) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[AgentStore] 写入失败:', err.message);
  }
}

/**
 * 获取指定 profile 的当前 agent id（未知/未设置回退默认）
 * @param {string} profileId
 */
function getAgentId(profileId) {
  const data = readRaw();
  const id = data[profileId];
  if (id && listAgentIds().includes(id)) return id;
  return DEFAULT_AGENT_ID;
}

/**
 * 设置指定 profile 的 agent id
 * @param {string} profileId
 * @param {string} agentId
 */
function setAgentId(profileId, agentId) {
  if (!profileId) throw new Error('profileId 不能为空');
  if (!listAgentIds().includes(agentId)) throw new Error('未知 agent: ' + agentId);
  const data = { ...readRaw() };
  data[profileId] = agentId;
  writeRaw(data);
  return agentId;
}

/** 清除指定 profile 的 agent 记录（删除窗口时调用） */
function clearProfile(profileId) {
  const data = { ...readRaw() };
  if (profileId in data) {
    delete data[profileId];
    writeRaw(data);
  }
}

module.exports = { init, getStoreFile, getAgentId, setAgentId, clearProfile };
