/**
 * 从 GitHub Actions 的 tag 名（GITHUB_REF_NAME）提取版本号，
 * 同步到 package.json 和 package-lock.json。
 * 用法：node scripts/sync-version.js
 */
const fs = require('fs');
const path = require('path');

const tag = process.env.GITHUB_REF_NAME || '';
const version = tag.replace(/^v/, '').trim();

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('[sync-version] 无法从 tag 提取版本号: ' + JSON.stringify(tag));
  process.exit(1);
}

const root = path.join(__dirname, '..');

/** 读取并解析 JSON，容忍 UTF-8 BOM */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

// 更新 package.json
const pkgPath = path.join(root, 'package.json');
const pkg = readJson(pkgPath);
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[sync-version] package.json -> ' + version);

// 更新 package-lock.json
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  if (lock.version) lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log('[sync-version] package-lock.json -> ' + version);
}
