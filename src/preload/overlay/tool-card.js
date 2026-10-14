/**
 * 工具调用卡片（仿 DeepSeek Harness 的 ui-tool）
 *
 * 把 LingYa 的工具调用从纯文本条目升级为卡片：
 *   工具名 + 参数摘要 + 状态徽标 + 可折叠的输出。
 *
 * 设计原则：
 *  - 纯字符串拼接，不依赖框架
 *  - 所有用户/工具内容经 escapeHtml 转义，防注入
 *  - CSS 以字符串导出，由调用方注入 <style>
 *  - 不修改任何现有元素 id
 */
'use strict';

const TOOL_CARD_CSS = [
  ':root {',
  '  --lg-radius-sm: 8px;',
  '  --lg-radius-md: 12px;',
  '  --lg-radius-lg: 16px;',
  '  --lg-card-bg: rgba(255,255,255,0.03);',
  '  --lg-card-bg-hover: rgba(255,255,255,0.06);',
  '  --lg-card-border: rgba(255,255,255,0.08);',
  '  --lg-card-border-strong: rgba(255,255,255,0.14);',
  '  --lg-text-primary: rgba(255,255,255,0.92);',
  '  --lg-text-secondary: rgba(255,255,255,0.6);',
  '  --lg-text-tertiary: rgba(255,255,255,0.4);',
  '  --lg-status-success: #22c55e;',
  '  --lg-status-error: #ef4444;',
  '  --lg-status-running: #3b82f6;',
  '  --lg-status-pending: #a1a1aa;',
  "  --lg-mono: 'SF Mono','JetBrains Mono','Fira Code',Consolas,'Microsoft YaHei',monospace;",
  '}',
  '.lingya-tool-card {',
  '  margin: 6px 0;',
  '  border: 1px solid var(--lg-card-border);',
  '  border-radius: var(--lg-radius-md);',
  '  background: var(--lg-card-bg);',
  '  overflow: hidden;',
  '  font-size: 12px;',
  '  transition: border-color .15s ease, background .15s ease;',
  '}',
  '.lingya-tool-card:hover { background: var(--lg-card-bg-hover); border-color: var(--lg-card-border-strong); }',
  '.lingya-tool-card__head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; }',
  '.lingya-tool-card__icon { flex: 0 0 auto; color: var(--lg-text-tertiary); font-size: 10px; transition: transform .15s ease; }',
  '.lingya-tool-card[data-collapsed="false"] .lingya-tool-card__icon { transform: rotate(90deg); }',
  '.lingya-tool-card__name { flex: 0 0 auto; font-family: var(--lg-mono); font-weight: 600; color: var(--lg-text-primary); }',
  '.lingya-tool-card__summary { flex: 1 1 auto; min-width: 0; font-family: var(--lg-mono); color: var(--lg-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.lingya-tool-card__badge { flex: 0 0 auto; padding: 1px 7px; border-radius: var(--lg-radius-sm); font-size: 11px; line-height: 16px; background: rgba(255,255,255,0.06); color: var(--lg-text-secondary); }',
  '.lingya-tool-card[data-status="success"] .lingya-tool-card__badge { color: var(--lg-status-success); background: rgba(34,197,94,.12); }',
  '.lingya-tool-card[data-status="error"] .lingya-tool-card__badge { color: var(--lg-status-error); background: rgba(239,68,68,.12); }',
  '.lingya-tool-card[data-status="running"] .lingya-tool-card__badge { color: var(--lg-status-running); background: rgba(59,130,246,.12); }',
  '.lingya-tool-card__body { border-top: 1px solid var(--lg-card-border); }',
  '.lingya-tool-card[data-collapsed="true"] .lingya-tool-card__body { display: none; }',
  '.lingya-tool-card__section { padding: 8px 10px; }',
  '.lingya-tool-card__section + .lingya-tool-card__section { border-top: 1px solid var(--lg-card-border); }',
  '.lingya-tool-card__label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--lg-text-tertiary); margin-bottom: 4px; }',
  '.lingya-tool-card__pre { margin: 0; font-family: var(--lg-mono); font-size: 11.5px; line-height: 1.5; color: var(--lg-text-primary); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }',
  '.lingya-tool-card[data-status="error"] .lingya-tool-card__pre--output { color: #fca5a5; }',
  ''
].join('\n');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizeArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args.replace(/\s+/g, ' ').trim().slice(0, 80);
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  } catch (_) {
    return String(args).slice(0, 80);
  }
}

function formatOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output, null, 2); } catch (_) { return String(output); }
}

const STATUS_LABEL = {
  pending: '待执行',
  running: '执行中',
  success: '成功',
  error: '失败',
};

function renderToolCard(opts) {
  const o = opts || {};
  const name = escapeHtml(o.name || 'tool');
  const status = STATUS_LABEL[o.status] ? o.status : 'pending';
  const label = STATUS_LABEL[status];
  const summary = escapeHtml(summarizeArgs(o.args));
  const collapsed = o.collapsed === true;
  const output = formatOutput(o.output);
  const argsText = (typeof o.args === 'string') ? o.args : (function () {
    try { return JSON.stringify(o.args, null, 2); } catch (_) { return String(o.args == null ? '' : o.args); }
  })();

  const parts = [];
  parts.push('<div class="lingya-tool-card" data-status="' + status + '" data-collapsed="' + collapsed + '">');
  parts.push('  <div class="lingya-tool-card__head" role="button" tabindex="0" aria-expanded="' + (!collapsed) + '">');
  parts.push('    <span class="lingya-tool-card__icon" aria-hidden="true">&#9654;</span>');
  parts.push('    <span class="lingya-tool-card__name">' + name + '</span>');
  if (summary) parts.push('    <span class="lingya-tool-card__summary">' + summary + '</span>');
  parts.push('    <span class="lingya-tool-card__badge">' + escapeHtml(label) + '</span>');
  parts.push('  </div>');
  parts.push('  <div class="lingya-tool-card__body">');
  if (argsText) {
    parts.push('    <div class="lingya-tool-card__section">');
    parts.push('      <div class="lingya-tool-card__label">参数</div>');
    parts.push('      <pre class="lingya-tool-card__pre">' + escapeHtml(argsText) + '</pre>');
    parts.push('    </div>');
  }
  if (output) {
    parts.push('    <div class="lingya-tool-card__section">');
    parts.push('      <div class="lingya-tool-card__label">输出</div>');
    parts.push('      <pre class="lingya-tool-card__pre lingya-tool-card__pre--output">' + escapeHtml(output) + '</pre>');
    parts.push('    </div>');
  }
  parts.push('  </div>');
  parts.push('</div>');
  return parts.join('\n');
}

function injectToolCardCSS(doc) {
  if (!doc || !doc.head) return null;
  const EXISTING_ID = 'lingya-tool-card-style';
  const found = doc.getElementById ? doc.getElementById(EXISTING_ID) : null;
  if (found) return found;
  const style = doc.createElement('style');
  style.id = EXISTING_ID;
  style.textContent = TOOL_CARD_CSS;
  doc.head.appendChild(style);
  return style;
}

module.exports = { TOOL_CARD_CSS, renderToolCard, escapeHtml, summarizeArgs, formatOutput, injectToolCardCSS };
