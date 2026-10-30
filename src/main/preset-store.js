/**
 * 分屏布局预设持久化存储
 *
 * 保存一条「分屏方案」：方向（horizontal / vertical）+ 面板列表（按顺序）。
 * 每个面板记录 profileId / profileName / providerId / title / url，
 * 重启后按 profileId 找回窗口，找不到就按 providerId 新建一个再合并。
 *
 * 存储文件：<userData>/lingya-presets.json
 * 结构：{ version: 1, presets: [{ id, name, direction, panels: [...], createdAt, updatedAt }] }
 */
const fs = require('fs');
const path = require('path');

const FLUSH_DEBOUNCE_MS = 200;

function createPresetStore(storeDir) {
  const STORE_FILE = path.join(storeDir, 'lingya-presets.json');

  let _cache = null;
  let _flushTimer = null;
  let _dirty = false;

  function _empty() {
    return { version: 1, presets: [] };
  }

  function _loadFromDisk() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (raw && Array.isArray(raw.presets)) return raw;
      }
    } catch (err) {
      console.error('[LingYa] 读取预设存储失败:', err.message);
    }
    return _empty();
  }

  function _read() {
    if (_cache === null) _cache = _loadFromDisk();
    return _cache;
  }

  function _markDirty() {
    _dirty = true;
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
    if (_flushTimer.unref) _flushTimer.unref();
  }

  function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (!_dirty || _cache === null) return false;
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(_cache, null, 2), 'utf-8');
      _dirty = false;
      return true;
    } catch (err) {
      console.error('[LingYa] 写入预设存储失败:', err.message);
      return false;
    }
  }

  /** 列出所有预设（返回副本，避免外部改到缓存） */
  function list() {
    const data = _read();
    return data.presets.map(p => ({ ...p, panels: (p.panels || []).map(x => ({ ...x })) }));
  }

  /** 按 id 取一条 */
  function get(id) {
    const found = _read().presets.find(p => p.id === id);
    if (!found) return null;
    return { ...found, panels: (found.panels || []).map(x => ({ ...x })) };
  }

  /**
   * 保存预设。
   * @param {{ name?: string, direction: string, panels: Array }} input
   * @param {string} [id] 传了就覆盖更新（保留 createdAt），不传就新建
   * @returns {{ ok: boolean, preset?: object, error?: string }}
   */
  function save(input, id) {
    if (!input || !Array.isArray(input.panels) || input.panels.length < 2) {
      return { ok: false, error: '至少需要 2 个面板才能存为预设' };
    }
    const direction = input.direction === 'vertical' ? 'vertical' : 'horizontal';
    const name = String(input.name || '').trim() || ('预设 ' + new Date().toLocaleString());
    const panels = input.panels.map(p => ({
      profileId: String(p.profileId || ''),
      profileName: String(p.profileName || ''),
      providerId: String(p.providerId || ''),
      title: String(p.title || ''),
      url: String(p.url || ''),
    }));
    if (panels.some(p => !p.profileId)) {
      return { ok: false, error: '面板缺少 profileId，无法保存' };
    }

    const data = _read();
    const now = new Date().toISOString();

    if (id) {
      const idx = data.presets.findIndex(p => p.id === id);
      if (idx === -1) return { ok: false, error: '预设不存在' };
      data.presets[idx] = {
        ...data.presets[idx],
        name,
        direction,
        panels,
        updatedAt: now,
      };
      _markDirty();
      return { ok: true, preset: get(id) };
    }

    const preset = {
      id: 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name,
      direction,
      panels,
      createdAt: now,
      updatedAt: now,
    };
    data.presets.push(preset);
    _markDirty();
    return { ok: true, preset: get(preset.id) };
  }

  /** 重命名 */
  function rename(id, name) {
    const data = _read();
    const target = data.presets.find(p => p.id === id);
    if (!target) return { ok: false, error: '预设不存在' };
    const n = String(name || '').trim();
    if (!n) return { ok: false, error: '名称不能为空' };
    target.name = n;
    target.updatedAt = new Date().toISOString();
    _markDirty();
    return { ok: true };
  }

  /** 删除 */
  function remove(id) {
    const data = _read();
    const idx = data.presets.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: '预设不存在' };
    data.presets.splice(idx, 1);
    _markDirty();
    return { ok: true };
  }

  return { list, get, save, rename, remove, flush };
}

module.exports = { createPresetStore };
