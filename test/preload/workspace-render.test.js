const { test } = require('node:test');
const assert = require('node:assert');
const { renderSessionItemHtml } = require('../../src/preload/shell-renderer-helpers');

test('同窗口会话不显示窗口徽标', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's1', title: '会话A', profileId: 'p1', profileName: '窗口1' },
    { currentSessionId: '', currentProfileId: 'p1' }
  );
  assert.ok(!html.includes('ck-ws-badge'));
});

test('跨窗口会话显示窗口徽标', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's2', title: '会话B', profileId: 'p2', profileName: '窗口2' },
    { currentSessionId: '', currentProfileId: 'p1' }
  );
  assert.ok(html.includes('ck-ws-badge'));
  assert.ok(html.includes('窗口2'));
  assert.ok(html.includes('data-profile-id="p2"'));
  assert.ok(html.includes('other-win'));
});

test('当前会话项带 current 类', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's1', title: 'A', profileId: 'p1' },
    { currentSessionId: 's1', currentProfileId: 'p1' }
  );
  assert.ok(html.includes('ck-ws-item current'));
});

test('标题中的 HTML 被转义', () => {
  const html = renderSessionItemHtml(
    { sessionId: 's1', title: '<script>x</script>', profileId: 'p1' },
    { currentProfileId: 'p1' }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
