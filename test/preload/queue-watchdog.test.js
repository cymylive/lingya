'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 方案 C：处理队列阻塞可见化。
 *
 * 背景：processingChain 是串行队列，一次 10 分钟的 bashOutput 会堵死整个窗口。
 * 阻塞期间完全静默 —— 用户看到的是「AI 输出了代码块但完全没反应」，
 * 开发者也无从得知是队列堵了还是 hook 挂了。
 *
 * 修复：记录入队时刻，实际开始执行时若等待超过阈值就打印明确警告。
 */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'preload', 'dom', 'intercept-observer.js'),
  'utf8'
);

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

test('必须有队列等待阈值常量', () => {
  assert.match(
    CODE,
    /QUEUE_WAIT_WARN_MS\s*=/,
    '必须有 QUEUE_WAIT_WARN_MS 常量，定义多久算「堵太久」'
  );
});

test('enqueueProcessing 必须记录入队时刻', () => {
  const idx = CODE.indexOf('function enqueueProcessing');
  assert.ok(idx >= 0, '必须有 enqueueProcessing');
  const seg = CODE.slice(idx, idx + 1200);
  assert.match(seg, /enqueuedAt|enqueueAt|queueStartAt/, '必须记录入队时刻');
  assert.match(seg, /Date\.now\(\)/, '必须用 Date.now() 取时间');
});

test('开始执行时必须检查等待时长并告警', () => {
  const idx = CODE.indexOf('function enqueueProcessing');
  const seg = CODE.slice(idx, idx + 1500);
  assert.match(
    seg,
    /wait|waited|elapsed/i,
    '必须计算实际等待时长'
  );
  assert.match(
    seg,
    /console\.warn/,
    '超阈值必须 console.warn 告警 —— 阻塞必须可见，不能静默'
  );
});

test('告警文案必须说明「队列阻塞」及影响', () => {
  const idx = CODE.indexOf('QUEUE_WAIT_WARN_MS');
  assert.ok(idx >= 0);
  // 找 console.warn 附近的文案
  const warnIdx = CODE.indexOf('console.warn', idx);
  assert.ok(warnIdx >= 0, 'QUEUE_WAIT_WARN_MS 之后必须有 console.warn');
  const seg = CODE.slice(warnIdx, warnIdx + 400);
  assert.match(
    seg,
    /队列|阻塞|排队/,
    '告警文案必须明确说是队列阻塞问题，便于用户/开发者定位'
  );
});

test('默认阈值应为 3 分钟（合理范围 60s-600s）', () => {
  const m = CODE.match(/QUEUE_WAIT_WARN_MS\s*=\s*(\d+)/);
  assert.ok(m, 'QUEUE_WAIT_WARN_MS 必须是数字字面量');
  const val = Number(m[1]);
  assert.ok(
    val >= 60000 && val <= 600000,
    '阈值应在 1-10 分钟之间，实际 ' + val + 'ms'
  );
});
