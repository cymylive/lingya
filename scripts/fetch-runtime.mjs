/**
 * 下载/准备自带的 Node.js 运行时二进制
 *
 * 背景：打包版双击 exe 运行时 PATH 里没有 node/npm，用户机器也不一定装了 node。
 * 此脚本在构建时下载对应平台的 node 二进制到 resources/runtime/<platform>/bin/，
 * 打包后插件安装用它自带的 npm（不碰用户系统）。
 *
 * 幂等：已安装且版本一致时跳过。
 * 用法：node scripts/fetch-runtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'resources', 'runtime');

const NODE_VERSION = 'v20.18.1';   // LTS，稳定

function currentPlatform() {
  const p = process.platform, a = process.arch;
  if (p === 'win32' && a === 'x64') return 'win-x64';
  if (p === 'darwin' && a === 'x64') return 'mac-x64';
  if (p === 'darwin' && a === 'arm64') return 'mac-arm64';
  throw new Error('不支持的平台: ' + p + '-' + a);
}

function nodeAsset(platform) {
  const map = {
    'win-x64': 'node-' + NODE_VERSION + '-win-x64.zip',
    'mac-x64': 'node-' + NODE_VERSION + '-darwin-x64.tar.gz',
    'mac-arm64': 'node-' + NODE_VERSION + '-darwin-arm64.tar.gz',
  };
  return map[platform];
}

// 优先国内镜像（npmmirror）加速
function nodeUrls(asset) {
  return [
    'https://npmmirror.com/mirrors/node/' + NODE_VERSION + '/' + asset,
    'https://cdn.npmmirror.com/binaries/node/' + NODE_VERSION + '/' + asset,
    'https://nodejs.org/dist/' + NODE_VERSION + '/' + asset,
  ];
}

function download(urls, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const url of urls) {
    try {
      console.log('[runtime] 下载 ' + url);
      execSync('curl -L --fail --silent --show-error -o "' + dest + '" "' + url + '"', { stdio: 'inherit', timeout: 600000 });
      const st = fs.statSync(dest);
      if (st.size > 1000000) return;   // >1MB 视为成功
      console.warn('[runtime] 文件过小，重试下一个源');
    } catch (e) {
      console.warn('[runtime] 下载失败: ' + e.message);
    }
  }
  throw new Error('所有下载源都失败: ' + dest);
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith('.zip')) execSync('tar -xf "' + archive + '" -C "' + dest + '"', { stdio: 'inherit' });
  else if (archive.endsWith('.tar.gz')) execSync('tar -xzf "' + archive + '" -C "' + dest + '"', { stdio: 'inherit' });
  else throw new Error('不支持的压缩格式: ' + archive);
}

function installedMarker(platform) {
  return path.join(RUNTIME_DIR, platform, '.installed.json');
}

function isUpToDate(platform) {
  try {
    const marker = JSON.parse(fs.readFileSync(installedMarker(platform), 'utf-8'));
    return marker.node === NODE_VERSION;
  } catch { return false; }
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const platform = currentPlatform();
  if (isUpToDate(platform)) {
    console.log('[runtime] ' + platform + ' 已是最新（node ' + NODE_VERSION + '），跳过');
    return;
  }
  console.log('[runtime] 准备 ' + platform + ' 运行时（node ' + NODE_VERSION + '）...');
  const tmpDir = path.join(RUNTIME_DIR, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const binDir = path.join(RUNTIME_DIR, platform, 'bin');
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });

  const asset = nodeAsset(platform);
  const archive = path.join(tmpDir, asset);
  download(nodeUrls(asset), archive);

  const extractDir = path.join(tmpDir, 'node');
  extract(archive, extractDir);
  // node 解压后是 node-vX.Y.Z-<platform>/ 子目录
  const inner = fs.readdirSync(extractDir).map((n) => path.join(extractDir, n)).find((p) => fs.statSync(p).isDirectory());
  copyDir(inner || extractDir, binDir);

  fs.writeFileSync(installedMarker(platform), JSON.stringify({
    node: NODE_VERSION, installedAt: new Date().toISOString(),
  }, null, 2));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('[runtime] 完成 → ' + binDir);
  console.log('[runtime] 内容: ' + fs.readdirSync(binDir).slice(0, 12).join(', '));
}

main();
