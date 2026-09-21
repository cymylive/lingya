'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { OVERLAY_HTML, OVERLAY_CSS } = require('../../src/preload/overlay/template');

test('OVERLAY_HTML 包含核心元素', () => {
  assert.ok(OVERLAY_HTML.includes('lingya-overlay'));
  assert.ok(OVERLAY_HTML.includes('lingya-btn-init'));
  assert.ok(OVERLAY_HTML.includes('lingya-session-list'));
  assert.ok(OVERLAY_HTML.includes('lingya-btn-manual-parse'));
  assert.ok(OVERLAY_HTML.includes('lingya-status-badge'));
});

test('OVERLAY_CSS 包含核心样式', () => {
  assert.ok(OVERLAY_CSS.includes('.lingya-overlay'));
  assert.ok(OVERLAY_CSS.includes('--ck-primary'));
  assert.ok(OVERLAY_CSS.includes('lingya-hidden'));
});
