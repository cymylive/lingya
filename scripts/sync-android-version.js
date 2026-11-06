#!/usr/bin/env node
/**
 * 从 package.json 读取版本，注入到 android/gradle.properties
 * 供 build.gradle 用 project.property('lingyaVersionCode') 读取。
 *
 * 版本转换规则：0.6.206 -> versionCode 6206（major*10000 + minor*100 + patch）
 *               0.6.206-beta -> 同上（忽略预发布后缀）
 *
 * 用法：node scripts/sync-android-version.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const GRADLE_PROPS = path.join(ROOT, 'android', 'gradle.properties');

/**
 * 语义化版本 -> Android versionCode
 * 规则：major*10000 + minor*1000 + patch（minor 限 0-9，patch 限 0-999）
 * 参考 Cuckoo：0.10.173 -> 10173
 * @param {string} version 形如 "0.6.206" 或 "0.6.206-beta"
 * @returns {number}
 */
function toVersionCode(version) {
  if (!version || typeof version !== 'string') return 1;
  const core = version.split('-')[0];
  const parts = core.split('.');
  if (parts.length < 3) return 1;
  const major = parseInt(parts[0], 10) || 0;
  const minor = parseInt(parts[1], 10) || 0;
  const patch = parseInt(parts[2], 10) || 0;
  const m = Math.min(Math.max(major, 0), 99);
  const n = Math.min(Math.max(minor, 0), 9);
  const p = Math.min(Math.max(patch, 0), 999);
  return m * 10000 + n * 1000 + p;
}

/**
 * 生成 gradle.properties 中要写入的行
 * @param {{version:string}} pkg package.json 对象
 * @returns {string}
 */
function buildGradleProps(pkg) {
  const version = (pkg && pkg.version) || '1.0.0';
  const code = toVersionCode(version);
  return [
    '# 由 scripts/sync-android-version.js 自动生成，请勿手改',
    'lingyaVersionCode=' + code,
    'lingyaVersionName=' + version,
  ].join('\n') + '\n';
}

/**
 * 把版本信息合并进现有 gradle.properties（保留其它配置）
 * @param {string} existing 现有内容
 * @param {string} generated 生成的内容
 * @returns {string}
 */
function mergeGradleProps(existing, generated) {
  const lines = String(existing || '').split(/\r?\n/);
  const keep = lines.filter((l) => !/^lingyaVersion(Code|Name)=/.test(l));
  // 去掉尾部空行
  while (keep.length && keep[keep.length - 1] === '') keep.pop();
  return keep.join('\n') + '\n' + generated;
}

function main() {
  if (!fs.existsSync(PKG)) {
    console.error('[sync-android-version] package.json 不存在');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const generated = buildGradleProps(pkg);
  let existing = '';
  if (fs.existsSync(GRADLE_PROPS)) {
    existing = fs.readFileSync(GRADLE_PROPS, 'utf8');
  } else {
    console.error('[sync-android-version] android/gradle.properties 不存在，跳过写入');
    console.log(generated.trim());
    return;
  }
  const next = mergeGradleProps(existing, generated);
  fs.writeFileSync(GRADLE_PROPS, next, 'utf8');
  console.log('[sync-android-version] 已写入: versionCode=' + toVersionCode(pkg.version) + ', versionName=' + pkg.version);
}

if (require.main === module) {
  main();
}

module.exports = { toVersionCode, buildGradleProps, mergeGradleProps };
