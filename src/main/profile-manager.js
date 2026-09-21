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

function readProfiles() {
  try {
    const file = getProfileFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
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
    createdAt: new Date().toISOString(),
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
};
