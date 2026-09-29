#!/usr/bin/env node
/**
 * apply-native.js —— 在 `npx cap add android` 之后，把预置的原生代码装配进生成工程。
 *
 * 做四件事：
 *   1. 复制 native-src/java/** 到 android/app/src/main/java/**
 *   2. 覆盖 MainActivity.java（注册 LingyaFsPlugin）
 *   3. 给 android/app/build.gradle 补 documentfile 依赖
 *   4. 给 AndroidManifest.xml 补存储权限（可选，默认跳过）
 *
 * 用法：node scripts/apply-native.js [androidDir]
 *   默认 androidDir = ./android
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_SRC = path.join(ROOT, 'native-src');
const ANDROID_DIR = path.resolve(ROOT, process.argv[2] || 'android');

const PKG_PATH = 'app/src/main/java/com/lingya/app';

function log(msg) { console.log('[apply-native] ' + msg); }
function fail(msg) { console.error('[apply-native] ✗ ' + msg); process.exit(1); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  log('复制 ' + path.relative(ROOT, to));
}

// ---------- 前置校验 ----------
if (!fs.existsSync(ANDROID_DIR)) {
  fail('找不到 ' + ANDROID_DIR + '，请先执行 npx cap add android');
}
if (!fs.existsSync(NATIVE_SRC)) {
  fail('找不到 native-src 目录');
}

// ---------- 1. 复制 Java 源码 ----------
const javaSrcDir = path.join(NATIVE_SRC, 'java', 'com', 'lingya', 'app');
if (!fs.existsSync(javaSrcDir)) fail('native-src/java/com/lingya/app 不存在');
for (const f of fs.readdirSync(javaSrcDir)) {
  if (f.endsWith('.java')) {
    copyFile(path.join(javaSrcDir, f), path.join(ANDROID_DIR, PKG_PATH, f));
  }
}

// ---------- 2. build.gradle 补依赖 ----------
const gradlePath = path.join(ANDROID_DIR, 'app', 'build.gradle');
if (!fs.existsSync(gradlePath)) fail('找不到 app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!gradle.includes('androidx.documentfile')) {
  // 在 dependencies { ... } 块内插入
  const depRe = /dependencies\s*\{/;
  if (depRe.test(gradle)) {
    gradle = gradle.replace(depRe, (m) => m + "\n    implementation \"androidx.documentfile:documentfile:1.0.1\"");
    fs.writeFileSync(gradlePath, gradle, 'utf8');
    log('已补 documentfile 依赖');
  } else {
    log('⚠ 未找到 dependencies 块，请手动加 documentfile');
  }
} else {
  log('documentfile 依赖已存在，跳过');
}

// ---------- 3. AndroidManifest 权限（可选） ----------
if (process.env.LINGYA_ADD_STORAGE_PERMISSIONS === '1') {
  const manifestPath = path.join(ANDROID_DIR, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    let mf = fs.readFileSync(manifestPath, 'utf8');
    const perms = [
      '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
      '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
    ].join('\n    ');
    if (!mf.includes('READ_EXTERNAL_STORAGE')) {
      mf = mf.replace(/<manifest([^>]*)>/, '<manifest$1>\n    ' + perms);
      fs.writeFileSync(manifestPath, mf, 'utf8');
      log('已补存储权限（旧 API 兼容，API 33+ 走 SAF）');
    }
  }
}

// ---------- 4. 校验 MainActivity 注册了插件 ----------
const actPath = path.join(ANDROID_DIR, PKG_PATH, 'MainActivity.java');
const act = fs.readFileSync(actPath, 'utf8');
if (!act.includes('registerPlugin(LingyaFsPlugin.class)')) {
  fail('MainActivity 未注册 LingyaFsPlugin，请检查 native-src');
}
log('MainActivity 已注册插件 ✓');

log('装配完成 ✓');
