'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toVersionCode, buildGradleProps, mergeGradleProps } = require('../../scripts/sync-android-version');

test('toVersionCode: 0.6.206 -> 6206', () => {
  assert.strictEqual(toVersionCode('0.6.206'), 6206);
});

test('toVersionCode: 0.6.25 -> 6025', () => {
  assert.strictEqual(toVersionCode('0.6.25'), 6025);
});

test('toVersionCode: 忽略预发布后缀', () => {
  assert.strictEqual(toVersionCode('0.6.206-beta'), 6206);
  assert.strictEqual(toVersionCode('1.0.0-rc.1'), 10000);
});

test('toVersionCode: 非法输入返回 1', () => {
  assert.strictEqual(toVersionCode(''), 1);
  assert.strictEqual(toVersionCode(null), 1);
  assert.strictEqual(toVersionCode('1.2'), 1);
});

test('toVersionCode: 单调递增', () => {
  assert.ok(toVersionCode('0.6.207') > toVersionCode('0.6.206'));
  assert.ok(toVersionCode('0.7.0') > toVersionCode('0.6.999'));
});

test('buildGradleProps: 包含 versionCode 和 versionName', () => {
  const out = buildGradleProps({ version: '0.6.206' });
  assert.ok(out.includes('lingyaVersionCode=6206'));
  assert.ok(out.includes('lingyaVersionName=0.6.206'));
});

test('mergeGradleProps: 保留其他配置，替换版本行', () => {
  const existing = 'org.gradle.jvmargs=-Xmx2048m\nlingyaVersionCode=1\nlingyaVersionName=1.0\n';
  const generated = buildGradleProps({ version: '0.6.206' });
  const out = mergeGradleProps(existing, generated);
  assert.ok(out.includes('org.gradle.jvmargs=-Xmx2048m'));
  assert.ok(out.includes('lingyaVersionCode=6206'));
  assert.ok(!out.includes('lingyaVersionCode=1\n'));
});

test('mergeGradleProps: 空入参不崩', () => {
  const out = mergeGradleProps('', buildGradleProps({ version: '1.0.0' }));
  assert.ok(out.includes('lingyaVersionCode=10000'));
});
