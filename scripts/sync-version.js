/**
 * 同步版本号与派生字段（portable.unpackDirName）。
 *
 * 两种模式：
 *   1. CI 模式（有 GITHUB_REF_NAME，如 v0.6.88）
 *      → 覆盖 package.json / package-lock.json 的 version
 *   2. 本地模式（无 GITHUB_REF_NAME）
 *      → 用 package.json 自身的 version，只同步派生字段（unpackDirName），不改 version
 *
 * 本地模式的意义：npm run build:win:portable:local 等命令通过 pre 钩子调用本脚本，
 * 保证 unpackDirName 永远跟随当前 version，避免升级后复用 %TEMP% 旧解压目录跑旧代码。
 *
 * 用法：node scripts/sync-version.js
 */
const fs = require('fs');
const path = require('path');

const tag = process.env.GITHUB_REF_NAME || '';
const root = path.join(__dirname, '..');

/** 读取并解析 JSON，容忍 UTF-8 BOM */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

// 本地模式：没有 CI tag 时，用 package.json 自身版本号，只同步派生字段（不改 version）。
// 场景：本地 npm run build:win:portable:local 时，unpackDirName 必须跟随 package.json 版本，
// 否则新版 exe 会复用 %TEMP% 里旧版本号命名的解压目录，导致跑旧代码（v0.6.75 实测踩过）。
const localMode = !tag;
let version;
if (localMode) {
  const pkgPathLocal = path.join(root, 'package.json');
  version = String(readJson(pkgPathLocal).version || '').trim();
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('[sync-version] 本地模式：package.json 的 version 非法: ' + JSON.stringify(version));
    process.exit(1);
  }
  console.log('[sync-version] 本地模式（无 GITHUB_REF_NAME），使用 package.json 版本 ' + version);
} else {
  version = tag.replace(/^v/, '').trim();
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('[sync-version] 无法从 tag 提取版本号: ' + JSON.stringify(tag));
    process.exit(1);
  }
}

// 更新 package.json
const pkgPath = path.join(root, 'package.json');
const pkg = readJson(pkgPath);
// 本地模式下 version 取自本文件，赋值等价于不变（显式写清楚避免误解）
pkg.version = version;

// 同步 portable.unpackDirName —— 便携版解压目录名。
// 不同步会导致新版 exe 复用旧版 %TEMP% 解压目录，跳过解压直接跑旧代码。
// （v0.6.75 实测踩过：unpackDirName 停在 0.6.74，新版启动后实际运行的是旧程序）
if (pkg.build && pkg.build.portable && typeof pkg.build.portable.unpackDirName === 'string') {
  const next = 'LingYa-runtime-' + version;
  if (pkg.build.portable.unpackDirName !== next) {
    console.log('[sync-version] unpackDirName: ' + pkg.build.portable.unpackDirName + ' -> ' + next);
    pkg.build.portable.unpackDirName = next;
  }
}

if (localMode) {
  // 本地模式只回写派生字段（unpackDirName），不覆盖 version
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[sync-version] package.json 已同步派生字段（version 保持不变: ' + pkg.version + '）');
} else {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[sync-version] package.json -> ' + version);
}

// 更新 package-lock.json（本地模式不改 lock 的 version）
const lockPath = path.join(root, 'package-lock.json');
if (!localMode && fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  if (lock.version) lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log('[sync-version] package-lock.json -> ' + version);
}
