/**
 * Profile 管理模块
 * 每个 profile 对应一个独立的 partition，实现类似 Chrome 的多用户隔离。
 * profile 列表持久化在 userData/profile-list.json。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let PROFILE_FILE = null;

function getProfileFile() {
  if (!PROFILE_FILE) {
    PROFILE_FILE = path.join(app.getPath('userData'), 'profile-list.json');
  }
  return PROFILE_FILE;
}

/** 为缺 number 的 profile 按当前顺序补 1..n；返回是否发生了修改 */
function ensureNumbers(profiles) {
  let changed = false;
  for (let i = 0; i < profiles.length; i++) {
    const n = profiles[i].number;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) {
      profiles[i].number = i + 1;
      changed = true;
    }
  }
  return changed;
}

function readProfiles() {
  try {
    const file = getProfileFile();
    if (fs.existsSync(file)) {
      const profiles = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(profiles)) return [];
      if (ensureNumbers(profiles)) writeProfiles(profiles);
      return profiles;
    }
  } catch (err) {
    console.error('[Profile] 读取 profile 列表失败:', err.message);
  }
  return [];
}

function writeProfiles(profiles) {
  try {
    const file = getProfileFile();
    fs.writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Profile] 写入 profile 列表失败:', err.message);
  }
}

/**
 * 创建新 profile
 * @param {string} name 显示名称
 * @param {string} providerId 平台 id（默认 deepseek）
 */
function createProfile(name, providerId) {
  const profiles = readProfiles();
  // providerId 为空表示平台未确定，首次打开会显示平台选择页
  const pid = providerId || '';
  const id = 'profile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const profile = {
    id,
    providerId: pid,
    name: name || ('窗口' + (profiles.length + 1)),
    partition: 'persist:' + (pid ? pid + ':' : '') + id,
    number: profiles.length + 1,
    createdAt: new Date().toISOString(),
    feishuChatId: '',
    feishuChatName: '',
  };
  profiles.push(profile);
  writeProfiles(profiles);
  console.log('[Profile] 已创建:', profile.id, profile.name, 'provider=' + (pid || '(未确定)'));
  return profile;
}

/**
 * 获取默认 profile，若不存在则创建
 */
function getDefaultProfile() {
  const profiles = readProfiles();
  if (profiles.length > 0) return profiles[0];
  return createProfile('默认窗口', '');
}

/**
 * 根据 id 获取 profile
 */
function getProfileById(id) {
  return readProfiles().find(p => p.id === id) || null;
}

/**
 * 删除 profile
 */
function deleteProfile(id) {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) return false;
  profiles.splice(idx, 1);
  writeProfiles(profiles);
  return true;
}

/**
 * 更新 profile 平台
 */
function updateProfileProvider(id, providerId) {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !providerId) return null;
  p.providerId = providerId;
  p.partition = 'persist:' + providerId + ':' + id;
  writeProfiles(profiles);
  return p;
}

/**
 * 更新 profile 的窗口位置/大小
 * @param {string} id profile id
 * @param {{x:number,y:number,width:number,height:number,maximized:boolean}} bounds
 */
function updateProfileBounds(id, bounds) {
  if (!id || !bounds) return null;
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.windowBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized: !!bounds.maximized,
  };
  writeProfiles(profiles);
  return p;
}

/**
 * 更新 profile 显示名称
 */
function updateProfileName(id, name) {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !name || !name.trim()) return null;
  p.name = name.trim();
  writeProfiles(profiles);
  return p;
}

/**
 * 按给定 id 顺序重排 profile 数组并落盘。
 * 未出现在 orderedIds 中的 profile 追加到末尾（保持原相对顺序）。
 * @param {string[]} orderedIds
 * @returns {object[]|null} 重排后的数组；参数非法返回 null
 */
function reorderProfiles(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return null;
  const profiles = readProfiles();
  const byId = new Map(profiles.map(p => [p.id, p]));
  const out = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p) { out.push(p); byId.delete(id); }
  }
  for (const p of profiles) if (byId.has(p.id)) out.push(p);
  writeProfiles(out);
  return out;
}

/**
 * 修改某 profile 的编号。若目标编号已被他人占用，
 * 占用者及所有 number >= 目标值的其他 profile 全部 +1，再设置目标编号。
 * @param {string} id
 * @param {number} number 正整数
 * @returns {object[]|null}
 */
function updateProfileNumber(id, number) {
  if (!id || !Number.isInteger(number) || number < 1) return null;
  const profiles = readProfiles();
  const target = profiles.find(p => p.id === id);
  if (!target) return null;
  if (target.number === number) return profiles;
  for (const p of profiles) {
    if (p.id === id) continue;
    if (p.number >= number) p.number += 1;
  }
  target.number = number;
  writeProfiles(profiles);
  return profiles;
}

/**
 * 把 dragId 移到 targetId 之前。纯函数，不修改入参。
 * 任一 id 不在数组中、或两者相同，返回入参副本。
 * @param {string[]} ids
 * @param {string} dragId
 * @param {string} targetId
 * @returns {string[]}
 */
function moveIdBefore(ids, dragId, targetId) {
  const src = Array.isArray(ids) ? ids.slice() : [];
  const from = src.indexOf(dragId);
  const to = src.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return src;
  src.splice(from, 1);
  const insertAt = src.indexOf(targetId);
  src.splice(insertAt, 0, dragId);
  return src;
}

/** 设置某 profile 绑定的飞书群（chatId/chatName）；空串表示解绑 */
function setProfileFeishuChat(id, chatId, chatName) {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.feishuChatId = chatId || '';
  p.feishuChatName = chatName || '';
  writeProfiles(profiles);
  console.log('[Profile] 飞书群绑定更新:', id, chatId ? (chatName + '(' + chatId + ')') : '(解绑)');
  return p;
}

/** 按飞书群 chatId 反查 profile（哪个窗口绑了这个群） */
function getProfileByFeishuChat(chatId) {
  if (!chatId) return null;
  return readProfiles().find(p => p.feishuChatId === chatId) || null;
}

module.exports = {
  readProfiles,
  writeProfiles,
  createProfile,
  getDefaultProfile,
  getProfileById,
  updateProfileName,
  updateProfileProvider,
  updateProfileBounds,
  deleteProfile,
  setProfileFeishuChat,
  getProfileByFeishuChat,
  reorderProfiles,
  updateProfileNumber,
  moveIdBefore,
};
