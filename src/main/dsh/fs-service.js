/**
 * DSH 兼容层 - ctx.fs 服务（CommonJS）
 *
 * 简化自 dsh 的 FileSystem（对齐 cuckoo 的 fs-service）：
 *   resolve / readText / streamText / listDir / writeText / editText
 * 相对路径基准 = 当前项目目录（宿主注入 getProjectDir）。
 */
const fs = require('fs');
const path = require('path');

function createFs(getProjectDir) {
  function abs(p) {
    if (path.isAbsolute(p)) return p;
    const base = typeof getProjectDir === 'function' ? getProjectDir() : null;
    return base ? path.join(base, p) : path.resolve(p);
  }
  return {
    async resolve(p) {
      if (typeof p !== 'string' || !p) throw new Error('fs.resolve: path 必须是非空字符串');
      const a = abs(p);
      return { path: a, key: a };
    },
    async readText(target) {
      return fs.readFileSync(target.path, 'utf-8');
    },
    async streamText(target) {
      const text = fs.readFileSync(target.path, 'utf-8');
      return (async function* () { yield text; })();
    },
    async listDir(target) {
      const entries = fs.readdirSync(target.path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        target: { path: path.join(target.path, e.name), key: path.join(target.path, e.name) },
      }));
    },
    async writeText(target, content) {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, String(content), 'utf-8');
      const st = fs.statSync(target.path);
      return { version: String(st.mtimeMs), bytes: st.size };
    },
    async editText(target, edit) {
      const oldText = edit && (edit.oldText || edit.old_string || edit.search);
      const newText = (edit && (edit.newText != null ? edit.newText : (edit.new_string != null ? edit.new_string : edit.replace))) || '';
      if (typeof oldText !== 'string') throw new Error('fs.editText: 缺少 oldText');
      let cur = fs.readFileSync(target.path, 'utf-8');
      if (!cur.includes(oldText)) throw new Error('fs.editText: 未找到要替换的文本');
      cur = cur.replace(oldText, newText);
      fs.writeFileSync(target.path, cur, 'utf-8');
      const st = fs.statSync(target.path);
      return { version: String(st.mtimeMs) };
    },
  };
}

module.exports = { createFs };
