/**
 * 工作区跨窗口聚合
 *
 * 扫描 userData 下所有 profile 的 session-dir-map-<profileId>.json，
 * 合并成一个统一的项目/会话视图，供侧栏「工作区」页展示。
 *
 * 设计要点：
 * - 不改现有数据结构，老数据零迁移
 * - 单个文件损坏只跳过该文件，不影响其余
 * - 同 sessionId 跨 profile 去重：updatedAt 取最新，archived 取 OR
 */
'use strict';
const fs = require('fs');
const path = require('path');

function normalizeEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    return { projectDir: entry, title: null, createdAt: null, updatedAt: null, archivedAt: null };
  }
  if (typeof entry === 'object') {
    return {
      projectDir: entry.projectDir != null ? entry.projectDir : null,
      title: entry.title || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
      archivedAt: entry.archivedAt || null,
    };
  }
  return null;
}

/**
 * @param {string} userDataDir 用户数据根目录
 * @param {string} currentProfileId 当前窗口的 profile id
 * @param {Array<{id:string,name:string}>} profileList 全部 profile
 * @returns {{success:boolean, sessions:Array, archivedProjects:string[], currentProfileId:string}}
 */
function aggregateWorkspaces(userDataDir, currentProfileId, profileList) {
  const sessions = new Map();   // sessionId -> AggregatedSession
  const archivedProjects = new Set();
  const profiles = Array.isArray(profileList) ? profileList : [];

  for (const p of profiles) {
    if (!p || !p.id) continue;
    const file = path.join(userDataDir, 'session-dir-map-' + p.id + '.json');
    let store = null;
    try {
      if (!fs.existsSync(file)) continue;
      store = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (_) {
      continue;   // 损坏文件跳过
    }
    if (!store || typeof store !== 'object') continue;

    // 归档项目
    const pa = store.__project_archived__;
    if (pa && typeof pa === 'object') {
      for (const dir of Object.keys(pa)) archivedProjects.add(dir);
    }

    // 会话
    for (const sid of Object.keys(store)) {
      if (sid === '__project_archived__') continue;
      const e = normalizeEntry(store[sid]);
      if (!e) continue;
      const incoming = {
        sessionId: sid,
        projectDir: e.projectDir || null,
        title: e.title || null,
        createdAt: e.createdAt || null,
        updatedAt: e.updatedAt || null,
        archived: !!(e.archivedAt),
        profileId: p.id,
        profileName: p.name || p.id,
      };
      const existing = sessions.get(sid);
      if (!existing) {
        sessions.set(sid, incoming);
      } else {
        // 同 sessionId：updatedAt 取最新，archived 取 OR
        const oldT = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
        const newT = incoming.updatedAt ? Date.parse(incoming.updatedAt) : 0;
        if (newT > oldT) {
          incoming.archived = incoming.archived || existing.archived;
          sessions.set(sid, incoming);
        } else {
          existing.archived = existing.archived || incoming.archived;
        }
      }
    }
  }

  return {
    success: true,
    sessions: Array.from(sessions.values()),
    archivedProjects: Array.from(archivedProjects),
    currentProfileId: currentProfileId || null,
  };
}

module.exports = { aggregateWorkspaces };
