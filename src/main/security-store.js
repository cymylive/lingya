/**
 * 安全增强配置存储（CTF 注入 + Purge 破甲，全局共享，JSON 持久化）
 * 存储文件：<userData>/lingya-security.json
 *
 * 配置项：
 *   ctfInjectionEnabled  是否在系统提示词中注入 CTF 沙箱上下文
 *   ctfPrompt            自定义 CTF 提示词（缺省用内置模板 src/prompt/ctf.md）
 *   purgeEnabled         Purge 破甲规则集是否启用
 *   purgeRuleset         当前启用的规则集 ID（见 src/prompt/purge/manifest.json）
 *   promptChunkSize      初始提示分片的单段字符上限
 *   promptChunkDelayMin / promptChunkDelayMax  分段发送间隔随机区间
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  ctfInjectionEnabled: false,
  ctfPrompt: '',
  // 初始提示分片的单段字符上限。系统提示词太长会拆成多段依次发送，
  // 每段不超过这个值（平台输入框对单条消息有长度限制，超了直接发不出去）。
  // 调大：段数更少、初始化更快，但太大会被平台拒收（DeepSeek 实测约 3 万上限）；
  // 调小：更保险，但段数变多、初始化变慢。
  promptChunkSize: 15000,
  // 初始提示分段之间的发送间隔（毫秒随机区间）。
  // 为什么要随机：固定节拍是最强的机器人指纹，平台风控容易识别。
  // 为什么需要配置：默认区间偏短，段数多时看起来像连着刷屏；用户可自行调大。
  // 实际发送时在 [min, max] 内均匀随机取值。
  promptChunkDelayMin: 1500,
  promptChunkDelayMax: 6000,
  // ===== Purge 破甲系统 =====
  // 独立于 ctfInjectionEnabled：CTF 是「场景声明」，purge 是「Harness 层清洗」
  // 两者可同时启用（purge 提供强指令块，ctf 提供安全测试工作流）
  purgeEnabled: false,
  purgeRuleset: 'default',
};

let STORE_FILE = null;
let cache = null;

function init(storeDir) {
  STORE_FILE = path.join(storeDir, 'lingya-security.json');
  cache = null;
  console.log('[SecurityStore] 存储文件:', STORE_FILE);
}

function getStoreFile() {
  return STORE_FILE;
}

function readRaw() {
  if (cache) return cache;
  try {
    if (STORE_FILE && fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      cache = { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      return cache;
    }
  } catch (err) {
    console.error('[SecurityStore] 读取失败:', err.message);
  }
  cache = { ...DEFAULT_CONFIG };
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
    console.error('[SecurityStore] 写入失败:', err.message);
  }
}

/** 读取完整配置 */
function getConfig() {
  return { ...readRaw() };
}

/** 读取用于返回前端的配置 */
function getPublicConfig() {
  return { ...readRaw() };
}

/**
 * 更新配置（局部合并）
 * @param {object} patch 要更新的字段
 * 说明：局部合并，未传的字段保留原值。
 */
function updateConfig(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('配置更新必须是对象');
  const data = readRaw();
  const next = { ...data };
  const allowed = Object.keys(DEFAULT_CONFIG);
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (key === 'promptChunkDelayMin' || key === 'promptChunkDelayMax') {
      // 区间端点单独归一化；保存后若 min > max 会被 normalizeChunkDelayRange 交换
      next[key] = normalizePositiveInt(patch[key], DEFAULT_CONFIG[key]);
    } else if (key === 'promptChunkSize') {
      // 分片大小范围独立：下限 2000（太小会切出上百段），上限 100000（再大平台必拒收）。
      // 不能用 normalizePositiveInt —— 那个上限硬编码 10000，会把 15000~100000 的值全压成 10000。
      next[key] = normalizeChunkSize(patch[key], DEFAULT_CONFIG[key]);
    } else if (key === 'ctfInjectionEnabled' || key === 'purgeEnabled') {
      next[key] = patch[key] === true;
    } else {
      next[key] = String(patch[key] == null ? '' : patch[key]);
    }
  }
  // 区间端点写反时自动交换，避免用户填 8000/2000 后行为异常
  if (next.promptChunkDelayMin > next.promptChunkDelayMax) {
    const t = next.promptChunkDelayMin;
    next.promptChunkDelayMin = next.promptChunkDelayMax;
    next.promptChunkDelayMax = t;
  }
  writeRaw(next);
  console.log('[SecurityStore] 配置已更新');
  return getPublicConfig();
}

/**
 * 归一化"正整数"配置：非法/缺省回退默认值，最小 1，上限 10000（防误填天文数字刷屏）。
 * 传空字符串视为"用默认值"。
 */
function normalizePositiveInt(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 10000);
}

/**
 * 归一化分片大小：范围 2000~100000。
 * 传空字符串视为「用默认值」。
 */
function normalizeChunkSize(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < 2000) return 2000;
  if (n > 100000) return 100000;
  return n;
}

/** 重置为默认配置 */
function resetConfig() {
  writeRaw({ ...DEFAULT_CONFIG });
  console.log('[SecurityStore] 配置已重置');
  return getPublicConfig();
}

module.exports = {
  DEFAULT_CONFIG,
  init,
  getStoreFile,
  getConfig,
  getPublicConfig,
  updateConfig,
  resetConfig,
};
