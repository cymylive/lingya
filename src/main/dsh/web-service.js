/**
 * DSH 兼容层 - ctx.web 服务（CommonJS）
 *
 * 实现 dsh-tool-web 依赖的 ctx.web.search / ctx.web.fetch：
 *   fetch({ url })                  → { url, statusCode, body: { kind, content }, truncated }
 *   search({ query, maxResults })   → { content?, sources: [], truncated }
 *
 * 复用 LingYa 的抓取/搜索能力（fetch + turndown；Exa/Bing 搜索）。
 */
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');

const FETCH_TIMEOUT_MS = 15000;
const MAX_CHARS = 20000;

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.use(gfm);
turndown.remove(['script', 'style', 'noscript']);

/**
 * ctx.web.fetch：抓取 URL，返回结构化结果。
 * dsh-tool-web 会用 body.kind（html/text）+ body.content 自己渲染。
 */
async function webFetch(args, signal) {
  const url = String((args && args.url) || '').trim();
  if (!url) throw new Error('web.fetch: url is required');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('web.fetch: only http/https');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // 外部 signal 也接（可选）
  if (signal && typeof signal.addEventListener === 'function') {
    try { signal.addEventListener('abort', () => controller.abort()); } catch (_) {}
  }
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const ab = await resp.arrayBuffer();
    let content = Buffer.from(ab).toString('utf8');
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const kind = (ct.includes('text/html') || ct.includes('application/xhtml')) ? 'html' : 'text';
    let truncated = false;
    if (content.length > MAX_CHARS) { content = content.slice(0, MAX_CHARS); truncated = true; }
    return { url: resp.url || url, statusCode: resp.status, body: { kind, content }, truncated };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ctx.web.search：复用 LingYa 的 Exa/Bing 搜索，返回结构化结果。
 * 注：LingYa 的搜索返回的是格式化文本（非结构化 sources），这里放进 content 字段。
 */
async function webSearch(args, signal) {
  const query = String((args && args.query) || '').trim();
  if (!query) throw new Error('web.search: query is required');
  const maxResults = Number.isFinite(args && args.maxResults) ? Math.max(1, Math.min(10, Math.floor(args.maxResults))) : 5;

  // 优先 Exa（复用 tools/WebSearchTool 的实现）
  try {
    const { exaSearch } = require('../../../tools/WebSearchTool');
    const text = await exaSearch(query, maxResults);
    return { content: text, sources: [], truncated: false };
  } catch (err) {
    console.warn('[DSH] ctx.web.search Exa 失败:', err.message);
  }
  // 降级：调 LingYa WebSearchTool 的完整实现（Exa+Bing）
  try {
    const { WebSearchTool } = require('../../../tools/WebSearchTool');
    const out = await new WebSearchTool().execute({ query, topK: maxResults });
    const text = (out && out.data) ? String(out.data) : '';
    return { content: text, sources: [], truncated: false };
  } catch (err) {
    console.warn('[DSH] ctx.web.search 降级失败:', err.message);
    return { content: '', sources: [], truncated: false };
  }
}

module.exports = { webFetch, webSearch };
