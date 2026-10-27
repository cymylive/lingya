#!/usr/bin/env node
/**
 * 插件自检脚本：静态校验插件目录的完整性与规范性。
 * 用法：node scripts/check-plugin.js <id>
 * 不带参数时，校验 plugins/ 下所有插件。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// 宿主支持的 API 版本（与 plugin-host.js 保持一致）
const HOST_API_VERSION = 1;

const target = process.argv[2];
let dirs = [];
if (target) {
  const d = path.join(PLUGINS_DIR, target);
  if (!fs.existsSync(d)) { console.error('插件不存在: ' + d); process.exit(1); }
  dirs = [d];
} else {
  if (!fs.existsSync(PLUGINS_DIR)) { console.error('plugins 目录不存在'); process.exit(1); }
  dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(PLUGINS_DIR, e.name));
}

let hasError = false;

for (const dir of dirs) {
  const id = path.basename(dir);
  const errs = [];
  const warns = [];

  // 1. manifest.json
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) {
    errs.push('缺少 manifest.json');
  } else {
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); }
    catch (e) { errs.push('manifest.json 不是合法 JSON: ' + e.message); }
    if (manifest) {
      if (!manifest.id) errs.push('manifest 缺少 id');
      else if (!/^[a-z0-9][a-z0-9-_.]*$/.test(manifest.id)) warns.push('id 建议只用小写字母/数字/-/_/.');
      else if (manifest.id !== id) warns.push('manifest.id (' + manifest.id + ') 与目录名 (' + id + ') 不一致');
      if (manifest.apiVersion && Number(manifest.apiVersion) > HOST_API_VERSION) {
        errs.push('需要 API v' + manifest.apiVersion + '，宿主仅支持 v' + HOST_API_VERSION);
      }
      const entry = manifest.entry || 'index.js';
      const ep = path.join(dir, entry);
      if (!fs.existsSync(ep)) errs.push('入口文件不存在: ' + entry);
    }
  }

  // 2. 入口语法（仅做 CJS 粗检，ESM 允许 export）
  const ep = path.join(dir, 'index.js');
  if (fs.existsSync(ep)) {
    const code = fs.readFileSync(ep, 'utf8');
    if (!/apply\s*\(/.test(code)) errs.push('入口文件未导出 apply(ctx)');
    if (!/registerIpc|registerPreload|registerView|tools\.register/.test(code)) {
      warns.push('未注册任何能力（IPC/View/Preload/Tool）');
    }
  }

  // 输出
  const name = id;
  if (errs.length === 0 && warns.length === 0) {
    console.log('✅ ' + name);
  } else {
    if (errs.length) {
      hasError = true;
      console.log('❌ ' + name);
      errs.forEach(e => console.log('   错误: ' + e));
    } else {
      console.log('⚠️  ' + name);
    }
    warns.forEach(w => console.log('   警告: ' + w));
  }
}

if (hasError) process.exit(1);
