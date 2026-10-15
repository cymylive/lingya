/**
 * DSH 兼容层 - 插件会话落盘（JSONL）
 * 存储：<userData>/dsh-plugins-data/<id>/session.jsonl
 * 事件流追加；加载时读回重放（驱动投影恢复状态）。
 */
const fs = require('fs');
const path = require('path');

class PluginStorage {
  constructor(dataDir, id) {
    this._dir = path.join(dataDir, 'dsh-plugins-data', id);
    this._file = path.join(this._dir, 'session.jsonl');
    try { fs.mkdirSync(this._dir, { recursive: true }); } catch (_) {}
  }

  append(ev) {
    try { fs.appendFileSync(this._file, JSON.stringify(ev) + '\n', 'utf-8'); } catch (_) {}
  }

  readAll() {
    const out = [];
    try {
      if (!fs.existsSync(this._file)) return out;
      const text = fs.readFileSync(this._file, 'utf-8');
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch (_) {}
      }
    } catch (_) {}
    return out;
  }
}

module.exports = { PluginStorage };
